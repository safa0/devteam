//! Agent sidecar commands for Freely.
//!
//! Spawns CLI tools (claude, codex, gemini) as child processes and streams
//! their output back to the frontend via Tauri events + collected return value.
//!
//! Each `run_*` command:
//! 1. Resolves the CLI binary on $PATH
//! 2. Spawns the process with the prompt piped via stdin (or -p flag)
//! 3. Reads stdout line-by-line, emitting `agent:stream:{session_id}` events
//! 4. Returns a collected Vec<StreamEvent> when the process exits

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::warn;

// ============================================================================
// Process registry — tracks live agent child PIDs by session ID
// ============================================================================

/// Shared state: session_id → child process PID.
/// Allows the frontend to cancel in-flight agent runs via `kill_agent_process`.
#[derive(Default, Clone)]
pub struct AgentProcessRegistry(pub Arc<Mutex<HashMap<String, u32>>>);

/// Kill an in-flight agent process for the given session.
/// If no process is registered (already finished or never started), this is a no-op.
///
/// # Security note
/// `registry.remove()` returns `None` when the session_id is unknown, causing an
/// early return with no kill. This is safe: the registry only ever holds PIDs that
/// *we* inserted when spawning a child process, so there is no risk of killing an
/// arbitrary PID supplied by the frontend.
///
/// # Race condition (v1 known limitation)
/// If `kill_agent_process` fires before `run_cli_process` has had a chance to
/// register the PID (i.e. between spawn and the `map.insert` call), the remove
/// returns `None` and the kill is a no-op. The process will continue to run until
/// it finishes naturally. This window is extremely small and acceptable for v1.
#[tauri::command]
pub async fn kill_agent_process(
    registry: tauri::State<'_, AgentProcessRegistry>,
    session_id: String,
) -> Result<(), String> {
    let pid = registry
        .0
        .lock()
        .map_err(|e| format!("Registry lock poisoned: {e}"))?
        .remove(&session_id);

    if let Some(pid) = pid {
        kill_pid(pid).await;
    }
    Ok(())
}

/// Send SIGTERM (Unix) or taskkill (Windows) to the given PID.
///
/// Uses `tokio::task::spawn_blocking` to avoid blocking the async executor with
/// a synchronous `std::process::Command::status()` call.
#[cfg(unix)]
async fn kill_pid(pid: u32) {
    // SIGTERM for graceful shutdown; the process group is not targeted since
    // CLI tools like `claude` may manage their own child processes.
    let _ = tokio::task::spawn_blocking(move || {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    })
    .await;
}

#[cfg(windows)]
async fn kill_pid(pid: u32) {
    let _ = tokio::task::spawn_blocking(move || {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .status();
    })
    .await;
}

// ============================================================================
// Shared types
// ============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StreamEvent {
    #[serde(rename = "type")]
    pub event_type: String, // "partial" | "complete" | "error" | "stopped"
    #[serde(rename = "textChunk", skip_serializing_if = "Option::is_none")]
    pub text_chunk: Option<String>,
    #[serde(rename = "resolvedModel", skip_serializing_if = "Option::is_none")]
    pub resolved_model: Option<String>,
    #[serde(rename = "agentSessionId", skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(rename = "tokenUsage", skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<TokenUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Deserialize)]
pub struct AgentPayload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub prompt: String,
    #[serde(rename = "taskId")]
    pub task_id: Option<String>,
    #[serde(rename = "permissionMode")]
    pub permission_mode: Option<String>,
    #[serde(rename = "workingDirectory")]
    pub working_directory: Option<String>,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    pub model: Option<String>,
    /// Claude CLI session ID for `--resume` continuity.
    /// When set, the CLI resumes the existing conversation instead of starting fresh.
    #[serde(rename = "agentSessionId")]
    pub agent_session_id: Option<String>,
}

// ============================================================================
// Tool installation check
// ============================================================================

#[derive(Debug, Serialize)]
pub struct ToolInstalledResult {
    pub installed: bool,
}

#[tauri::command]
pub async fn check_tool_installed(tool: String) -> Result<ToolInstalledResult, String> {
    let binary = match tool.as_str() {
        "claude" => "claude",
        "codex" => "codex",
        "gemini" => "gemini",
        other => return Err(format!("Unknown tool: {}", other)),
    };

    let installed = which_exists(binary).await;
    Ok(ToolInstalledResult { installed })
}

/// Check if a binary exists on $PATH using `which` (unix) or `where` (windows).
async fn which_exists(binary: &str) -> bool {
    #[cfg(target_os = "windows")]
    let check_cmd = "where";
    #[cfg(not(target_os = "windows"))]
    let check_cmd = "which";

    Command::new(check_cmd)
        .arg(binary)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Try common install locations when `which` fails (macOS GUI apps don't inherit shell PATH).
#[cfg(not(target_os = "windows"))]
fn find_binary_in_common_paths(binary: &str) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{}/.local/bin/{}", home, binary),
        format!("{}/.npm-global/bin/{}", home, binary),
        format!("/usr/local/bin/{}", binary),
        format!("/opt/homebrew/bin/{}", binary),
    ];
    candidates
        .into_iter()
        .find(|path| std::path::Path::new(path).exists())
}

// ============================================================================
// Claude authentication check
// ============================================================================

#[derive(Debug, Serialize)]
pub struct AuthResult {
    pub installed: bool,
    pub authenticated: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn check_claude_authenticated() -> Result<AuthResult, String> {
    let binary = match resolve_binary("claude").await {
        Ok(b) => b,
        Err(_) => {
            return Ok(AuthResult {
                installed: false,
                authenticated: false,
                version: None,
                error: None,
            });
        }
    };

    // Step 1: Get version to confirm installation works
    let version_output = Command::new(&binary)
        .arg("--version")
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;

    let version = match version_output {
        Ok(out) if out.status.success() => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if v.is_empty() { None } else { Some(v) }
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Ok(AuthResult {
                installed: true,
                authenticated: false,
                version: None,
                error: if stderr.is_empty() { None } else { Some(stderr) },
            });
        }
        Err(e) => {
            return Ok(AuthResult {
                installed: true,
                authenticated: false,
                version: None,
                error: Some(e.to_string()),
            });
        }
    };

    // Step 2: Check authentication via `claude auth status`.
    // Returns JSON with {"loggedIn": true/false} — no API call needed.
    // `claude --version` always succeeds regardless of auth state, so we
    // need this separate check to verify the user is actually logged in.
    let auth_output = Command::new(&binary)
        .arg("auth")
        .arg("status")
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;

    let authenticated = match auth_output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            // Parse the JSON to check loggedIn field
            serde_json::from_str::<serde_json::Value>(&stdout)
                .ok()
                .and_then(|v| v.get("loggedIn")?.as_bool())
                .unwrap_or(false)
        }
        _ => false,
    };

    Ok(AuthResult {
        installed: true,
        authenticated,
        version,
        error: if !authenticated {
            Some("Claude CLI is installed but not authenticated. Run `claude login` in a terminal.".to_string())
        } else {
            None
        },
    })
}

// ============================================================================
// Open terminal for login
// ============================================================================

#[tauri::command]
pub async fn open_terminal_for_login() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators
        let terminals = ["x-terminal-emulator", "gnome-terminal", "xterm"];
        for term in &terminals {
            if Command::new(term).spawn().is_ok() {
                return Ok(());
            }
        }
        Err("Could not find a terminal emulator".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .arg("/c")
            .arg("start")
            .arg("cmd")
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
        Ok(())
    }
}

// ============================================================================
// .env file loading
// ============================================================================

/// Load environment variables from a `.env` file in the app's config directory.
/// Returns a HashMap of key-value pairs. Missing file is not an error (returns empty map).
///
/// Search order:
/// 1. CWD (for development: `freely/.env`)
/// 2. Platform config dir: `~/.config/freely/.env` (Linux/macOS) or `%APPDATA%/freely/.env` (Windows)
#[tauri::command]
pub async fn load_env_file() -> Result<HashMap<String, String>, String> {
    let mut vars = HashMap::new();

    // Candidate paths
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    // 1. CWD/.env (developer convenience)
    candidates.push(std::path::PathBuf::from(".env"));
    // Also check parent dir (Tauri CWD is src-tauri/, .env lives in project root)
    candidates.push(std::path::PathBuf::from("../.env"));

    // 2. Platform config dir
    if let Some(home) = std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok()) {
        #[cfg(target_os = "windows")]
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(std::path::PathBuf::from(format!("{}/freely/.env", appdata)));
        }
        #[cfg(not(target_os = "windows"))]
        {
            candidates.push(std::path::PathBuf::from(format!("{}/.config/freely/.env", home)));
        }
    }

    // Find first existing file and parse it
    for path in candidates {
        if path.exists() {
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

            for line in content.lines() {
                let trimmed = line.trim();
                // Skip empty lines and comments
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                // Parse KEY=VALUE (with optional quotes)
                if let Some((key, value)) = trimmed.split_once('=') {
                    let key = key.trim().to_string();
                    let raw = value.trim();
                    // Strip surrounding quotes safely (handles edge cases like KEY=")
                    let value = raw
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                        .or_else(|| {
                            raw.strip_prefix('\'').and_then(|v| v.strip_suffix('\''))
                        })
                        .unwrap_or(raw)
                        .to_string();
                    vars.insert(key, value);
                }
            }
            break; // Use only the first file found
        }
    }

    Ok(vars)
}

// ============================================================================
// Run Claude CLI
// ============================================================================

#[tauri::command]
pub async fn run_claude(
    app: AppHandle,
    payload: AgentPayload,
    registry: tauri::State<'_, AgentProcessRegistry>,
) -> Result<Vec<StreamEvent>, String> {
    let binary = resolve_binary("claude").await?;

    let mut cmd = Command::new(&binary);
    // Clear env vars that cause "nested session" detection when Freely
    // itself was launched from inside a Claude Code terminal.
    cmd.env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT");

    // Claude CLI: `claude -p "prompt"` for non-interactive
    cmd.arg("-p")
        .arg(&payload.prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose");

    // Resume an existing Claude session for conversation continuity.
    // The CLI maintains full conversation state — no history prepending needed.
    if let Some(ref agent_sid) = payload.agent_session_id {
        cmd.arg("--resume").arg(agent_sid);
    }

    if let Some(ref model) = payload.model {
        cmd.arg("--model").arg(model);
    }

    if let Some(ref perm) = payload.permission_mode {
        cmd.arg("--allowedTools").arg(perm);
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    run_cli_process(app, cmd, &payload.session_id, &registry).await
}

// ============================================================================
// Run Codex CLI
// ============================================================================

#[tauri::command]
pub async fn run_codex(
    app: AppHandle,
    payload: AgentPayload,
    registry: tauri::State<'_, AgentProcessRegistry>,
) -> Result<Vec<StreamEvent>, String> {
    let binary = resolve_binary("codex").await?;

    let mut cmd = Command::new(&binary);
    cmd.arg("--quiet")
        .arg(&payload.prompt);

    // Codex requires OPENAI_API_KEY in environment
    if let Some(ref key) = payload.api_key {
        cmd.env("OPENAI_API_KEY", key);
    }

    if let Some(ref perm) = payload.permission_mode {
        cmd.arg("--approval-mode").arg(perm);
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    run_cli_process(app, cmd, &payload.session_id, &registry).await
}

// ============================================================================
// Run Gemini CLI
// ============================================================================

#[tauri::command]
pub async fn run_gemini(
    app: AppHandle,
    payload: AgentPayload,
    registry: tauri::State<'_, AgentProcessRegistry>,
) -> Result<Vec<StreamEvent>, String> {
    let binary = resolve_binary("gemini").await?;

    let mut cmd = Command::new(&binary);
    cmd.arg("-p")
        .arg(&payload.prompt);

    // Gemini may use GOOGLE_API_KEY or OAuth
    if let Some(ref key) = payload.api_key {
        cmd.env("GOOGLE_API_KEY", key);
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    run_cli_process(app, cmd, &payload.session_id, &registry).await
}

// ============================================================================
// Shared process runner
// ============================================================================

/// Resolve a binary name to its full path, or return an error if not found.
async fn resolve_binary(name: &str) -> Result<String, String> {
    if which_exists(name).await {
        return Ok(name.to_string());
    }

    // Fallback: check common install paths (macOS GUI apps don't inherit shell PATH)
    #[cfg(not(target_os = "windows"))]
    if let Some(path) = find_binary_in_common_paths(name) {
        return Ok(path);
    }

    Err(format!(
        "{} CLI is not installed or not on PATH. \
         Please install it first:\n\
         - claude: npm install -g @anthropic-ai/claude-code\n\
         - codex: npm install -g @openai/codex\n\
         - gemini: npm install -g @google/gemini-cli",
        name
    ))
}

/// Spawn a CLI process, stream stdout line-by-line to the frontend, and collect events.
async fn run_cli_process(
    app: AppHandle,
    mut cmd: Command,
    session_id: &str,
    registry: &AgentProcessRegistry,
) -> Result<Vec<StreamEvent>, String> {
    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn process: {}", e))?;

    // Register PID so the frontend can cancel via kill_agent_process
    if let Some(pid) = child.id() {
        if let Ok(mut map) = registry.0.lock() {
            if let Some(old_pid) = map.insert(session_id.to_string(), pid) {
                warn!(
                    "Session {} already had PID {} registered; replaced with PID {}",
                    session_id, old_pid, pid
                );
            }
        }
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    let event_name = format!("agent:stream:{}", session_id);
    let mut events: Vec<StreamEvent> = Vec::new();

    // Read stdout line by line
    let mut stdout_reader = BufReader::new(stdout).lines();
    let mut stderr_reader = BufReader::new(stderr).lines();

    // Collect stderr in background
    let stderr_handle = tokio::spawn(async move {
        let mut stderr_output = String::new();
        while let Ok(Some(line)) = stderr_reader.next_line().await {
            if !stderr_output.is_empty() {
                stderr_output.push('\n');
            }
            stderr_output.push_str(&line);
        }
        stderr_output
    });

    // Process stdout lines
    while let Ok(Some(line)) = stdout_reader.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Try to parse as JSON (structured output from CLIs)
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
            // Handle structured JSON events from CLIs that support them
            let event = parse_json_event(&json);
            if let Err(e) = app.emit(&event_name, &event) {
                warn!("Failed to emit agent stream event: {}", e);
            }
            events.push(event);
        } else {
            // Plain text output — treat as a partial text chunk
            let event = StreamEvent {
                event_type: "partial".to_string(),
                text_chunk: Some(line),
                resolved_model: None,
                agent_session_id: None,
                token_usage: None,
                error: None,
            };

            // Emit real-time event to frontend
            if let Err(e) = app.emit(&event_name, &event) {
                warn!("Failed to emit agent stream event: {}", e);
            }
            events.push(event);
        }
    }

    // Wait for process to exit
    let wait_result = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for process: {}", e));

    // Deregister PID before propagating any error — avoids a registry leak if
    // `wait()` returns an OS error (e.g. ECHILD). The process is gone either way.
    if let Ok(mut map) = registry.0.lock() {
        map.remove(session_id);
    }

    let status = wait_result?;

    // Collect stderr
    let stderr_output = stderr_handle
        .await
        .unwrap_or_else(|_| String::new());

    if !status.success() {
        let error_msg = if stderr_output.is_empty() {
            format!("Process exited with code {}", status.code().unwrap_or(-1))
        } else {
            stderr_output.clone()
        };

        let error_event = StreamEvent {
            event_type: "error".to_string(),
            text_chunk: None,
            resolved_model: None,
            agent_session_id: None,
            token_usage: None,
            error: Some(error_msg.clone()),
        };
        if let Err(e) = app.emit(&event_name, &error_event) {
            warn!("Failed to emit agent error event: {}", e);
        }
        events.push(error_event);

        // If we got NO partial events, return the error
        if events.iter().all(|e| e.event_type != "partial") {
            return Err(error_msg);
        }
    }

    // Add a completion event
    let complete_event = StreamEvent {
        event_type: "complete".to_string(),
        text_chunk: None,
        resolved_model: None,
        agent_session_id: None,
        token_usage: None,
        error: None,
    };
    if let Err(e) = app.emit(&event_name, &complete_event) {
        warn!("Failed to emit agent complete event: {}", e);
    }
    events.push(complete_event);

    Ok(events)
}

/// Parse a JSON value from CLI output into a StreamEvent.
fn parse_json_event(json: &serde_json::Value) -> StreamEvent {
    // Claude CLI stream-json format
    if let Some(event_type) = json.get("type").and_then(|t| t.as_str()) {
        match event_type {
            "assistant" | "text" | "content_block_delta" => {
                // Extract text from various Claude output formats
                let text = json
                    .get("content")
                    .and_then(|c| {
                        if let Some(arr) = c.as_array() {
                            arr.iter()
                                .find_map(|item| item.get("text").and_then(|t| t.as_str()))
                        } else {
                            c.as_str()
                        }
                    })
                    .or_else(|| json.get("delta").and_then(|d| d.get("text").and_then(|t| t.as_str())))
                    .or_else(|| json.get("text").and_then(|t| t.as_str()));

                StreamEvent {
                    event_type: "partial".to_string(),
                    text_chunk: text.map(String::from),
                    resolved_model: json.get("model").and_then(|m| m.as_str()).map(String::from),
                    agent_session_id: json
                        .get("session_id")
                        .and_then(|s| s.as_str())
                        .map(String::from),
                    token_usage: parse_token_usage(json),
                    error: None,
                }
            }
            "result" | "message_stop" => {
                let text = json
                    .get("result")
                    .and_then(|r| r.as_str())
                    .map(String::from);

                StreamEvent {
                    event_type: if text.is_some() { "partial" } else { "complete" }.to_string(),
                    text_chunk: text,
                    resolved_model: json.get("model").and_then(|m| m.as_str()).map(String::from),
                    agent_session_id: json
                        .get("session_id")
                        .and_then(|s| s.as_str())
                        .map(String::from),
                    token_usage: parse_token_usage(json),
                    error: None,
                }
            }
            "error" => StreamEvent {
                event_type: "error".to_string(),
                text_chunk: None,
                resolved_model: None,
                agent_session_id: None,
                token_usage: None,
                error: json
                    .get("error")
                    .and_then(|e| {
                        e.get("message")
                            .and_then(|m| m.as_str())
                            .or_else(|| e.as_str())
                    })
                    .map(String::from)
                    .or_else(|| Some("Unknown error".to_string())),
            },
            _ => {
                // Unknown structured type — pass through as partial if it has text
                let text = json.get("text").and_then(|t| t.as_str()).map(String::from);
                StreamEvent {
                    event_type: "partial".to_string(),
                    text_chunk: text,
                    resolved_model: None,
                    agent_session_id: None,
                    token_usage: None,
                    error: None,
                }
            }
        }
    } else {
        // No "type" field — try to extract text from common patterns
        let text = json
            .get("text")
            .or_else(|| json.get("content"))
            .or_else(|| json.get("message"))
            .or_else(|| json.get("result"))
            .and_then(|v| v.as_str())
            .map(String::from);

        StreamEvent {
            event_type: "partial".to_string(),
            text_chunk: text,
            resolved_model: json.get("model").and_then(|m| m.as_str()).map(String::from),
            agent_session_id: None,
            token_usage: parse_token_usage(json),
            error: None,
        }
    }
}

/// Extract token usage from a JSON value if present.
fn parse_token_usage(json: &serde_json::Value) -> Option<TokenUsage> {
    json.get("usage").and_then(|u| {
        let input = u
            .get("input_tokens")
            .and_then(|t| t.as_u64())
            .unwrap_or(0);
        let output = u
            .get("output_tokens")
            .and_then(|t| t.as_u64())
            .unwrap_or(0);
        if input > 0 || output > 0 {
            Some(TokenUsage {
                input_tokens: input,
                output_tokens: output,
            })
        } else {
            None
        }
    })
}
