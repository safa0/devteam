/**
 * STT Accuracy Benchmark Tests
 *
 * Covers:
 *  1. WER calculator unit tests (always run)
 *  2. Provider benchmark tests using mocked API responses (always run)
 *  3. Live benchmark tests gated by LIVE_STT_BENCHMARK=1 env var
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { calculateWER } from "./wer";
import { fetchSTT } from "../stt.function";
import type { STTParams } from "../stt.function";
import type { TYPE_PROVIDER } from "@/types";
import * as fs from "fs";
import * as path from "path";

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
// 1. WER Calculator Unit Tests
// ---------------------------------------------------------------------------

describe("calculateWER", () => {
  it("returns 0.0 for identical strings", () => {
    expect(calculateWER("hello world", "hello world")).toBe(0.0);
  });

  it("returns high WER for completely different strings", () => {
    const wer = calculateWER("one two three", "alpha beta gamma");
    expect(wer).toBe(1.0); // 3 substitutions / 3 ref words
  });

  it("is case insensitive", () => {
    expect(calculateWER("Hello World", "hello world")).toBe(0.0);
  });

  it("ignores punctuation", () => {
    expect(calculateWER("Hello, world!", "hello world")).toBe(0.0);
  });

  it("handles substitution: 'the cat sat' vs 'the bat sat' → ~0.33", () => {
    const wer = calculateWER("the cat sat", "the bat sat");
    expect(wer).toBeCloseTo(1 / 3, 5);
  });

  it("handles insertion: 'the cat' vs 'the big cat' → ~0.5", () => {
    // ref=2 words, 1 insertion → WER = 1/2
    const wer = calculateWER("the cat", "the big cat");
    expect(wer).toBeCloseTo(0.5, 5);
  });

  it("handles deletion: 'the big cat' vs 'the cat' → ~0.33", () => {
    // ref=3 words, 1 deletion → WER = 1/3
    const wer = calculateWER("the big cat", "the cat");
    expect(wer).toBeCloseTo(1 / 3, 5);
  });

  it("handles empty hypothesis gracefully (all deletions)", () => {
    const wer = calculateWER("hello world", "");
    expect(wer).toBe(1.0); // 2 deletions / 2 ref words
  });

  it("handles empty reference with empty hypothesis → 0.0", () => {
    expect(calculateWER("", "")).toBe(0.0);
  });

  it("handles empty reference with non-empty hypothesis → 1.0", () => {
    expect(calculateWER("", "hello")).toBe(1.0);
  });

  it("handles extra punctuation and whitespace", () => {
    expect(calculateWER("  Hello,   world!  ", "hello world")).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by provider benchmark tests
// ---------------------------------------------------------------------------

function makeBlob(content = "audio-data", type = "audio/wav"): Blob {
  return new Blob([content], { type });
}

function makeProvider(overrides: Partial<TYPE_PROVIDER> = {}): TYPE_PROVIDER {
  return {
    id: "test-provider",
    name: "Test Provider",
    curl: `curl -X POST "https://api.example.com/transcribe" -H "Authorization: Bearer {{API_KEY}}" -F "file=@audio.wav"`,
    responseContentPath: "text",
    variables: [{ name: "API_KEY", value: "" }],
    ...overrides,
  } as unknown as TYPE_PROVIDER;
}

function makeSTTParams(
  provider: TYPE_PROVIDER,
  audio: Blob = makeBlob()
): STTParams {
  return {
    provider,
    selectedProvider: {
      provider: provider.name as string,
      variables: { API_KEY: "test-key" },
    },
    audio,
    source: "mic",
  };
}

// ---------------------------------------------------------------------------
// 2. Provider Benchmark Tests (mocked API responses)
// ---------------------------------------------------------------------------

const EXPECTED_TEXT = "Hello, how are you today?";
const WER_THRESHOLD = 0.1;

type ProviderCase = {
  name: string;
  curlTemplate: string;
  responseContentPath: string;
  mockResponse: object;
  expectedTranscript: string;
};

const providerCases: ProviderCase[] = [
  {
    name: "OpenAI Whisper",
    curlTemplate: `curl -X POST "https://api.openai.com/v1/audio/transcriptions" -H "Authorization: Bearer {{API_KEY}}" -F "file=@audio.wav" -F "model=whisper-1"`,
    responseContentPath: "text",
    mockResponse: { text: "Hello, how are you today?" },
    expectedTranscript: EXPECTED_TEXT,
  },
  {
    name: "Deepgram",
    curlTemplate: `curl -X POST "https://api.deepgram.com/v1/listen" -H "Authorization: Token {{API_KEY}}" --data-binary @audio.wav`,
    responseContentPath: "results.channels.0.alternatives.0.transcript",
    mockResponse: {
      results: {
        channels: [
          {
            alternatives: [{ transcript: "Hello, how are you today?" }],
          },
        ],
      },
    },
    expectedTranscript: EXPECTED_TEXT,
  },
  {
    name: "Google STT",
    curlTemplate: `curl -X POST "https://speech.googleapis.com/v1/speech:recognize?key={{API_KEY}}" -H "Content-Type: application/json" -d '{"config":{"encoding":"LINEAR16","sampleRateHertz":16000,"languageCode":"en-US"},"audio":{"content":"{{AUDIO}}"}}'`,
    responseContentPath: "results.0.alternatives.0.transcript",
    mockResponse: {
      results: [
        {
          alternatives: [{ transcript: "Hello, how are you today?" }],
        },
      ],
    },
    expectedTranscript: EXPECTED_TEXT,
  },
];

describe.each(providerCases)(
  "Provider benchmark — $name",
  ({ curlTemplate, responseContentPath, mockResponse, expectedTranscript }) => {
    beforeEach(() => {
      vi.resetAllMocks();

      // Parse the curl template to derive method/url/headers/form for mock
      mockCurl2Json.mockReturnValue({
        url: "https://api.example.com/transcribe",
        method: "POST",
        header: { Authorization: "Bearer test-key" },
        form: {},
        data: {},
        params: {},
      });

      // Mock global fetch to return the provider-specific response
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: async () => JSON.stringify(mockResponse),
        })
      );
    });

    it("transcribes with WER below threshold", async () => {
      const provider = makeProvider({
        curl: curlTemplate,
        responseContentPath,
      });
      const params = makeSTTParams(provider);

      const result = await fetchSTT(params);

      const wer = calculateWER(expectedTranscript, result.text);
      expect(wer).toBeLessThan(WER_THRESHOLD);
    });

    it("returns a valid STTResult shape", async () => {
      const provider = makeProvider({
        curl: curlTemplate,
        responseContentPath,
      });
      const params = makeSTTParams(provider);

      const result = await fetchSTT(params);

      expect(result).toHaveProperty("text");
      expect(result).toHaveProperty("source");
      expect(result).toHaveProperty("timestamp");
      expect(typeof result.text).toBe("string");
      expect(typeof result.timestamp).toBe("number");
    });
  }
);

// ---------------------------------------------------------------------------
// 3. Live Benchmarks (gated by LIVE_STT_BENCHMARK=1)
// ---------------------------------------------------------------------------

const LIVE = process.env.LIVE_STT_BENCHMARK === "1";

const FIXTURE_DIR = path.resolve(
  __dirname,
  "../../../../../test-fixtures/audio"
);

function loadFixtures(): Array<{ name: string; wavPath: string; expected: string }> {
  if (!fs.existsSync(FIXTURE_DIR)) return [];

  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".expected.txt"))
    .map((f) => {
      const base = f.replace(".expected.txt", "");
      const wavPath = path.join(FIXTURE_DIR, `${base}.wav`);
      const expected = fs
        .readFileSync(path.join(FIXTURE_DIR, f), "utf-8")
        .trim();
      return { name: base, wavPath, expected };
    })
    .filter(({ wavPath }) => fs.existsSync(wavPath));
}

(LIVE ? describe : describe.skip)("live benchmarks", () => {
  const fixtures = loadFixtures();

  if (fixtures.length === 0) {
    it("no fixtures found — add .wav files to test-fixtures/audio/", () => {
      expect(true).toBe(true); // placeholder so the suite is not empty
    });
    return;
  }

  const liveProviderCases = [
    {
      name: "OpenAI Whisper (live)",
      curl: `curl -X POST "https://api.openai.com/v1/audio/transcriptions" -H "Authorization: Bearer {{API_KEY}}" -F "file=@audio.wav" -F "model=whisper-1"`,
      responseContentPath: "text",
      variables: { API_KEY: process.env.OPENAI_API_KEY ?? "" },
    },
    {
      name: "Deepgram (live)",
      curl: `curl -X POST "https://api.deepgram.com/v1/listen" -H "Authorization: Token {{API_KEY}}" --data-binary @audio.wav`,
      responseContentPath: "results.channels.0.alternatives.0.transcript",
      variables: { API_KEY: process.env.DEEPGRAM_API_KEY ?? "" },
    },
    {
      name: "Google STT (live)",
      curl: `curl -X POST "https://speech.googleapis.com/v1/speech:recognize?key={{API_KEY}}" -H "Content-Type: application/json" -d '{"config":{"encoding":"LINEAR16","sampleRateHertz":16000,"languageCode":"en-US"},"audio":{"content":"{{AUDIO}}"}}'`,
      responseContentPath: "results.0.alternatives.0.transcript",
      variables: { API_KEY: process.env.GOOGLE_API_KEY ?? "" },
    },
  ];

  describe.each(fixtures)("fixture: $name", ({ wavPath, expected }) => {
    describe.each(liveProviderCases)("provider: $name", ({ curl, responseContentPath, variables }) => {
      it(
        "achieves WER < 0.1 and responds within 10s",
        async () => {
          const audioBuffer = fs.readFileSync(wavPath);
          const audio = new Blob([audioBuffer], { type: "audio/wav" });

          const provider = makeProvider({ curl, responseContentPath });
          const params: STTParams = {
            provider,
            selectedProvider: {
              provider: provider.name as string,
              variables,
            },
            audio,
            source: "mic",
          };

          const start = Date.now();
          const result = await fetchSTT(params);
          const latencyMs = Date.now() - start;

          const wer = calculateWER(expected, result.text);

          console.log(
            `[live] provider=${provider.name} fixture=${path.basename(wavPath)} wer=${wer.toFixed(3)} latency=${latencyMs}ms`
          );

          expect(wer).toBeLessThan(WER_THRESHOLD);
          expect(latencyMs).toBeLessThan(10_000);
        },
        15_000 // generous timeout for real network calls
      );
    });
  });
});
