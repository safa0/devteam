/**
 * FreelyAgentOrchestrator
 *
 * Routes chat requests to agent-backed providers (Claude Code CLI, Codex, Gemini SDK)
 * instead of the curl-based provider path. Returns AsyncIterable<string> to match
 * the existing fetchAIResponse streaming contract.
 *
 * Architecture:
 * - Each provider is backed by a Freely tool adapter (FreelyClaudeTool, etc.)
 * - Claude: uses `--resume` for session continuity (no history prepending needed)
 * - Codex/Gemini: use history injection as fallback (CLIs lack resume support)
 * - Actual CLI execution happens via Tauri invoke → Rust sidecar
 */

import { FreelyClaudeTool } from './claude/freely-claude-tool.js';
import { FreelyCodexTool } from './codex/freely-codex-tool.js';
import { FreelyGeminiTool } from './gemini/freely-gemini-tool.js';
import {
  createStorageAdapter,
  getProviderVariable,
  type FreelyStorageAdapter,
} from './storage-adapter.js';
import {
  type SessionID,
  type StreamingCallbacks,
  type MessageID,
  generateId,
  toSessionID,
} from './types.js';

/** Invoke a Tauri command — no-op outside of Tauri context */
async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (typeof window === 'undefined' || !('__TAURI__' in window)) return undefined;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  } catch {
    return undefined;
  }
}

/**
 * Kill the CLI child process for the given session via the Rust registry.
 * Safe to call even if the session has already ended (no-op on the Rust side).
 */
async function killAgentProcess(sessionId: string): Promise<void> {
  try {
    await tauriInvoke('kill_agent_process', { session_id: sessionId });
  } catch {
    // Best-effort — don't surface errors to the caller
  }
}

export const AGENT_PROVIDER_IDS = ['claude-code', 'codex', 'gemini-sdk'] as const;
export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];

export interface AgentExecuteParams {
  toolType: AgentProviderId;
  userMessage: string;
  systemPrompt?: string;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  /**
   * Optional session ID for conversation continuity.
   * If omitted a new session ID is generated per call (stateless).
   */
  sessionId?: string;
  /** API key for Codex (OPENAI_API_KEY) or Gemini (GOOGLE_API_KEY) — falls back to localStorage */
  apiKey?: string;
  /** Model override (e.g. "claude-sonnet-4-5-20250514", "haiku") — passed as --model to CLI */
  model?: string;
  signal?: AbortSignal;
}

export class FreelyAgentOrchestrator {
  private readonly storage: FreelyStorageAdapter;
  private readonly claudeTool: FreelyClaudeTool;
  private readonly codexTool: FreelyCodexTool;
  private readonly geminiTool: FreelyGeminiTool;

  constructor(storage?: FreelyStorageAdapter) {
    this.storage = storage ?? createStorageAdapter();

    this.claudeTool = new FreelyClaudeTool(
      this.storage.tasksService,
      this.storage.sessionsService,
      this.storage.sessionsRepository
    );

    this.codexTool = new FreelyCodexTool(
      this.storage.tasksService,
      this.storage.sessionsRepository
    );

    this.geminiTool = new FreelyGeminiTool(
      this.storage.tasksService,
      this.storage.sessionsRepository
    );
  }

  /** Returns true if the given provider ID is handled by this orchestrator */
  isAgentProvider(id: string): id is AgentProviderId {
    return (AGENT_PROVIDER_IDS as readonly string[]).includes(id);
  }

  /** Stream a response from the selected agent provider */
  async *execute(params: AgentExecuteParams): AsyncIterable<string> {
    if (params.signal?.aborted) return;

    switch (params.toolType) {
      case 'claude-code':
        yield* this.executeClaudeCode(params);
        break;
      case 'codex':
        yield* this.executeCodex(params);
        break;
      case 'gemini-sdk':
        yield* this.executeGeminiSdk(params);
        break;
      default: {
        // TypeScript exhaustiveness — should never reach here
        const _exhaustive: never = params.toolType;
        throw new Error(`Unknown agent provider: ${_exhaustive}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // History injection fallback for CLIs that lack --resume (Codex, Gemini).
  // Claude uses --resume instead, so this is NOT used for Claude.
  // ---------------------------------------------------------------------------
  private buildPromptWithHistory(params: AgentExecuteParams): string {
    if (!params.history?.length) return params.userMessage;

    const MAX_HISTORY_MESSAGES = 20;

    const historyBlock = params.history
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => {
        // Escape closing tags to prevent content from breaking the XML-like structure
        const sanitized = m.content.replace(/<\//g, '&lt;/');
        return `[${m.role}]: ${sanitized}`;
      })
      .join('\n\n');

    return `<conversation_history>\n${historyBlock}\n</conversation_history>\n\n${params.userMessage}`;
  }

  // ---------------------------------------------------------------------------
  // Claude Code — uses `--resume` for session continuity, no history prepending
  // ---------------------------------------------------------------------------
  private async *executeClaudeCode(params: AgentExecuteParams): AsyncIterable<string> {
    if (params.signal?.aborted) return;

    const sessionId = toSessionID(params.sessionId ?? generateId());

    // Kill the Rust child process when the caller aborts
    params.signal?.addEventListener('abort', () => killAgentProcess(sessionId), { once: true });
    let done = false;
    let errorThrown: Error | null = null;

    const queue: string[] = [];
    const waiters: Array<() => void> = [];

    function enqueue(chunk: string) {
      queue.push(chunk);
      waiters.shift()?.();
    }

    function finish(err?: Error) {
      if (done) return; // Prevent double-finish
      done = true;
      errorThrown = err ?? null;
      waiters.shift()?.();
    }

    const callbacks = buildStreamingCallbacks(enqueue, finish, params.signal);

    // Claude uses --resume with the CLI's own session ID for conversation continuity.
    // Only the current userMessage is sent — Claude CLI maintains full history internally.
    try {
      this.claudeTool
        .executePromptWithStreaming(sessionId, params.userMessage, undefined, undefined, callbacks, undefined, params.model)
        .then((result) => {
          if (result.error) finish(new Error(result.error));
          else finish();
        })
        .catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }

    yield* drainQueue(queue, waiters, () => done, () => errorThrown, params.signal);
  }

  // ---------------------------------------------------------------------------
  // OpenAI Codex — reads OPENAI_API_KEY from params or localStorage
  // Uses history injection (no --resume equivalent)
  // ---------------------------------------------------------------------------
  private async *executeCodex(params: AgentExecuteParams): AsyncIterable<string> {
    if (params.signal?.aborted) return;

    const apiKey = params.apiKey ?? getProviderVariable('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY is required for Codex. Add it in Agent Provider settings or localStorage.'
      );
    }

    const sessionId = toSessionID(params.sessionId ?? generateId());

    // Kill the Rust child process when the caller aborts
    params.signal?.addEventListener('abort', () => killAgentProcess(sessionId), { once: true });
    const prompt = this.buildPromptWithHistory(params);
    const queue: string[] = [];
    const waiters: Array<() => void> = [];
    let done = false;
    let errorThrown: Error | null = null;

    function enqueue(chunk: string) {
      queue.push(chunk);
      waiters.shift()?.();
    }

    function finish(err?: Error) {
      if (done) return;
      done = true;
      errorThrown = err ?? null;
      waiters.shift()?.();
    }

    const callbacks = buildStreamingCallbacks(enqueue, finish, params.signal);

    try {
      this.codexTool
        .executePromptWithStreaming(sessionId, prompt, undefined, undefined, callbacks, undefined, apiKey)
        .then((result) => {
          if (result.error) finish(new Error(result.error));
          else finish();
        })
        .catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }

    yield* drainQueue(queue, waiters, () => done, () => errorThrown, params.signal);
  }

  // ---------------------------------------------------------------------------
  // Google Gemini SDK — reads GOOGLE_API_KEY from params or localStorage
  // Uses history injection (no --resume equivalent)
  // ---------------------------------------------------------------------------
  private async *executeGeminiSdk(params: AgentExecuteParams): AsyncIterable<string> {
    if (params.signal?.aborted) return;

    // Gemini can operate with OAuth login even without an API key
    const apiKey = params.apiKey ?? getProviderVariable('GOOGLE_API_KEY') ?? undefined;
    const sessionId = toSessionID(params.sessionId ?? generateId());

    // Kill the Rust child process when the caller aborts
    params.signal?.addEventListener('abort', () => killAgentProcess(sessionId), { once: true });
    const prompt = this.buildPromptWithHistory(params);
    const queue: string[] = [];
    const waiters: Array<() => void> = [];
    let done = false;
    let errorThrown: Error | null = null;

    function enqueue(chunk: string) {
      queue.push(chunk);
      waiters.shift()?.();
    }

    function finish(err?: Error) {
      if (done) return;
      done = true;
      errorThrown = err ?? null;
      waiters.shift()?.();
    }

    const callbacks = buildStreamingCallbacks(enqueue, finish, params.signal);

    try {
      this.geminiTool
        .executePromptWithStreaming(sessionId, prompt, undefined, undefined, callbacks, undefined, apiKey)
        .then((result) => {
          if (result.error) finish(new Error(result.error));
          else finish();
        })
        .catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }

    yield* drainQueue(queue, waiters, () => done, () => errorThrown, params.signal);
  }

  /**
   * Check which agent tools are installed on the current system.
   */
  async getAvailableTools(): Promise<Record<AgentProviderId, boolean>> {
    const [claude, codex, gemini] = await Promise.all([
      this.claudeTool.checkInstalled(),
      this.codexTool.checkInstalled(),
      this.geminiTool.checkInstalled(),
    ]);

    return {
      'claude-code': claude,
      codex,
      'gemini-sdk': gemini,
    };
  }
}

// ============================================================================
// Helpers: streaming callbacks → async generator bridge
// ============================================================================

/** Build StreamingCallbacks that funnel chunks into the provided enqueue/finish functions */
function buildStreamingCallbacks(
  enqueue: (chunk: string) => void,
  finish: (err?: Error) => void,
  signal?: AbortSignal
): StreamingCallbacks {
  // Abort support
  signal?.addEventListener('abort', () => finish(new Error('Aborted')), { once: true });

  return {
    async onStreamStart(_messageId: MessageID, _metadata: { session_id: SessionID; task_id?: unknown; role: string; timestamp: string }) {
      // noop
    },
    async onStreamChunk(_messageId: MessageID, chunk: string) {
      enqueue(chunk);
    },
    async onStreamEnd(_messageId: MessageID) {
      // noop — finish() called by executePromptWithStreaming's .then()
    },
    async onStreamError(_messageId: MessageID, error: Error) {
      finish(error);
    },
  };
}

/** Maximum time to wait for the next chunk before assuming the CLI process has crashed. */
const DRAIN_TIMEOUT_MS = 30_000;

/** Async generator that yields from a push queue until done */
async function* drainQueue(
  queue: string[],
  waiters: Array<() => void>,
  isDone: () => boolean,
  getError: () => Error | null,
  signal?: AbortSignal
): AsyncGenerator<string> {
  while (true) {
    if (signal?.aborted) return;

    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }

    if (isDone()) {
      // Drain any remaining items
      while (queue.length > 0) yield queue.shift()!;
      const err = getError();
      if (err) throw err;
      return;
    }

    // Wait for next chunk or done signal, with a timeout to prevent hanging
    // indefinitely if the CLI process crashes without calling finish().
    const timedOut = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), DRAIN_TIMEOUT_MS);
      waiters.push(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    if (timedOut) {
      throw new Error(
        `Agent stream timed out after ${DRAIN_TIMEOUT_MS / 1000}s — CLI process may have crashed.`
      );
    }
  }
}

/** Singleton instance used across the app */
export const freelyAgentOrchestrator = new FreelyAgentOrchestrator();
