import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDeepgramStreaming } from "../useDeepgramStreaming";

// ---------------------------------------------------------------------------
// Minimal WebSocket mock
// ---------------------------------------------------------------------------

type WsListener = (event: any) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  // Mirror the standard WebSocket ready-state constants
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  protocols: string | string[];
  readyState: number = WebSocket.CONNECTING;

  onopen: WsListener | null = null;
  onmessage: WsListener | null = null;
  onclose: WsListener | null = null;
  onerror: WsListener | null = null;

  sentMessages: any[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols ?? [];
    MockWebSocket.instances.push(this);
  }

  send(data: any) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
  }

  // Test helpers to simulate server events
  simulateOpen() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.({ type: "open" });
  }

  simulateMessage(data: object) {
    this.onmessage?.({ type: "message", data: JSON.stringify(data) });
  }

  simulateClose(wasClean = false, code = 1006) {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ type: "close", wasClean, code });
  }

  simulateError() {
    this.onerror?.({ type: "error" });
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let OriginalWebSocket: typeof WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  OriginalWebSocket = window.WebSocket;
  (window as any).WebSocket = MockWebSocket;
  vi.useFakeTimers();
});

afterEach(() => {
  (window as any).WebSocket = OriginalWebSocket;
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Default props factory
// ---------------------------------------------------------------------------

function defaultProps(overrides: Partial<Parameters<typeof useDeepgramStreaming>[0]> = {}) {
  return {
    apiKey: "test-api-key",
    model: "nova-2",
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function latestWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

function resultsMessage(transcript: string, isFinal: boolean, speechFinal = false) {
  return {
    type: "Results",
    is_final: isFinal,
    speech_final: speechFinal,
    channel: { alternatives: [{ transcript }] },
  };
}

// ---------------------------------------------------------------------------
// Tests: Connection lifecycle
// ---------------------------------------------------------------------------

describe("useDeepgramStreaming – connection lifecycle", () => {
  it("opens a WebSocket when enabled=true", () => {
    const props = defaultProps();
    renderHook(() => useDeepgramStreaming(props));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(latestWs().url).toContain("wss://api.deepgram.com/v1/listen");
  });

  it("passes the API key as a protocol", () => {
    const props = defaultProps({ apiKey: "my-secret-key" });
    renderHook(() => useDeepgramStreaming(props));

    expect(latestWs().protocols).toContain("my-secret-key");
  });

  it("includes expected query parameters in the URL", () => {
    const props = defaultProps({ model: "nova-2" });
    renderHook(() => useDeepgramStreaming(props));

    const url = latestWs().url;
    expect(url).toContain("encoding=linear16");
    expect(url).toContain("sample_rate=16000");
    expect(url).toContain("interim_results=true");
    expect(url).toContain("model=nova-2");
  });

  it("reflects isConnected=true after WebSocket opens", async () => {
    const props = defaultProps();
    const { result } = renderHook(() => useDeepgramStreaming(props));

    act(() => latestWs().simulateOpen());

    expect(result.current.isConnected).toBe(true);
  });

  it("does not open a WebSocket when enabled=false", () => {
    const props = defaultProps({ enabled: false });
    renderHook(() => useDeepgramStreaming(props));

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("closes the socket when enabled toggles false", async () => {
    const props = defaultProps({ enabled: true });
    const { result, rerender } = renderHook(
      (p: Parameters<typeof useDeepgramStreaming>[0]) => useDeepgramStreaming(p),
      { initialProps: props }
    );

    act(() => latestWs().simulateOpen());
    expect(result.current.isConnected).toBe(true);

    act(() => {
      rerender({ ...props, enabled: false });
    });

    expect(result.current.isConnected).toBe(false);
  });

  it("sends CloseStream when intentionally closing an open socket", () => {
    const props = defaultProps();
    const { rerender } = renderHook(
      (p: Parameters<typeof useDeepgramStreaming>[0]) => useDeepgramStreaming(p),
      { initialProps: props }
    );

    act(() => latestWs().simulateOpen());

    act(() => {
      rerender({ ...props, enabled: false });
    });

    const sent = latestWs().sentMessages.map((m) =>
      typeof m === "string" ? JSON.parse(m) : m
    );
    expect(sent).toContainEqual({ type: "CloseStream" });
  });

  it("cleans up on unmount: nulls out socket handlers and calls close", () => {
    const props = defaultProps();
    const { unmount } = renderHook(() => useDeepgramStreaming(props));
    const ws = latestWs();
    act(() => ws.simulateOpen());

    act(() => unmount());

    expect(ws.onopen).toBeNull();
    expect(ws.onmessage).toBeNull();
    expect(ws.onclose).toBeNull();
    expect(ws.onerror).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: Float32 → Int16 PCM conversion
// ---------------------------------------------------------------------------

describe("useDeepgramStreaming – PCM conversion", () => {
  it("sends an ArrayBuffer via sendPcmFrame when connected", () => {
    const props = defaultProps();
    const { result } = renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    const frame = new Float32Array([0.0, 1.0, -1.0]);
    act(() => result.current.sendPcmFrame(frame));

    expect(latestWs().sentMessages).toHaveLength(1);
    expect(latestWs().sentMessages[0]).toBeInstanceOf(ArrayBuffer);
  });

  it("converts 0.0 → 0 in Int16", () => {
    const props = defaultProps();
    const { result } = renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => result.current.sendPcmFrame(new Float32Array([0.0])));

    const buf = latestWs().sentMessages[0] as ArrayBuffer;
    const view = new Int16Array(buf);
    expect(view[0]).toBe(0);
  });

  it("converts 1.0 → 32767 in Int16", () => {
    const props = defaultProps();
    const { result } = renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => result.current.sendPcmFrame(new Float32Array([1.0])));

    const buf = latestWs().sentMessages[0] as ArrayBuffer;
    const view = new Int16Array(buf);
    expect(view[0]).toBe(0x7fff); // 32767
  });

  it("converts -1.0 → -32768 in Int16", () => {
    const props = defaultProps();
    const { result } = renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => result.current.sendPcmFrame(new Float32Array([-1.0])));

    const buf = latestWs().sentMessages[0] as ArrayBuffer;
    const view = new Int16Array(buf);
    expect(view[0]).toBe(-0x8000); // -32768
  });

  it("clamps values beyond [-1, 1] range", () => {
    const props = defaultProps();
    const { result } = renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => result.current.sendPcmFrame(new Float32Array([2.0, -3.0])));

    const buf = latestWs().sentMessages[0] as ArrayBuffer;
    const view = new Int16Array(buf);
    expect(view[0]).toBe(0x7fff); // clamped to 1.0
    expect(view[1]).toBe(-0x8000); // clamped to -1.0
  });

  it("does not send when socket is not open", () => {
    const props = defaultProps();
    const { result } = renderHook(() => useDeepgramStreaming(props));
    // do NOT call simulateOpen — socket stays CONNECTING

    act(() => result.current.sendPcmFrame(new Float32Array([0.5])));

    expect(latestWs().sentMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Transcript accumulation
// ---------------------------------------------------------------------------

describe("useDeepgramStreaming – transcript accumulation", () => {
  it("calls onInterimTranscript for non-final results", () => {
    const props = defaultProps();
    const { result } = renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => latestWs().simulateMessage(resultsMessage("hello", false)));

    expect(props.onInterimTranscript).toHaveBeenCalledWith("hello");
    expect(props.onFinalTranscript).not.toHaveBeenCalled();
  });

  it("does not call onFinalTranscript for final-but-not-speech_final results", () => {
    const props = defaultProps();
    renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    // is_final=true but speech_final=false: accumulates segment, no callback yet
    act(() => latestWs().simulateMessage(resultsMessage("hello", true, false)));

    expect(props.onFinalTranscript).not.toHaveBeenCalled();
  });

  it("calls onFinalTranscript with joined segments on speech_final", () => {
    const props = defaultProps();
    renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => {
      latestWs().simulateMessage(resultsMessage("hello", true, false));
      latestWs().simulateMessage(resultsMessage("world", true, true));
    });

    expect(props.onFinalTranscript).toHaveBeenCalledWith("hello world");
  });

  it("resets accumulated segments after speech_final", () => {
    const props = defaultProps();
    renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => {
      latestWs().simulateMessage(resultsMessage("first", true, true));
    });

    act(() => {
      latestWs().simulateMessage(resultsMessage("second", true, true));
    });

    // second call should only contain "second", not "first second"
    expect(props.onFinalTranscript).toHaveBeenNthCalledWith(2, "second");
  });

  it("ignores non-Results message types", () => {
    const props = defaultProps();
    renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => {
      latestWs().simulateMessage({ type: "Metadata" });
      latestWs().simulateMessage({ type: "SpeechStarted" });
    });

    expect(props.onInterimTranscript).not.toHaveBeenCalled();
    expect(props.onFinalTranscript).not.toHaveBeenCalled();
  });

  it("ignores Results messages with empty transcript", () => {
    const props = defaultProps();
    renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => {
      latestWs().simulateMessage(resultsMessage("", false));
      latestWs().simulateMessage(resultsMessage("", true, true));
    });

    expect(props.onInterimTranscript).not.toHaveBeenCalled();
    expect(props.onFinalTranscript).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: finalize()
// ---------------------------------------------------------------------------

describe("useDeepgramStreaming – finalize", () => {
  it("sends a Finalize message when connected", () => {
    const props = defaultProps();
    const { result } = renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => result.current.finalize());

    const sent = latestWs().sentMessages.map((m) =>
      typeof m === "string" ? JSON.parse(m) : m
    );
    expect(sent).toContainEqual({ type: "Finalize" });
  });

  it("does not throw when called while not connected", () => {
    const props = defaultProps();
    const { result } = renderHook(() => useDeepgramStreaming(props));
    // socket is CONNECTING — not open

    expect(() => act(() => result.current.finalize())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: Keepalive
// ---------------------------------------------------------------------------

describe("useDeepgramStreaming – keepalive", () => {
  it("sends KeepAlive after 8 seconds", () => {
    const props = defaultProps();
    renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => vi.advanceTimersByTime(8000));

    const sent = latestWs().sentMessages
      .filter((m) => typeof m === "string")
      .map((m) => JSON.parse(m));
    expect(sent).toContainEqual({ type: "KeepAlive" });
  });

  it("sends multiple KeepAlive messages over time", () => {
    const props = defaultProps();
    renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => vi.advanceTimersByTime(24000)); // 3 intervals

    const keepAlives = latestWs().sentMessages
      .filter((m) => typeof m === "string")
      .map((m) => JSON.parse(m))
      .filter((m) => m.type === "KeepAlive");
    expect(keepAlives.length).toBeGreaterThanOrEqual(3);
  });

  it("stops sending KeepAlive after disconnect", () => {
    const props = defaultProps();
    const { rerender } = renderHook(
      (p: Parameters<typeof useDeepgramStreaming>[0]) => useDeepgramStreaming(p),
      { initialProps: props }
    );
    const ws = latestWs();
    act(() => ws.simulateOpen());

    act(() => {
      rerender({ ...props, enabled: false });
    });

    const countBefore = ws.sentMessages.filter(
      (m) => typeof m === "string" && JSON.parse(m).type === "KeepAlive"
    ).length;

    act(() => vi.advanceTimersByTime(16000));

    const countAfter = ws.sentMessages.filter(
      (m) => typeof m === "string" && JSON.parse(m).type === "KeepAlive"
    ).length;

    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// Tests: Reconnection
// ---------------------------------------------------------------------------

describe("useDeepgramStreaming – reconnection", () => {
  it("reconnects on unexpected close (wasClean=false) while enabled", async () => {
    const props = defaultProps();
    renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => latestWs().simulateClose(false)); // unexpected close

    // Advance past RECONNECT_DELAY_MS (1000ms)
    act(() => vi.advanceTimersByTime(1100));

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("does not reconnect on clean close (wasClean=true)", () => {
    const props = defaultProps();
    renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    act(() => latestWs().simulateClose(true));

    act(() => vi.advanceTimersByTime(2000));

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("does not reconnect if disabled before reconnect timer fires", () => {
    const props = defaultProps({ enabled: true });
    const { rerender } = renderHook(
      (p: Parameters<typeof useDeepgramStreaming>[0]) => useDeepgramStreaming(p),
      { initialProps: props }
    );
    act(() => latestWs().simulateOpen());

    // Simulate unexpected close
    act(() => latestWs().simulateClose(false));

    // Disable before timer fires
    act(() => rerender({ ...props, enabled: false }));

    act(() => vi.advanceTimersByTime(2000));

    // Should not have created a new socket beyond the original
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("stops reconnecting after MAX_RECONNECT_RETRIES (3)", () => {
    const props = defaultProps();
    renderHook(() => useDeepgramStreaming(props));
    act(() => latestWs().simulateOpen());

    // Simulate 4 unexpected closes in succession
    for (let i = 0; i < 4; i++) {
      act(() => latestWs().simulateClose(false));
      act(() => vi.advanceTimersByTime(1100));
    }

    // Initial connect + 3 retries max = 4 instances total
    expect(MockWebSocket.instances.length).toBeLessThanOrEqual(4);
  });
});
