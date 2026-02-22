/**
 * Freely Claude Tool Adapter
 *
 * Wraps the extracted ClaudeTool for Freely's Tauri/browser context.
 * - Auth: uses `claude login` OAuth (no API key required)
 * - Execution: invokes claude CLI via Tauri shell command
 * - Storage: localStorage via FreelyStorageAdapter
 *
 * NOTE: The actual SDK streaming from extracted-from-agor/claude/prompt-service.ts
 * requires Node.js (@anthropic-ai/claude-agent-sdk). In a Tauri app this runs
 * in the Rust backend as a sidecar. Wire up the Tauri `invoke('run_claude', ...)`
 * command when the Rust sidecar is implemented.
 */

import {
  type FreelyExecutionResult,
  type ImportOptions,
  type Message,
  MessageRole,
  type MessageID,
  type PermissionMode,
  type SessionID,
  type StreamingCallbacks,
  type TaskID,
  type ToolCapabilities,
  generateId,
  toMessageID,
} from '../types.js';

import type {
  LocalStorageMessagesRepository,
  LocalStorageMessagesService,
  LocalStorageSessionsRepository,
  LocalStorageSessionsService,
  LocalStorageTasksService,
} from '../storage-adapter.js';

// Tauri event listener for real-time streaming
async function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<T>(event, (ev) => handler(ev.payload));
  return unlisten;
}

// ============================================================================
// Execution via Tauri invoke
// ============================================================================

/**
 * Request payload sent to the Rust sidecar for Claude execution.
 * Matches the expected shape for `invoke('run_claude', payload)`.
 */
interface ClaudeInvokePayload {
  sessionId: string;
  prompt: string;
  taskId?: string;
  permissionMode?: string;
  workingDirectory?: string;
  model?: string;
}

/**
 * Event streamed back from the Rust sidecar.
 * Mirrors the Claude Agent SDK ProcessedEvent shape.
 */
interface ClaudeStreamEvent {
  type: 'partial' | 'complete' | 'error' | 'stopped';
  textChunk?: string;
  content?: Array<{ type: string; text?: string }>;
  resolvedModel?: string;
  agentSessionId?: string;
  tokenUsage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

// Tauri invoke is available at runtime in the Tauri WebView context
declare const __TAURI_INTERNALS__: unknown;

function isTauriContext(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { invoke } = (window as any).__TAURI_INTERNALS__ as {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T>;
  };
  return invoke(command, args);
}

// ============================================================================
// FreelyClaudeTool
// ============================================================================

export class FreelyClaudeTool {
  readonly toolType = 'claude-code' as const;
  readonly name = 'Claude Code';

  constructor(
    private readonly messagesService: LocalStorageMessagesService,
    /** Reserved for future task status updates */
    _tasksService: LocalStorageTasksService,
    /** Reserved for future session patch calls */
    _sessionsService: LocalStorageSessionsService,
    private readonly messagesRepo: LocalStorageMessagesRepository,
    private readonly sessionsRepo: LocalStorageSessionsRepository
  ) {}

  getCapabilities(): ToolCapabilities {
    return {
      supportsSessionImport: false, // ❌ Transcript parsing not wired in Freely yet
      supportsSessionCreate: false, // ❌ Waiting for Tauri sidecar
      supportsLiveExecution: true,  // ✅ Via Tauri invoke → Rust sidecar → claude CLI
      supportsSessionFork: false,
      supportsChildSpawn: false,
      supportsGitState: false,
      supportsStreaming: true, // ✅ Via Tauri event stream
    };
  }

  async checkInstalled(): Promise<boolean> {
    if (!isTauriContext()) return false;
    try {
      const result = await tauriInvoke<{ installed: boolean }>('check_tool_installed', {
        tool: 'claude',
      });
      return result.installed;
    } catch {
      return false;
    }
  }

  /**
   * Execute a prompt via Claude CLI with optional streaming callbacks.
   *
   * Uses `claude login` OAuth — no API key needed.
   * Streams response tokens back via Tauri events.
   */
  async executePromptWithStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    streamingCallbacks?: StreamingCallbacks,
    _abortController?: AbortController,
    model?: string
  ): Promise<FreelyExecutionResult> {
    // Get next message index
    const existingMessages = await this.messagesRepo.findBySessionId(sessionId);
    let nextIndex = existingMessages.length;

    // Create and persist user message
    const userMessageId = toMessageID(generateId());
    const userMessage: Message = {
      message_id: userMessageId,
      session_id: sessionId,
      type: 'user',
      role: MessageRole.USER,
      index: nextIndex++,
      timestamp: new Date().toISOString(),
      content_preview: prompt.substring(0, 200),
      content: prompt,
      task_id: taskId,
    };
    await this.messagesService.create(userMessage);

    // Ensure session record exists
    await this.sessionsRepo.ensureSession(sessionId, this.toolType);

    const assistantMessageIds: MessageID[] = [];
    let responseText = '';
    let resolvedModel: string | undefined;
    let wasStopped = false;

    if (!isTauriContext()) {
      // Non-Tauri fallback: return a placeholder (dev environment)
      console.warn('[FreelyClaudeTool] Not in Tauri context — execution skipped');
      return {
        userMessageId,
        assistantMessageIds: [],
        responseText: '[Claude execution requires Tauri context]',
        toolType: this.toolType,
        wasStopped: false,
      };
    }

    try {
      const assistantMessageId = toMessageID(generateId());

      if (streamingCallbacks) {
        await streamingCallbacks.onStreamStart(assistantMessageId, {
          session_id: sessionId,
          task_id: taskId,
          role: MessageRole.ASSISTANT,
          timestamp: new Date().toISOString(),
        });
      }

      const payload: ClaudeInvokePayload = {
        sessionId,
        prompt,
        taskId,
        permissionMode,
        model,
      };

      // Listen for real-time streaming events from the Rust backend
      const eventName = `agent:stream:${sessionId}`;
      const unlisten = await tauriListen<ClaudeStreamEvent>(eventName, (event) => {
        if (event.type === 'stopped') {
          wasStopped = true;
          return;
        }

        if (event.type === 'partial' && event.textChunk) {
          responseText += event.textChunk;
          if (streamingCallbacks) {
            streamingCallbacks.onStreamChunk(assistantMessageId, event.textChunk);
          }
        }

        if (event.resolvedModel) resolvedModel = event.resolvedModel;

        if (event.agentSessionId) {
          this.sessionsRepo.update(sessionId, { sdk_session_id: event.agentSessionId });
        }
      });

      try {
        // Invoke runs the process; events stream in real-time via the listener above
        await tauriInvoke<ClaudeStreamEvent[]>('run_claude', { payload });
      } finally {
        unlisten();
      }

      if (streamingCallbacks) {
        if (wasStopped) {
          await streamingCallbacks.onStreamError(
            assistantMessageId,
            new Error('Claude execution stopped')
          );
        } else {
          await streamingCallbacks.onStreamEnd(assistantMessageId);
        }
      }

      // Persist the complete assistant message
      const assistantMessage: Message = {
        message_id: assistantMessageId,
        session_id: sessionId,
        type: 'assistant',
        role: MessageRole.ASSISTANT,
        index: nextIndex++,
        timestamp: new Date().toISOString(),
        content_preview: responseText.substring(0, 200),
        content: responseText,
        task_id: taskId,
        metadata: { model: resolvedModel },
      };
      await this.messagesService.create(assistantMessage);
      assistantMessageIds.push(assistantMessageId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[FreelyClaudeTool] Execution error:', err);
      return {
        userMessageId,
        assistantMessageIds,
        responseText,
        toolType: this.toolType,
        error: errMsg,
        wasStopped,
      };
    }

    return {
      userMessageId,
      assistantMessageIds,
      responseText,
      toolType: this.toolType,
      model: resolvedModel,
      wasStopped,
    };
  }

  /** Non-streaming variant (delegates to streaming with no callbacks) */
  async executePrompt(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode
  ): Promise<FreelyExecutionResult> {
    return this.executePromptWithStreaming(sessionId, prompt, taskId, permissionMode);
  }

  async importSession(_sessionId: string, _options?: ImportOptions): Promise<void> {
    throw new Error(
      'FreelyClaudeTool.importSession: not yet implemented. ' +
      'Wire up transcript parsing from extracted-from-agor/claude/import/'
    );
  }

  // biome-ignore lint/suspicious/noExplicitAny: normalizer is deprecated upstream
  normalizedSdkResponse(_rawResponse: any): never {
    throw new Error('normalizedSdkResponse() is deprecated — not implemented in FreelyClaudeTool');
  }
}
