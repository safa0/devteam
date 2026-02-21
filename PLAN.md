# Pluely + Agor Hybrid — Enhanced AI Meeting Assistant

## Revised Approach

**NOT a rewrite. Fork pluely, strip its server dependency, and graft Agor's multi-agent orchestration into it.**

Key changes from previous plan:
- **Fork pluely, don't rebuild** — keep all existing code, enhance incrementally
- **No paid tiers** — everything is 100% free
- **Remove pluely.com server dependency** — all API calls direct to providers
- **Adopt Agor's agent orchestration model** — multi-agent sessions with Claude Code, Codex, Gemini, OpenCode support

---

## What We're Combining

### From Pluely (keep as-is, enhance)
- Undetectable overlay window (`contentProtected`, `NSPanel`, transparent)
- System audio capture (macOS: Core Audio/cidre, Windows: WASAPI, Linux: PulseAudio)
- VAD (Voice Activity Detection) with noise gate, RMS/peak analysis
- Screenshot capture with selection area (xcap)
- Custom cursor modes (invisible/default/auto)
- Global hotkey system
- SQLite local storage
- Tauri v2 + React 19 + TypeScript frontend

### From Agor (adopt the patterns)
- **Multi-agent orchestration**: Support Claude Code, Codex, Gemini, OpenCode as "agentic tools"
- **Session management**: Sessions tied to agent instances with status tracking, genealogy (fork/spawn)
- **Permission model**: Per-agent permission modes (Claude: default/acceptEdits/bypassPermissions, Codex: ask/auto/allow-all, Gemini: default/autoEdit/yolo)
- **MCP integration**: Internal MCP endpoint for agent coordination
- **Executor pattern**: Base executor interface with tool-specific implementations
- **Config system**: YAML-based config with credentials management (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY)
- **Model registry**: Per-agent model catalogs with metadata

### Reference Repositories
- **Pluely**: https://github.com/iamsrikanthnani/pluely (cloned at `/tmp/pluely`)
- **Agor**: https://github.com/preset-io/agor (cloned at `/tmp/agor`)

---

## Phase 1: Fork & Strip Server Dependency

**Goal**: Fork pluely, remove all pluely.com API dependencies, make it work with direct provider calls only.

### Tasks
1. **Fork the pluely repo** into our project
2. **Remove server proxy code**:
   - `src-tauri/src/api.rs`: Remove `fetch_api_response_config()`, `get_app_endpoint()`, `get_api_access_key()`, all pluely.com API calls
   - `src/lib/functions/pluely.api.ts`: Remove `shouldUsePluelyAPI()` and all Pluely API mode logic
   - `src/lib/functions/ai-response.function.ts`: Remove `fetchPluelyAIResponse()`, keep only direct curl-based provider path
   - `src/lib/functions/stt.function.ts`: Remove `fetchPluelySTT()`, keep only direct curl-based STT path
3. **Remove license gating**:
   - `src-tauri/src/activate.rs`: Remove license activation/validation API calls
   - `src-tauri/src/shortcuts.rs`: Remove `LicenseState` checks from `start_move_window` and `update_shortcuts`
   - `src/contexts/app.context.tsx`: Remove `hasActiveLicense`, `getActiveLicenseStatus`, Pluely API state
   - `src/pages/dashboard/components/PluelyApiSetup.tsx`: Remove entirely
   - `src/components/GetLicense.tsx`: Remove entirely
4. **Remove telemetry**:
   - Remove `tauri-plugin-posthog` from Cargo.toml and lib.rs
   - Remove `tauri-plugin-machine-uid` usage
   - Remove `trackAppStart()`, `user_activity()`, `report_api_error()` functions
5. **Simplify the Rust chat endpoint**:
   - Rewrite `chat_stream_response` to accept provider config directly from frontend (URL, API key, model, headers) instead of fetching from pluely.com
   - Or: remove Rust-side chat entirely and do all provider calls from the TypeScript frontend (as the custom provider path already does)

### Files Modified
- `src-tauri/src/api.rs` → gutted or removed
- `src-tauri/src/activate.rs` → removed
- `src-tauri/src/lib.rs` → remove pluely API commands, posthog, machine-uid
- `src-tauri/Cargo.toml` → remove posthog, machine-uid deps
- `src/contexts/app.context.tsx` → simplify, remove license/pluely API state
- `src/lib/functions/ai-response.function.ts` → remove Pluely API path
- `src/lib/functions/stt.function.ts` → remove Pluely STT path
- `src/pages/dashboard/` → remove PluelyApiSetup
- `src/components/GetLicense.tsx` → removed

---

## Phase 2: Adopt Agor's Multi-Agent Model

**Goal**: Replace pluely's simple "provider + curl template" model with Agor's multi-agent orchestration.

### What Agor Does That We Want
Agor treats AI tools as **agentic tools** — full agent executors (Claude Code, Codex, Gemini) rather than simple chat API endpoints. Each has:
- Its own SDK/CLI
- Its own permission model
- Its own model catalog
- Session state management
- Tool execution capabilities (Bash, Read, Write, etc.)

### How We Adapt This for Pluely's Context
In pluely, the AI assists the user during meetings/interviews. We want the user to be able to:
1. **Choose which agent** to power their assistant (Claude, GPT-4, Gemini, Codex, etc.)
2. **Configure per-agent settings** (permission modes, model selection, API keys)
3. **Run multiple agents simultaneously** (e.g., one transcribing, one analyzing, one coding)
4. **Agent sessions persist** across conversations with context tracking

### Implementation

#### 2a. Agent Type System (from Agor)
```typescript
// src/types/agent.ts — adapted from Agor's agentic-tool.ts
export type AgentName = 'claude' | 'openai' | 'gemini' | 'codex' | 'groq' | 'mistral' | 'openrouter' | 'ollama' | 'opencode';

export interface AgentConfig {
  name: AgentName;
  displayName: string;
  icon: string;
  apiKeyEnvVar: string; // e.g. 'ANTHROPIC_API_KEY'
  models: ModelInfo[];
  supportsStreaming: boolean;
  supportsVision: boolean;
  supportsToolUse: boolean;
  permissionModes?: string[]; // For agentic tools
}
```

#### 2b. Session Management (from Agor)
```typescript
// src/types/session.ts — simplified from Agor's session.ts
export interface AgentSession {
  id: string;
  agent: AgentName;
  status: 'idle' | 'running' | 'completed' | 'failed';
  model: string;
  permissionMode?: string;
  messages: Message[];
  contextUsage?: number;
  contextLimit?: number;
  createdAt: number;
  updatedAt: number;
}
```

#### 2c. Credential Management (from Agor)
```typescript
// src/config/credentials.ts — adapted from Agor's config types
export interface Credentials {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  XAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}
```
Store encrypted in SQLite (or use `tauri-plugin-keychain` which pluely already has).

#### 2d. Executor Pattern (from Agor)
Agor's `base-executor.ts` defines a `BaseTool` interface:
```typescript
interface BaseTool {
  executePromptWithStreaming(sessionId, prompt, taskId, permissionMode, callbacks, abortController): Promise<Result>;
  stopTask?(sessionId, taskId): Promise<StopResult>;
  computeContextWindow?(sessionId): Promise<number>;
}
```

We adapt this for pluely's context — the "executor" sends messages to AI APIs and streams responses back to the overlay UI. Each provider gets an executor implementation.

### Files to Create/Modify
- `src/types/agent.ts` — new, agent type definitions
- `src/types/session.ts` — new, session management types
- `src/config/credentials.ts` — new, credential management
- `src/lib/executors/base.ts` — new, base executor interface
- `src/lib/executors/claude.ts` — new, Claude API executor
- `src/lib/executors/openai.ts` — new, OpenAI API executor
- `src/lib/executors/gemini.ts` — new, Gemini API executor
- `src/lib/executors/codex.ts` — new, Codex executor
- Modify `src/config/ai-providers.constants.ts` — add model catalogs per agent
- Modify `src/contexts/app.context.tsx` — replace provider state with agent session state

---

## Phase 3: Enhanced Configuration & Customization

**Goal**: Much richer settings than pluely currently offers.

### 3a. Settings Overhaul
- **Agent configuration panel**: Per-agent API key entry, model selection, parameter tuning (temperature, max_tokens, top_p)
- **Multi-agent mode**: Run different agents for different tasks (e.g., Groq for fast STT, Claude for analysis, GPT-4 for coding)
- **System prompt library**: Expandable categorized prompts, import/export, per-context switching
- **Audio settings**: Input/output device selection (already exists), add: noise reduction level, VAD sensitivity slider, recording quality
- **UI customization**: Theme (already has light/dark), add: custom colors, transparency slider, font size, layout presets, window snap positions
- **Shortcut editor**: Already exists, add: custom macros, per-app shortcuts, quick-paste slots

### 3b. New Settings Storage
Move from localStorage (current) to SQLite for settings that need persistence:
```sql
-- New migration
CREATE TABLE agent_configs (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  api_key_encrypted TEXT,
  default_model TEXT,
  parameters TEXT, -- JSON: {temperature, max_tokens, etc.}
  is_enabled BOOLEAN DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  conversation_id TEXT,
  model TEXT,
  status TEXT DEFAULT 'idle',
  context_usage INTEGER,
  context_limit INTEGER,
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
```

---

## Phase 4: Enhanced Audio & STT

**Goal**: Improve the audio system without rewriting it.

### Tasks
1. **Add microphone capture** alongside system audio (pluely only captures system output)
2. **Add simultaneous mic + system capture** for recording both sides of a conversation
3. **Add local Whisper** (`whisper-rs` / `whisper.cpp` via FFI) for offline transcription — no API key needed
4. **Add streaming STT** for providers that support it (Deepgram WebSocket, AssemblyAI real-time)
5. **Add speaker diarization hints** — label "Speaker 1" / "Speaker 2" based on audio source (system vs mic)
6. **Add transcript export** — save meeting transcripts as .txt, .srt, .md

### Files Modified
- `src-tauri/src/speaker/commands.rs` — add mic capture mode
- `src-tauri/Cargo.toml` — add whisper-rs dependency
- `src-tauri/src/stt/` — new directory for local STT
- `src/config/stt.constants.ts` — add local Whisper option
- `src/pages/audio/` — enhanced audio settings UI

---

## Phase 5: Enhanced Provider System

**Goal**: Support more providers with richer configurations.

### New Providers to Add
- **DeepSeek** — DeepSeek V3/R1
- **Together AI** — open-source model hosting
- **Fireworks AI** — fast inference
- **Cerebras** — ultra-fast inference
- **Local models via Ollama** — already supported but enhance with model management UI

### Enhanced Custom Provider Builder
- **Visual curl editor** with syntax highlighting
- **Test connection** button that sends a test request
- **Auto-detect streaming format** (SSE vs newline-delimited)
- **Variable auto-discovery** from pasted curl
- **Import/export** provider configurations as JSON
- **Provider groups** with fallback chains

### Files Modified
- `src/config/ai-providers.constants.ts` — add new providers
- `src/pages/dev/` — enhanced custom provider UI
- `src/lib/functions/common.function.ts` — enhanced variable replacer

---

## Phase 6: UI Enhancements

**Goal**: Better UX without breaking the overlay's undetectability.

### Overlay Improvements
- **Multi-panel mode**: Split overlay into sections (transcript, AI response, quick actions)
- **Floating minibar**: Collapse to a tiny bar when not actively needed
- **Quick action buttons**: One-click screenshot+analyze, record+transcribe, paste response
- **Response preview**: Show partial response while AI is still generating

### Dashboard Improvements
- **Agent dashboard**: See all configured agents, their status, API key health
- **Conversation search**: Full-text search across all chat history
- **Usage analytics**: Token usage, cost estimates, per-agent stats (stored locally)
- **Export**: Conversations as markdown, PDF, JSON

---

## Implementation Order

```
Phase 1: Fork & strip (1-2 days)
  → Working app with no pluely.com dependency
  → All custom provider functionality preserved
  → No license gates, no telemetry

Phase 2: Multi-agent model (1-2 weeks)
  → Agent type system from Agor
  → Session management
  → Credential management (encrypted, per-agent)
  → Executor pattern for each provider

Phase 3: Enhanced config (1 week)
  → Settings overhaul with per-agent config
  → SQLite migration for agent configs
  → System prompt library

Phase 4: Enhanced audio (1-2 weeks)
  → Mic capture
  → Local Whisper
  → Streaming STT
  → Transcript export

Phase 5: More providers (1 week)
  → DeepSeek, Together, Fireworks, Cerebras
  → Enhanced custom provider builder

Phase 6: UI enhancements (1-2 weeks)
  → Multi-panel overlay
  → Agent dashboard
  → Search, analytics, export
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│                 Tauri App                        │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │           React Frontend                  │   │
│  │                                           │   │
│  │  ┌─────────┐  ┌──────────┐  ┌────────┐  │   │
│  │  │ Overlay  │  │Dashboard │  │Settings│  │   │
│  │  │  (main)  │  │  (chats) │  │  (dev) │  │   │
│  │  └────┬─────┘  └────┬─────┘  └───┬────┘  │   │
│  │       │              │             │       │   │
│  │  ┌────┴──────────────┴─────────────┴────┐ │   │
│  │  │         App Context / Zustand        │ │   │
│  │  │  - Agent Sessions                    │ │   │
│  │  │  - Credentials                       │ │   │
│  │  │  - Audio State                       │ │   │
│  │  └────────────────┬─────────────────────┘ │   │
│  │                   │                        │   │
│  │  ┌────────────────┴─────────────────────┐ │   │
│  │  │          Executor Layer              │ │   │
│  │  │  ┌───────┐ ┌──────┐ ┌──────┐       │ │   │
│  │  │  │Claude │ │OpenAI│ │Gemini│ ...    │ │   │
│  │  │  └───┬───┘ └──┬───┘ └──┬───┘       │ │   │
│  │  │      └────────┼────────┘            │ │   │
│  │  │           Direct API calls          │ │   │
│  │  └─────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │           Rust Backend (Tauri)            │   │
│  │                                           │   │
│  │  ┌─────────┐  ┌──────────┐  ┌────────┐  │   │
│  │  │ Audio   │  │Screenshot│  │Shortcuts│  │   │
│  │  │ Capture │  │ Capture  │  │ System  │  │   │
│  │  └─────────┘  └──────────┘  └────────┘  │   │
│  │  ┌─────────┐  ┌──────────┐  ┌────────┐  │   │
│  │  │ VAD +   │  │ Window   │  │ SQLite │  │   │
│  │  │ STT     │  │ Manager  │  │   DB   │  │   │
│  │  └─────────┘  └──────────┘  └────────┘  │   │
│  │  ┌─────────────────────────────────────┐ │   │
│  │  │  Local Whisper (whisper.cpp FFI)    │ │   │
│  │  └─────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## Decisions

1. **Project name** — Rebrand to **"Freely"**
2. **Priority** — Yes, Phase 1 (strip server dep) starts immediately.
3. **Agent priority** — **Claude Code first**, adopting Agor's agent orchestration approach. Other providers follow after.
4. **Local Whisper** — Support **both** cloud STT (Deepgram, OpenAI Whisper API, etc.) **and** local STT (whisper.cpp via whisper-rs). whisper.cpp is a C/C++ port of OpenAI's Whisper model that runs fully offline on-device — no API key, no cost, good Apple Silicon performance via Metal. Source: https://github.com/ggerganov/whisper.cpp
5. **Platform** — macOS-first, then expand to Windows/Linux later.
