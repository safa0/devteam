# STT Benchmark Audio Fixtures

This directory contains audio fixture files used for live STT accuracy benchmarks.

## Structure

Each fixture consists of a pair of files:

- `<name>.wav` — A short WAV audio file (5–15 seconds, 16kHz mono recommended)
- `<name>.expected.txt` — The ground-truth transcript for that audio

## Example

```
greeting.wav
greeting.expected.txt   → "Hello, how are you today?"

numbers.wav
numbers.expected.txt    → "one two three four five"

weather.wav
weather.expected.txt    → "The weather today is sunny with a high of seventy-two degrees"
```

## Adding Fixtures

1. Record or obtain a WAV file. Recommended spec: 16kHz, 16-bit, mono.
2. Transcribe it manually (the ground truth, lowercase, no punctuation preferred).
3. Place both files here with matching base names.

## Running Live Benchmarks

Live benchmarks are gated behind an environment variable so they never run in CI:

```bash
LIVE_STT_BENCHMARK=1 npx vitest run src/lib/functions/__tests__/stt.benchmark.test.ts
```

Requires real API keys in the environment (e.g. `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `GOOGLE_API_KEY`).

## Fixture Inventory

| File | Expected transcript |
|------|---------------------|
| `greeting.wav` | `Hello, how are you today?` |
| `numbers.wav` | `one two three four five` |
| `weather.wav` | `The weather today is sunny with a high of seventy-two degrees` |

> **Note:** The WAV files must be added manually. Only the `.expected.txt` ground-truth files are committed to the repository.
