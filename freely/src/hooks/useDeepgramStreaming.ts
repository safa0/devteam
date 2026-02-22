import { useCallback, useEffect, useRef, useState } from "react";

interface UseDeepgramStreamingOptions {
  apiKey: string;
  model: string;
  onInterimTranscript: (text: string) => void;
  onFinalTranscript: (text: string) => void;
  enabled: boolean;
}

interface UseDeepgramStreamingReturn {
  sendPcmFrame: (frame: Float32Array) => void;
  finalize: () => void;
  isConnected: boolean;
}

const MAX_RECONNECT_RETRIES = 3;
const KEEPALIVE_INTERVAL_MS = 8000;
const RECONNECT_DELAY_MS = 1000;

export function useDeepgramStreaming({
  apiKey,
  model,
  onInterimTranscript,
  onFinalTranscript,
  enabled,
}: UseDeepgramStreamingOptions): UseDeepgramStreamingReturn {
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retriesRef = useRef(0);
  const finalSegmentsRef = useRef<string[]>([]);
  const enabledRef = useRef(enabled);
  const callbacksRef = useRef({ onInterimTranscript, onFinalTranscript });

  // Keep refs in sync with latest props
  enabledRef.current = enabled;
  callbacksRef.current = { onInterimTranscript, onFinalTranscript };

  const clearKeepAlive = useCallback(() => {
    if (keepAliveRef.current) {
      clearInterval(keepAliveRef.current);
      keepAliveRef.current = null;
    }
  }, []);

  const closeSocket = useCallback(() => {
    clearKeepAlive();
    const ws = wsRef.current;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
        }
      } catch {
        // ignore send errors during cleanup
      }
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  }, [clearKeepAlive]);

  const connect = useCallback(() => {
    if (!apiKey || !enabledRef.current) return;

    // Clean up any existing connection
    closeSocket();

    const params = new URLSearchParams({
      model: model || "nova-2",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      smart_format: "true",
      punctuate: "true",
      interim_results: "true",
      endpointing: "300",
    });

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    const ws = new WebSocket(url, ["token", apiKey]);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      retriesRef.current = 0;

      // Start keepalive
      keepAliveRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, KEEPALIVE_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type !== "Results") return;

        const transcript =
          msg.channel?.alternatives?.[0]?.transcript ?? "";
        if (!transcript) return;

        if (!msg.is_final) {
          callbacksRef.current.onInterimTranscript(transcript);
        } else {
          finalSegmentsRef.current.push(transcript);
          if (msg.speech_final) {
            const joined = finalSegmentsRef.current.join(" ");
            finalSegmentsRef.current = [];
            callbacksRef.current.onFinalTranscript(joined);
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = (event) => {
      clearKeepAlive();
      setIsConnected(false);
      wsRef.current = null;

      // Reconnect on unexpected close if still enabled
      if (
        !event.wasClean &&
        enabledRef.current &&
        retriesRef.current < MAX_RECONNECT_RETRIES
      ) {
        retriesRef.current += 1;
        setTimeout(() => {
          if (enabledRef.current) connect();
        }, RECONNECT_DELAY_MS);
      }
    };

    ws.onerror = () => {
      // onclose will fire after this — reconnect logic lives there
    };
  }, [apiKey, model, closeSocket, clearKeepAlive]);

  // Connect/disconnect based on `enabled`
  useEffect(() => {
    if (enabled) {
      retriesRef.current = 0;
      connect();
    } else {
      closeSocket();
      finalSegmentsRef.current = [];
    }
    return () => {
      closeSocket();
      finalSegmentsRef.current = [];
    };
  }, [enabled, connect, closeSocket]);

  const sendPcmFrame = useCallback((frame: Float32Array) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Convert Float32 [-1,1] → Int16 PCM
    const pcm = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      const s = Math.max(-1, Math.min(1, frame[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    ws.send(pcm.buffer);
  }, []);

  const finalize = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "Finalize" }));
    }
  }, []);

  return { sendPcmFrame, finalize, isConnected };
}
