import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSTT } from "../stt.function";
import type { STTParams, AudioSource } from "../stt.function";
import type { SpeakerLabel } from "@/types/completion";
import type { ChatMessage } from "@/types/completion";
import type { TYPE_PROVIDER } from "@/types";

// ---------------------------------------------------------------------------
// Module mocks (same pattern as stt.function.test.ts)
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

vi.mock("@bany/curl-to-json", () => ({
  default: vi.fn(),
}));

import curl2Json from "@bany/curl-to-json";

const mockCurl2Json = vi.mocked(curl2Json);

// ---------------------------------------------------------------------------
// Speaker label mapping (mirrors useSystemAudio.ts logic)
// ---------------------------------------------------------------------------

/**
 * Maps an AudioSource to the appropriate SpeakerLabel.
 * - system_audio → "interviewer" (the other person being listened to)
 * - mic          → "user"        (the local user speaking)
 */
function mapSourceToSpeaker(source: AudioSource): SpeakerLabel {
  return source === "system_audio" ? "interviewer" : "user";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlob(content = "audio-data", type = "audio/wav"): Blob {
  return new Blob([content], { type });
}

function makeProvider(overrides: Partial<TYPE_PROVIDER> = {}): TYPE_PROVIDER {
  return {
    curl: `curl -X POST "https://api.example.com/transcribe" -H "Authorization: Bearer {{API_KEY}}"`,
    responseContentPath: "text",
    ...overrides,
  };
}

function makeSelectedProvider(
  variables: Record<string, string> = { API_KEY: "test-key" }
) {
  return { provider: "example", variables };
}

function makeResponse(body: string, status = 200, statusText = "OK"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockResolvedValue(JSON.parse(body)),
  } as unknown as Response;
}

const DEFAULT_CURL_JSON = {
  url: "https://api.example.com/transcribe",
  origin: "https://api.example.com",
  method: "POST",
  header: { Authorization: "Bearer test-key" },
  form: {},
  data: { audio: "{{AUDIO}}" },
  params: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("STTResult source metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurl2Json.mockReturnValue(DEFAULT_CURL_JSON);
    global.fetch = vi.fn().mockResolvedValue(
      makeResponse(JSON.stringify({ text: "hello world" }))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("source field passes through fetchSTT", () => {
    it('returns source "mic" when source param is "mic"', async () => {
      const params: STTParams = {
        provider: makeProvider(),
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
        source: "mic",
      };

      const result = await fetchSTT(params);

      expect(result.source).toBe("mic");
    });

    it('returns source "system_audio" when source param is "system_audio"', async () => {
      const params: STTParams = {
        provider: makeProvider(),
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
        source: "system_audio",
      };

      const result = await fetchSTT(params);

      expect(result.source).toBe("system_audio");
    });

    it('defaults source to "mic" when source param is omitted', async () => {
      const params: STTParams = {
        provider: makeProvider(),
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
        // source intentionally omitted
      };

      const result = await fetchSTT(params);

      expect(result.source).toBe("mic");
    });

    it("returns a valid numeric timestamp", async () => {
      const before = Date.now();

      const result = await fetchSTT({
        provider: makeProvider(),
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
      });

      const after = Date.now();

      expect(typeof result.timestamp).toBe("number");
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(after);
    });

    it("includes the transcription text in the result", async () => {
      const result = await fetchSTT({
        provider: makeProvider(),
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
      });

      expect(result.text).toBe("hello world");
    });
  });
});

describe("Speaker label mapping", () => {
  it('maps "system_audio" to speakerLabel "interviewer"', () => {
    expect(mapSourceToSpeaker("system_audio")).toBe("interviewer");
  });

  it('maps "mic" to speakerLabel "user"', () => {
    expect(mapSourceToSpeaker("mic")).toBe("user");
  });

  it("covers all AudioSource values", () => {
    const sources: AudioSource[] = ["mic", "system_audio"];
    const labels = sources.map(mapSourceToSpeaker);

    expect(labels).toContain("user");
    expect(labels).toContain("interviewer");
  });

  it("never returns an undefined or null label", () => {
    const sources: AudioSource[] = ["mic", "system_audio"];
    for (const source of sources) {
      const label = mapSourceToSpeaker(source);
      expect(label).toBeDefined();
      expect(label).not.toBeNull();
    }
  });
});

describe("ChatMessage type compliance", () => {
  it("accepts audioSource and speakerLabel as optional fields", () => {
    const msg: ChatMessage = {
      id: "msg-1",
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
      audioSource: "system_audio",
      speakerLabel: "interviewer",
    };

    expect(msg.audioSource).toBe("system_audio");
    expect(msg.speakerLabel).toBe("interviewer");
  });

  it("is valid without audioSource and speakerLabel (backward compatible)", () => {
    const msg: ChatMessage = {
      id: "msg-2",
      role: "assistant",
      content: "Response",
      timestamp: Date.now(),
    };

    expect(msg.audioSource).toBeUndefined();
    expect(msg.speakerLabel).toBeUndefined();
  });

  it('allows mic source with "user" speaker label', () => {
    const msg: ChatMessage = {
      id: "msg-3",
      role: "user",
      content: "My question",
      timestamp: Date.now(),
      audioSource: "mic",
      speakerLabel: "user",
    };

    expect(msg.audioSource).toBe("mic");
    expect(msg.speakerLabel).toBe("user");
  });

  it("speaker label derived from source matches expected mapping", () => {
    const source: AudioSource = "system_audio";
    const label = mapSourceToSpeaker(source);

    const msg: ChatMessage = {
      id: "msg-4",
      role: "user",
      content: "Interviewer speech",
      timestamp: Date.now(),
      audioSource: source,
      speakerLabel: label,
    };

    expect(msg.speakerLabel).toBe("interviewer");
  });
});
