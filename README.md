# Freely

A lightning-fast, privacy-first AI assistant that works seamlessly during meetings, interviews, and conversations. Built with [Tauri](https://tauri.app) for native performance (~10 MB). Invisible in video calls, screen shares, and recordings.

## Features

- **Undetectable overlay** — transparent, always-on-top window that bypasses screen capture on macOS, Windows, and Linux
- **Multi-LLM support** — Claude, OpenAI, Gemini, plus custom providers via API key
- **Agent backends** — Claude Code CLI, OpenAI Codex, and Gemini with streaming orchestration
- **Real-time voice input** — speech-to-text with VAD (voice activity detection)
- **Screenshot analysis** — capture and send screen context to the AI
- **Persistent history** — SQLite-backed conversation storage
- **Global shortcuts** — trigger the overlay from anywhere without switching windows
- **Auto-update** — built-in Tauri updater

## Quick Start

```bash
# Prerequisites: Node.js 18+, Rust 1.70+, platform build tools (Xcode / MSVC / gcc)

git clone https://github.com/lambdaflows/freely.git
cd freely/freely
npm install
npm run tauri dev
```

To build a production binary:

```bash
npm run tauri build
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript, Tailwind CSS, Radix UI |
| Backend | Rust, Tauri 2 |
| Database | SQLite (via tauri-plugin-sql) |
| AI | Claude, OpenAI, Gemini, browser/OS STT |
| Audio | cpal (cross-platform), VAD |

## Acknowledgments

- **[Pluely](https://github.com/iamsrikanthnani/pluely)** — the original open-source Cluely alternative that Freely was forked from. Created by [Srikanth Nani](https://github.com/iamsrikanthnani).
- **[Agor](https://agor.live)** ([GitHub](https://github.com/AgorLive)) — a multiplayer canvas for orchestrating AI coding agents. Contributed the Claude Code CLI integration, iTools interface, and multi-agent orchestration.

## License

[GPL-3.0](LICENSE) — copyleft.
