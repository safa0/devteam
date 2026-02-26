import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSTT } from "../stt.function";
import type { STTParams } from "../stt.function";
import type { TYPE_PROVIDER } from "@/types";

// ---------------------------------------------------------------------------
// Module mocks
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
// Polyfill Blob.arrayBuffer for jsdom
// ---------------------------------------------------------------------------
if (typeof Blob.prototype.arrayBuffer === "undefined") {
  Blob.prototype.arrayBuffer = function (): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(this);
    });
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlob(content = "audio-data", type = "audio/wav"): Blob {
  return new Blob([content], { type });
}

function makeFile(content = "audio-data", name = "test.wav", type = "audio/wav"): File {
  return new File([content], name, { type });
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

/** Build a mock Response object. Handles non-JSON body gracefully. */
function makeResponse(body: string, status = 200, statusText = "OK"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// Default curl2Json output for a simple POST (no form/binary flags)
const DEFAULT_CURL_JSON = {
  url: "https://api.example.com/transcribe",
  origin: "https://api.example.com",
  method: "POST",
  header: { Authorization: "Bearer test-key" },
  form: {},
  data: { audio: "{{AUDIO}}" },
  params: {},
};

// curl2Json output for a form-based provider (OpenAI Whisper style)
const FORM_CURL_JSON = {
  url: "https://api.openai.com/v1/audio/transcriptions",
  origin: "https://api.openai.com",
  method: "POST",
  header: { Authorization: "Bearer test-key" },
  form: { model: "whisper-1" },
  data: {},
  params: {},
};

// curl2Json output for a binary-upload provider (Deepgram style)
const BINARY_CURL_JSON = {
  url: "https://api.deepgram.com/v1/listen",
  origin: "https://api.deepgram.com",
  method: "POST",
  header: {
    Authorization: "Token test-key",
    "Content-Type": "audio/wav",
  },
  form: {},
  data: {},
  params: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchSTT", () => {
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

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe("validation", () => {
    it("throws when provider is null", async () => {
      const params: STTParams = {
        provider: null as unknown as TYPE_PROVIDER,
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
      };
      await expect(fetchSTT(params)).rejects.toThrow("Provider not provided");
    });

    it("throws when provider is undefined", async () => {
      const params: STTParams = {
        provider: undefined,
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
      };
      await expect(fetchSTT(params)).rejects.toThrow("Provider not provided");
    });

    it("throws when selectedProvider is null", async () => {
      const params: STTParams = {
        provider: makeProvider(),
        selectedProvider: null as unknown as STTParams["selectedProvider"],
        audio: makeBlob(),
      };
      await expect(fetchSTT(params)).rejects.toThrow(
        "Selected provider not provided"
      );
    });

    it("throws when selectedProvider is undefined", async () => {
      const params: STTParams = {
        provider: makeProvider(),
        selectedProvider: undefined as unknown as STTParams["selectedProvider"],
        audio: makeBlob(),
      };
      await expect(fetchSTT(params)).rejects.toThrow(
        "Selected provider not provided"
      );
    });

    it("throws when audio is null", async () => {
      const params: STTParams = {
        provider: makeProvider(),
        selectedProvider: makeSelectedProvider(),
        audio: null as unknown as Blob,
      };
      await expect(fetchSTT(params)).rejects.toThrow("Audio file is required");
    });

    it("throws when audio is undefined", async () => {
      const params: STTParams = {
        provider: makeProvider(),
        selectedProvider: makeSelectedProvider(),
        audio: undefined as unknown as Blob,
      };
      await expect(fetchSTT(params)).rejects.toThrow("Audio file is required");
    });

    it("throws when audio blob has size 0", async () => {
      const params: STTParams = {
        provider: makeProvider(),
        selectedProvider: makeSelectedProvider(),
        audio: new Blob([], { type: "audio/wav" }),
      };
      await expect(fetchSTT(params)).rejects.toThrow("Audio file is empty");
    });
  });

  // -------------------------------------------------------------------------
  // Form-based provider (OpenAI Whisper pattern: -F flag)
  // -------------------------------------------------------------------------

  describe("form-based provider (OpenAI Whisper style)", () => {
    it("sends FormData body when curl contains -F flag", async () => {
      mockCurl2Json.mockReturnValue(FORM_CURL_JSON);
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(JSON.stringify({ text: "transcribed text" }))
      );

      const provider = makeProvider({
        curl: `curl -X POST "https://api.openai.com/v1/audio/transcriptions" -H "Authorization: Bearer {{API_KEY}}" -F model=whisper-1 -F file=@audio.wav`,
        responseContentPath: "text",
      });

      await fetchSTT({
        provider,
        selectedProvider: makeSelectedProvider(),
        audio: makeFile(),
      });

      expect(global.fetch).toHaveBeenCalledOnce();
      const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(options.body).toBeInstanceOf(FormData);
    });

    it("appends file field to FormData", async () => {
      mockCurl2Json.mockReturnValue(FORM_CURL_JSON);
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(JSON.stringify({ text: "transcribed text" }))
      );

      const provider = makeProvider({
        curl: `curl -X POST "https://api.openai.com/v1/audio/transcriptions" -H "Authorization: Bearer {{API_KEY}}" -F model=whisper-1 -F file=@audio.wav`,
      });

      await fetchSTT({
        provider,
        selectedProvider: makeSelectedProvider(),
        audio: makeFile(),
      });

      const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const fd = options.body as FormData;
      expect(fd.has("file")).toBe(true);
    });

    it("extracts transcription text via responseContentPath", async () => {
      mockCurl2Json.mockReturnValue(FORM_CURL_JSON);
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(JSON.stringify({ text: "hello whisper" }))
      );

      const provider = makeProvider({
        curl: `curl -X POST "https://api.openai.com/v1/audio/transcriptions" -H "Authorization: Bearer {{API_KEY}}" -F model=whisper-1`,
        responseContentPath: "text",
      });

      const result = await fetchSTT({
        provider,
        selectedProvider: makeSelectedProvider(),
        audio: makeFile(),
      });

      expect(result.text).toBe("hello whisper");
    });
  });

  // -------------------------------------------------------------------------
  // Binary upload (Deepgram pattern: --data-binary)
  // -------------------------------------------------------------------------

  describe("binary upload provider (Deepgram style)", () => {
    it("sends raw Blob body when curl contains --data-binary", async () => {
      mockCurl2Json.mockReturnValue(BINARY_CURL_JSON);
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(
          JSON.stringify({
            results: { channels: [{ alternatives: [{ transcript: "deepgram text" }] }] },
          })
        )
      );

      const provider = makeProvider({
        curl: `curl -X POST "https://api.deepgram.com/v1/listen" -H "Authorization: Token {{API_KEY}}" -H "Content-Type: audio/wav" --data-binary @audio.wav`,
        responseContentPath: "results.channels[0].alternatives[0].transcript",
      });

      await fetchSTT({
        provider,
        selectedProvider: makeSelectedProvider(),
        audio: makeFile(),
      });

      expect(global.fetch).toHaveBeenCalledOnce();
      const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(options.body).toBeInstanceOf(Blob);
    });

    it("sends correct Content-Type header from curl", async () => {
      mockCurl2Json.mockReturnValue(BINARY_CURL_JSON);
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(
          JSON.stringify({
            results: { channels: [{ alternatives: [{ transcript: "ok" }] }] },
          })
        )
      );

      const provider = makeProvider({
        curl: `curl -X POST "https://api.deepgram.com/v1/listen" -H "Authorization: Token {{API_KEY}}" -H "Content-Type: audio/wav" --data-binary @audio.wav`,
        responseContentPath: "results.channels[0].alternatives[0].transcript",
      });

      await fetchSTT({
        provider,
        selectedProvider: makeSelectedProvider(),
        audio: makeFile(),
      });

      const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(options.headers).toMatchObject({ "Content-Type": "audio/wav" });
    });
  });

  // -------------------------------------------------------------------------
  // JSON / base64 body (Google STT pattern)
  // -------------------------------------------------------------------------

  describe("JSON/base64 provider (Google STT style)", () => {
    it("sends JSON body with base64-encoded audio when no -F or --data-binary", async () => {
      mockCurl2Json.mockReturnValue({
        ...DEFAULT_CURL_JSON,
        data: { audio: "{{AUDIO}}", encoding: "LINEAR16" },
      });
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(JSON.stringify({ text: "google stt result" }))
      );

      const provider = makeProvider({
        curl: `curl -X POST "https://api.example.com/transcribe" -H "Authorization: Bearer {{API_KEY}}"`,
        responseContentPath: "text",
      });

      await fetchSTT({
        provider,
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob("audio-bytes"),
      });

      expect(global.fetch).toHaveBeenCalledOnce();
      const [, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(typeof options.body).toBe("string");
      const parsed = JSON.parse(options.body as string);
      // AUDIO placeholder should have been replaced with a base64 string
      expect(typeof parsed.audio).toBe("string");
      expect(parsed.audio.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Response parsing / getByPath extraction
  // -------------------------------------------------------------------------

  describe("response parsing", () => {
    it("extracts transcription with simple path 'text'", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(JSON.stringify({ text: "simple result" }))
      );

      const result = await fetchSTT({
        provider: makeProvider({ responseContentPath: "text" }),
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
      });

      expect(result.text).toBe("simple result");
    });

    it("extracts transcription with nested path 'results[0].alternatives[0].transcript'", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(
          JSON.stringify({
            results: [{ alternatives: [{ transcript: "nested result" }] }],
          })
        )
      );

      const result = await fetchSTT({
        provider: makeProvider({
          responseContentPath: "results[0].alternatives[0].transcript",
        }),
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
      });

      expect(result.text).toBe("nested result");
    });

    it("returns raw text when response body is not valid JSON", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse("plain text response")
      );

      const result = await fetchSTT({
        provider: makeProvider(),
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
      });

      expect(result.text).toBe("plain text response");
    });

    it("returns 'No transcription found' in text when path yields empty string", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(JSON.stringify({ text: "" }))
      );

      const result = await fetchSTT({
        provider: makeProvider({ responseContentPath: "text" }),
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
      });

      expect(result.text).toBe("No transcription found");
    });

    it("uses 'text' as default responseContentPath when not set", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(JSON.stringify({ text: "default path result" }))
      );

      const result = await fetchSTT({
        provider: makeProvider({ responseContentPath: undefined }),
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
      });

      expect(result.text).toBe("default path result");
    });

    it("result includes source and timestamp fields", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(JSON.stringify({ text: "ok" }))
      );

      const before = Date.now();
      const result = await fetchSTT({
        provider: makeProvider(),
        selectedProvider: makeSelectedProvider(),
        audio: makeBlob(),
        source: "mic",
      });
      const after = Date.now();

      expect(result.source).toBe("mic");
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(after);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("throws with status on HTTP 401 response", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(JSON.stringify({ message: "Unauthorized" }), 401, "Unauthorized")
      );

      await expect(
        fetchSTT({
          provider: makeProvider(),
          selectedProvider: makeSelectedProvider(),
          audio: makeBlob(),
        })
      ).rejects.toThrow("HTTP 401");
    });

    it("throws with status on HTTP 500 response", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(
          JSON.stringify({ message: "Internal Server Error" }),
          500,
          "Internal Server Error"
        )
      );

      await expect(
        fetchSTT({
          provider: makeProvider(),
          selectedProvider: makeSelectedProvider(),
          audio: makeBlob(),
        })
      ).rejects.toThrow("HTTP 500");
    });

    it("throws 'Network error: ...' on network failure", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Failed to connect"));

      await expect(
        fetchSTT({
          provider: makeProvider(),
          selectedProvider: makeSelectedProvider(),
          audio: makeBlob(),
        })
      ).rejects.toThrow("Network error: Failed to connect");
    });

    it("throws when curl2Json parsing fails", async () => {
      mockCurl2Json.mockImplementation(() => {
        throw new Error("invalid curl string");
      });

      await expect(
        fetchSTT({
          provider: makeProvider({ curl: "bad curl" }),
          selectedProvider: makeSelectedProvider(),
          audio: makeBlob(),
        })
      ).rejects.toThrow("Failed to parse curl: invalid curl string");
    });

    it("includes plain-text error body in thrown message on HTTP 400", async () => {
      // makeResponse with plain text (not JSON) — use a text that won't be JSON.parse'd
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse("Bad Request plain text", 400, "Bad Request")
      );

      await expect(
        fetchSTT({
          provider: makeProvider(),
          selectedProvider: makeSelectedProvider(),
          audio: makeBlob(),
        })
      ).rejects.toThrow("HTTP 400");
    });
  });

  // -------------------------------------------------------------------------
  // Variable substitution
  // -------------------------------------------------------------------------

  describe("variable substitution", () => {
    it("replaces {{API_KEY}} in URL when present", async () => {
      mockCurl2Json.mockReturnValue({
        ...DEFAULT_CURL_JSON,
        url: "https://api.example.com/transcribe?key={{API_KEY}}",
      });
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(JSON.stringify({ text: "ok" }))
      );

      await fetchSTT({
        provider: makeProvider({
          curl: `curl "https://api.example.com/transcribe?key={{API_KEY}}"`,
        }),
        selectedProvider: makeSelectedProvider({ API_KEY: "my-secret-key" }),
        audio: makeBlob(),
      });

      const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("my-secret-key");
      expect(url).not.toContain("{{API_KEY}}");
    });
  });
});
