/**
 * Freely Gemini Tool Adapter
 *
 * Wraps the extracted GeminiTool for Freely's Tauri/browser context.
 * - Auth: reads GOOGLE_API_KEY from Freely's provider variables in localStorage
 * - Execution: invokes gemini CLI via Tauri shell command
 * - Storage: localStorage via FreelyStorageAdapter
 *
 * NOTE: The actual SDK streaming from extracted-from-agor/gemini/prompt-service.ts
 * requires Node.js (@google/gemini-cli-core). In a Tauri app this runs in the Rust
 * backend as a sidecar. Wire up `invoke('run_gemini', ...)` when implemented.
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
// Tauri helpers
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
// Gemini stream event shape (mirrors GeminiPromptService events)
// ============================================================================

interface GeminiStreamEvent {
  type: 'partial' | 'tool_start' | 'tool_complete' | 'complete' | 'error';
  textChunk?: string;
  resolvedModel?: string;
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  toolUse?: { id: string; name: string; input: Record<string, unknown>; output?: string };
  usage?: { input_tokens: number; output_tokens: number };
  rawSdkResponse?: unknown;
  error?: string;
}

// ============================================================================
// FreelyGeminiTool
// ============================================================================

export class FreelyGeminiTool {
  readonly toolType = 'gemini' as const;
  readonly name = 'Google Gemini';

  /** Resolved API key — reads from localStorage provider variables */
  private get apiKey(): string | null {
    return getProviderVariable('GOOGLE_API_KEY');
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
        tool: 'gemini',
      });
      return result.installed;
    } catch {
      return false;
    }
  }

  /**
   * Execute a prompt via Gemini CLI with optional streaming callbacks.
   *
   * Reads GOOGLE_API_KEY from Freely's localStorage provider variables.
   * If no API key is set, falls back to `gemini auth login` OAuth flow.
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
    const apiKey = apiKeyOverride ?? this.apiKey; // null = use OAuth (gemini login)

    const userMessageId = toMessageID(generateId());

    // Ensure session record exists
    await this.sessionsRepo.ensureSession(sessionId, this.toolType);

    const assistantMessageIds: MessageID[] = [];
    let responseText = '';
    let resolvedModel: string | undefined;

    if (!isTauriContext()) {
      console.warn('[FreelyGeminiTool] Not in Tauri context — execution skipped');
      return {
        userMessageId,
        assistantMessageIds: [],
        responseText: '[Gemini execution requires Tauri context]',
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

      const events = await tauriInvoke<GeminiStreamEvent[]>('run_gemini', {
        payload: {
          sessionId,
          prompt,
          taskId,
          permissionMode,
          apiKey, // null → Rust sidecar uses OAuth / GOOGLE_GENAI_API_KEY env
        },
      });

      for (const event of events) {
        if (event.type === 'partial' && event.textChunk) {
          responseText += event.textChunk;
          if (streamingCallbacks) {
            await streamingCallbacks.onStreamChunk(assistantMessageId, event.textChunk);
          }
        }

        if (event.resolvedModel) resolvedModel = event.resolvedModel;
      }

      if (streamingCallbacks) {
        await streamingCallbacks.onStreamEnd(assistantMessageId);
      }

      // Update task model if available
      if (taskId && resolvedModel) {
        await this.tasksService.patch(taskId, { model: resolvedModel });
      }

      assistantMessageIds.push(assistantMessageId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[FreelyGeminiTool] Execution error:', err);
      return {
        userMessageId,
        assistantMessageIds,
        responseText,
        toolType: this.toolType,
        error: errMsg,
      };
    }

    return {
      userMessageId,
      assistantMessageIds,
      responseText,
      toolType: this.toolType,
      model: resolvedModel,
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
    throw new Error('normalizedSdkResponse() is deprecated — not implemented in FreelyGeminiTool');
  }
}
