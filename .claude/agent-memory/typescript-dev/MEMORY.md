# TypeScript Dev Agent Memory

## Project: Freely (Tauri + React + TypeScript)

### Key Architecture
- Freely is a Tauri v2 app (Rust backend + React WebView frontend)
- No Node.js runtime in the WebView — browser-compatible code only
- Storage: localStorage for all persistence (no database)
- Bundler: Vite + TypeScript strict mode

### Freely Agents Integration (Tasks #1-3 completed)

**Files created in `freely/src/lib/agents/`:**
- `types.ts` — Branded ID types (MessageID, SessionID, TaskID), Message interface, StreamingCallbacks, ToolCapabilities, all standalone (no @agor/core deps)
- `storage-adapter.ts` — localStorage-based MessagesService, TasksService, SessionsService, MessagesRepository, SessionsRepository + `createStorageAdapter()` factory
- `claude/freely-claude-tool.ts` — Claude adapter (uses `claude login` OAuth via Tauri invoke)
- `codex/freely-codex-tool.ts` — Codex adapter (reads OPENAI_API_KEY from localStorage)
- `gemini/freely-gemini-tool.ts` — Gemini adapter (reads GOOGLE_API_KEY from localStorage)
- `orchestrator.ts` — FreelyAgentOrchestrator, keeps existing `AsyncIterable<string>` interface
- `index.ts` — Barrel exports

**Pattern:** Orchestrator has `AgentExecuteParams` → `AsyncIterable<string>` interface matching `fetchAIResponse`. Each tool adapter bridges to a Tauri `invoke()` call to the Rust sidecar.

**Tauri integration pending:** The Rust sidecar commands `run_claude`, `run_codex`, `run_gemini`, `check_tool_installed` must be implemented in the Rust backend. The TypeScript adapters are ready.

### Conventions
- extracted-from-agor files cannot be imported directly (use @agor/core which isn't installed)
- Always import ToolCapabilities etc. from local types.ts, not from extracted-from-agor/base/types.js
- TypeScript TS6138 (declared but never read) must be fixed with constructor param naming (_param) not eslint comments
- STORAGE_KEYS pattern: `freely_agents_messages_{sessionId}`, `freely_agents_session_{sessionId}`, `freely_agents_task_{taskId}`
