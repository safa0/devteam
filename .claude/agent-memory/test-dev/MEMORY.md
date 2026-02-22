# test-dev Agent Memory

## Project: Freely (freely/)

### Test Infrastructure
- **Runner**: Vitest v2 with jsdom environment
- **Config**: `freely/vitest.config.ts` — includes `@` path alias and coverage via v8
- **Setup**: `freely/vitest.setup.ts` — provides in-memory localStorage mock (jsdom's built-in `.clear()` can be missing when `--localstorage-file` flag is set without a path)
- **Scripts**: `npm test` (vitest run), `npm run test:watch`

### Key Patterns

#### Mocking Tauri context
The tool adapters check `'__TAURI_INTERNALS__' in window` to detect Tauri. Mock it in tests:
```typescript
(window as any).__TAURI_INTERNALS__ = { invoke: vi.fn().mockResolvedValue([...events]) };
// cleanup in afterEach:
delete (window as any).__TAURI_INTERNALS__;
```
This avoids module mocking and tests the real integration path.

#### Tauri stream event shape
```typescript
{ type: 'partial', textChunk: 'chunk text' }  // → onStreamChunk called
{ type: 'stopped' }                            // → onStreamError called, wasStopped=true
{ type: 'complete' }                           // → no callback (finish() via .then())
{ resolvedModel: 'model-name' }               // → captured in result.model
```

#### localStorage key scheme (freely_agents prefix)
```
freely_agents_messages_{sessionId}   — message arrays
freely_agents_session_{sessionId}    — session records
freely_agents_task_{taskId}          — task records
freely_provider_var_{varName}        — API keys
```

#### Streaming callback sequence
For happy path: `onStreamStart → onStreamChunk (×n) → onStreamEnd`
For stopped: `onStreamStart → onStreamChunk (×n) → onStreamError` (no onStreamEnd)

#### Codex/Gemini tool API key behavior
- Codex: returns `{ error: '...' }` immediately if no OPENAI_API_KEY in localStorage
- Gemini: proceeds without API key (OAuth fallback) — only passes null apiKey to Tauri
- Orchestrator has its own check for Codex (throws), but tool checks localStorage independently

### Test File Locations
`freely/src/lib/agents/__tests__/`
- `types.test.ts`
- `storage-adapter.test.ts`
- `orchestrator.test.ts`
- `freely-claude-tool.test.ts`
- `freely-codex-tool.test.ts`
- `freely-gemini-tool.test.ts`
