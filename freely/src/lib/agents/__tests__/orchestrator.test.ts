import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FreelyAgentOrchestrator,
  AGENT_PROVIDER_IDS,
} from '../orchestrator.js';
import { createStorageAdapter } from '../storage-adapter.js';

// Helper to drain an async generator into an array
async function collectAll<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) results.push(item);
  return results;
}

// ============================================================================
// AGENT_PROVIDER_IDS
// ============================================================================

describe('AGENT_PROVIDER_IDS', () => {
  it('includes claude-code', () => {
    expect(AGENT_PROVIDER_IDS).toContain('claude-code');
  });

  it('includes codex', () => {
    expect(AGENT_PROVIDER_IDS).toContain('codex');
  });

  it('includes gemini-sdk', () => {
    expect(AGENT_PROVIDER_IDS).toContain('gemini-sdk');
  });

  it('has exactly three providers', () => {
    expect(AGENT_PROVIDER_IDS).toHaveLength(3);
  });
});

// ============================================================================
// isAgentProvider
// ============================================================================

describe('FreelyAgentOrchestrator.isAgentProvider', () => {
  let orchestrator: FreelyAgentOrchestrator;

  beforeEach(() => {
    localStorage.clear();
    orchestrator = new FreelyAgentOrchestrator(createStorageAdapter());
  });

  it('returns true for "claude-code"', () => {
    expect(orchestrator.isAgentProvider('claude-code')).toBe(true);
  });

  it('returns true for "codex"', () => {
    expect(orchestrator.isAgentProvider('codex')).toBe(true);
  });

  it('returns true for "gemini-sdk"', () => {
    expect(orchestrator.isAgentProvider('gemini-sdk')).toBe(true);
  });

  it('returns false for unknown providers', () => {
    expect(orchestrator.isAgentProvider('openai')).toBe(false);
    expect(orchestrator.isAgentProvider('gpt-4')).toBe(false);
    expect(orchestrator.isAgentProvider('')).toBe(false);
    expect(orchestrator.isAgentProvider('claude')).toBe(false);
  });
});

// ============================================================================
// execute — routing and non-Tauri paths
// ============================================================================

describe('FreelyAgentOrchestrator.execute', () => {
  let orchestrator: FreelyAgentOrchestrator;

  beforeEach(() => {
    localStorage.clear();
    delete (window as any).__TAURI_INTERNALS__;
    orchestrator = new FreelyAgentOrchestrator(createStorageAdapter());
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  describe('claude-code', () => {
    it('yields nothing and completes cleanly in non-Tauri context', async () => {
      const chunks = await collectAll(
        orchestrator.execute({ toolType: 'claude-code', userMessage: 'Hello!' })
      );
      expect(chunks).toEqual([]);
    });

    it('respects an already-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort();
      const chunks = await collectAll(
        orchestrator.execute({
          toolType: 'claude-code',
          userMessage: 'Hello!',
          signal: controller.signal,
        })
      );
      expect(chunks).toEqual([]);
    });

    it('streams chunks when Tauri context is available', async () => {
      const mockInvoke = vi.fn().mockResolvedValue([
        { type: 'partial', textChunk: 'Hello' },
        { type: 'partial', textChunk: ' world' },
        { type: 'complete' },
      ]);
      (window as any).__TAURI_INTERNALS__ = { invoke: mockInvoke };

      const chunks = await collectAll(
        orchestrator.execute({ toolType: 'claude-code', userMessage: 'Test prompt' })
      );
      expect(chunks).toEqual(['Hello', ' world']);
    });

    it('propagates tool errors as thrown errors from the generator', async () => {
      // Tool catches invoke errors and returns result.error — orchestrator wraps it
      const mockInvoke = vi.fn().mockRejectedValue(new Error('Tauri error'));
      (window as any).__TAURI_INTERNALS__ = { invoke: mockInvoke };

      await expect(
        collectAll(orchestrator.execute({ toolType: 'claude-code', userMessage: 'Test' }))
      ).rejects.toThrow('Tauri error');
    });
  });

  describe('codex', () => {
    it('throws OPENAI_API_KEY error when no key is set', async () => {
      await expect(
        collectAll(orchestrator.execute({ toolType: 'codex', userMessage: 'Hello!' }))
      ).rejects.toThrow('OPENAI_API_KEY is required');
    });

    it('yields nothing for codex with API key in non-Tauri context', async () => {
      localStorage.setItem('freely_provider_var_OPENAI_API_KEY', 'sk-test');
      const chunks = await collectAll(
        orchestrator.execute({ toolType: 'codex', userMessage: 'Hello!' })
      );
      expect(chunks).toEqual([]);
    });

    it('passes the orchestrator-level API key check when apiKey param is provided', async () => {
      // The orchestrator's own check uses params.apiKey, so it does NOT throw
      // immediately. The apiKey is now forwarded as apiKeyOverride to the tool,
      // so the tool also succeeds. In non-Tauri context the tool returns a
      // placeholder result and the generator yields nothing.
      const chunks = await collectAll(
        orchestrator.execute({
          toolType: 'codex',
          userMessage: 'Hello!',
          apiKey: 'sk-direct',
        })
      );
      expect(chunks).toEqual([]);
    });
  });

  describe('gemini-sdk', () => {
    it('yields nothing and completes cleanly in non-Tauri context', async () => {
      const chunks = await collectAll(
        orchestrator.execute({ toolType: 'gemini-sdk', userMessage: 'Hello!' })
      );
      expect(chunks).toEqual([]);
    });

    it('streams chunks when Tauri context is available', async () => {
      const mockInvoke = vi.fn().mockResolvedValue([
        { type: 'partial', textChunk: 'Gemini ' },
        { type: 'partial', textChunk: 'response' },
        { type: 'complete' },
      ]);
      (window as any).__TAURI_INTERNALS__ = { invoke: mockInvoke };

      const chunks = await collectAll(
        orchestrator.execute({ toolType: 'gemini-sdk', userMessage: 'Hello!' })
      );
      expect(chunks).toEqual(['Gemini ', 'response']);
    });
  });
});

// ============================================================================
// getAvailableTools
// ============================================================================

describe('FreelyAgentOrchestrator.getAvailableTools', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as any).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('returns false for all tools in non-Tauri context', async () => {
    const orchestrator = new FreelyAgentOrchestrator(createStorageAdapter());
    const tools = await orchestrator.getAvailableTools();
    expect(tools['claude-code']).toBe(false);
    expect(tools['codex']).toBe(false);
    expect(tools['gemini-sdk']).toBe(false);
  });

  it('returns true for tools reported installed by Tauri', async () => {
    const mockInvoke = vi
      .fn()
      .mockResolvedValue({ installed: true });
    (window as any).__TAURI_INTERNALS__ = { invoke: mockInvoke };

    const orchestrator = new FreelyAgentOrchestrator(createStorageAdapter());
    const tools = await orchestrator.getAvailableTools();
    expect(tools['claude-code']).toBe(true);
    expect(tools['codex']).toBe(true);
    expect(tools['gemini-sdk']).toBe(true);
  });
});
