/**
 * Freely Codex Tool Adapter
 *
 * Wraps the extracted CodexTool for Freely's Tauri/browser context.
 * - Auth: reads OPENAI_API_KEY from Freely's provider variables in localStorage
 * - Execution: invokes codex CLI via Tauri shell command
 * - Storage: localStorage via FreelyStorageAdapter
 *
 * NOTE: The actual SDK streaming from extracted-from-agor/codex/prompt-service.ts
 * requires Node.js (@openai/codex-sdk). In a Tauri app this runs in the Rust
 * backend as a sidecar. Wire up `invoke('run_codex', ...)` when implemented.
 */

import {
  type FreelyExecutionResult,
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
  LocalStorageSessionsRepository,
  LocalStorageTasksService,
} from '../storage-adapter.js';
import { getProviderVariable } from '../storage-adapter.js';

// ============================================================================
// Tauri helpers (shared pattern)
// ============================================================================

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
// Codex stream event shape (mirrors CodexStreamEvent from prompt-service)
// ============================================================================

interface CodexStreamEvent {
  type: 'partial' | 'tool_start' | 'tool_complete' | 'complete' | 'stopped' | 'error';
  textChunk?: string;
  threadId?: string;
  resolvedModel?: string;
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  toolUse?: { id: string; name: string; input: Record<string, unknown>; output?: string; status?: string };
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

// ============================================================================
// FreelyCodexTool
// ============================================================================

export class FreelyCodexTool {
  readonly toolType = 'codex' as const;
  readonly name = 'OpenAI Codex';

  /** Resolved API key — reads from localStorage provider variables */
  private get apiKey(): string | null {
    return getProviderVariable('OPENAI_API_KEY');
  }

  constructor(
    private readonly tasksService: LocalStorageTasksService,
    private readonly sessionsRepo: LocalStorageSessionsRepository
  ) {}

  getCapabilities(): ToolCapabilities {
    return {
      supportsSessionImport: false,
      supportsSessionCreate: false,
      supportsLiveExecution: true,
      supportsSessionFork: false,
      supportsChildSpawn: false,
      supportsGitState: false,
      supportsStreaming: true,
    };
  }

  async checkInstalled(): Promise<boolean> {
    if (!isTauriContext()) return false;
    try {
      const result = await tauriInvoke<{ installed: boolean }>('check_tool_installed', {
        tool: 'codex',
      });
      return result.installed;
    } catch {
      return false;
    }
  }

  /**
   * Execute a prompt via Codex CLI with optional streaming callbacks.
   *
   * Reads OPENAI_API_KEY from Freely's localStorage provider variables.
   */
  async executePromptWithStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    streamingCallbacks?: StreamingCallbacks,
    _abortController?: AbortController,
    /** Optional API key override — falls back to localStorage provider variable */
    apiKeyOverride?: string
  ): Promise<FreelyExecutionResult> {
    const apiKey = apiKeyOverride ?? this.apiKey;
    if (!apiKey) {
      return {
        userMessageId: toMessageID(generateId()),
        assistantMessageIds: [],
        responseText: '',
        toolType: this.toolType,
        error: 'OPENAI_API_KEY not found. Add it to your Freely provider variables.',
      };
    }

    const userMessageId = toMessageID(generateId());

    // Ensure session record exists
    await this.sessionsRepo.ensureSession(sessionId, this.toolType);

    const assistantMessageIds: MessageID[] = [];
    let responseText = '';
    let resolvedModel: string | undefined;
    let wasStopped = false;
    let capturedThreadId: string | undefined;

    if (!isTauriContext()) {
      console.warn('[FreelyCodexTool] Not in Tauri context — execution skipped');
      return {
        userMessageId,
        assistantMessageIds: [],
        responseText: '[Codex execution requires Tauri context]',
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

      // Get existing thread ID for conversation continuity
      const session = await this.sessionsRepo.findById(sessionId);
      const existingThreadId = session?.sdk_session_id;

      const events = await tauriInvoke<CodexStreamEvent[]>('run_codex', {
        payload: {
          sessionId,
          prompt,
          taskId,
          permissionMode,
          apiKey,
          threadId: existingThreadId,
        },
      });

      for (const event of events) {
        if (event.type === 'stopped') {
          wasStopped = true;
          break;
        }

        if (event.type === 'partial' && event.textChunk) {
          responseText += event.textChunk;
          if (streamingCallbacks) {
            await streamingCallbacks.onStreamChunk(assistantMessageId, event.textChunk);
          }
        }

        if (event.threadId && !capturedThreadId) {
          capturedThreadId = event.threadId;
          await this.sessionsRepo.update(sessionId, { sdk_session_id: capturedThreadId });
        }

        if (event.resolvedModel) resolvedModel = event.resolvedModel;
      }

      if (streamingCallbacks) {
        if (wasStopped) {
          await streamingCallbacks.onStreamError(
            assistantMessageId,
            new Error('Codex execution stopped')
          );
        } else {
          await streamingCallbacks.onStreamEnd(assistantMessageId);
        }
      }

      // Update task model if available
      if (taskId && resolvedModel) {
        await this.tasksService.patch(taskId, { model: resolvedModel });
      }

      assistantMessageIds.push(assistantMessageId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[FreelyCodexTool] Execution error:', err);
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

  /** Non-streaming variant */
  async executePrompt(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode
  ): Promise<FreelyExecutionResult> {
    return this.executePromptWithStreaming(sessionId, prompt, taskId, permissionMode);
  }

  // biome-ignore lint/suspicious/noExplicitAny: normalizer is deprecated upstream
  normalizedSdkResponse(_rawResponse: any): never {
    throw new Error('normalizedSdkResponse() is deprecated — not implemented in FreelyCodexTool');
  }
}
