# Paint It Black — An AI-Native Resume Tailor (Chrome Extension for Local AI Agents & APIs)

> *"I see a red door and I want it painted black / No colors anymore, I want them to turn black."* — The Rolling Stones

## Why "Paint It Black"?

Job hunting turns into an endless loop of rewriting the same LaTeX bullets over and over just to get past ATS filters and stand out — *"I look inside myself and see my heart is black"* every time another 800-word job description opens up.

Worse yet, existing browser extensions (like Simplify) lock basic resume tailoring behind pricey subscriptions. When you already have plenty of AI tokens sitting in your own **Antigravity**, **Claude Code**, **OpenAI Codex**, **OpenRouter / OpenAI / Anthropic / Gemini API**, or **local Ollama / vLLM** setup, paying extra for someone else's wrapper makes zero sense. Inspired by open-source projects like [Resume-Matcher](https://github.com/srbhr/Resume-Matcher), I uninstalled Simplify, plugged my own local agents, API keys, and LaTeX workflow straight into Chrome, and **painted the whole tedious process black** — turning *"Maybe then I'll fade away and not have to face the facts"* of manual resume tweaking into a single click and a fast live chat.

A Manifest V3 Chrome extension + cross-platform local companion server (supports **Windows via WSL2**, **macOS natively**, and **Linux**) that reads the job description from your active browser tab, customizes your local LaTeX resume in `~/code/resume/` using **Antigravity CLI (`agy`)**, **Claude Code CLI (`claude`)**, **OpenAI Codex CLI (`codex`)**, or **Direct API / Local URL** (OpenAI, OpenRouter, Anthropic, Google Gemini, Ollama / LM Studio / vLLM), compiles and verifies a strict **1-page PDF** with LaTeX (`pdflatex` / `latexmk`), archives everything locally, and saves `resume-{companyname}-{jobtitle}.pdf` straight to your chosen folder (with a Save As window).

*No subscriptions. No colors anymore. Just open a job tab, click Generate, and ship.*

## Architecture

```
Chrome Side Panel (Windows or macOS)
  │  1. Auto-detects job description pages & resets session cleanly per job
  │  2. Auto-wakes companion server via Chrome Native Messaging if stopped
  │  3. Streams JD + chat/edits to http://127.0.0.1:8787 (SSE)
  ▼
Local Companion Server (server/index.mjs, 127.0.0.1:8787)
  │  4. Reads master .tex & SKILL.md from ~/code/resume/ (read-only)
  │  5. Routes to your chosen AI backend:
  │       • Antigravity CLI (`agy`)  — persistent warm stream-json worker
  │       • Claude Code CLI (`claude`) — headless structured JSON + `--resume`
  │       • OpenAI Codex CLI (`codex`) — `codex exec --output-schema`
  │       • Direct API / Local URL — OpenAI, OpenRouter, Anthropic, Gemini,
  │                                  or local Ollama / LM Studio / vLLM
  │  6. Uses fast slot edits for bullet tweaks, and full LaTeX mode for
  │     structural edits (adding/removing sections, roles, or projects)
  │  7. Compiles PDF via TeX Live / MacTeX (`pdflatex` / `latexmk`)
  │     (auto-repairs up to 2 passes if LaTeX errors or > 1 page)
  │  8. Archives resume-{companyname}-{jobtitle}.pdf locally
  ▼
Chrome Side Panel + Floating Preview Window
  │  9. Live-renders PDF in a popup window alongside Chrome while chat stays open
  │ 10. Saves to your Chosen Folder and/or native Save As dialog
```

## Quick Start

### Prerequisites

- **All platforms:** Node.js `>= 20`, Google Chrome (or Chromium/Edge/Brave), your LaTeX master resume folder at `~/code/resume/`, and **at least one AI backend**:
  - **Antigravity CLI (`agy`)** — uses your signed-in Google AI Pro account (pre-warmed persistent worker, dynamic model & effort discovery via `agy models`)
  - **Claude Code CLI (`claude`)** — uses your local Claude subscription or `ANTHROPIC_API_KEY` (`npm i -g @anthropic-ai/claude-code`)
  - **OpenAI Codex CLI (`codex`)** — uses your local ChatGPT/Codex login or `OPENAI_API_KEY` (`npm i -g @openai/codex`)
  - **Direct API / Local URL** — **OpenAI**, **OpenRouter**, **Local URL** (Ollama / LM Studio / vLLM — no API key required), **Anthropic**, or **Google Gemini** via Chrome Settings or server environment variables
- **macOS:** Install LaTeX via **MacTeX** or **BasicTeX** (`brew install --cask mactex-no-gui` or `brew install --cask basictex`). If using BasicTeX, ensure `latexmk` and any packages your resume template uses are installed via `tlmgr`.
- **Windows (WSL2):** Install Node.js `>= 20`, TeX Live (`~/texlive` or `apt`), and your preferred AI CLI (or run with Direct API / Local URL) inside your WSL distro.

### 1. Connect Your AI Backend (one-time)

Pick whichever backend you prefer — and switch anytime in **Settings → AI backend**:

- **Antigravity CLI (`agy`):** Run `agy` (or `~/.gemini/bin/agy`) once interactively to sign in, exit with `/exit`, and verify with `agy models`.
- **Claude Code CLI (`claude`):** Install `@anthropic-ai/claude-code` and run `claude login` once in your terminal (or export `ANTHROPIC_API_KEY`).
- **OpenAI Codex CLI (`codex`):** Install `@openai/codex` and run `codex login` once in your terminal (or export `OPENAI_API_KEY`).
- **Direct API Key / Local URL:**
  1. Open **Settings → AI backend → Direct API / Local URL**.
  2. Pick your **API provider**:
     - **OpenAI** (`https://api.openai.com/v1`)
     - **OpenRouter** (`https://openrouter.ai/api/v1`)
     - **Local URL** (default `http://127.0.0.1:11434/v1` for Ollama, or set your LM Studio / vLLM / LAN URL — API key is optional)
     - **Anthropic (Claude)** (`https://api.anthropic.com`)
     - **Google Gemini API** (`https://generativelanguage.googleapis.com`)
  3. Paste your API key in Settings (stored locally in `chrome.storage.local`, sent only over loopback `127.0.0.1:8787`, never written to `metadata.json` or resume archives) — or set the corresponding environment variable on the server (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`).
  4. Optionally pick a preset model or type any model ID into **Custom model** (e.g., an OpenRouter slug or local Ollama model name).

### 2. Enable Zero-Touch Auto-Start (Windows WSL & macOS)

Run the same unified installer in **macOS Terminal** or **Windows WSL**:

```bash
git clone https://github.com/GearlessJoeL/paint-it-black.git
cd paint-it-black
./scripts/install-autostart.sh
```

What it sets up automatically for your OS:

- **On macOS:**
  1. **LaunchAgent (`~/Library/LaunchAgents/com.local.resume_tailor.server.plist`)** — starts the companion server at login (`RunAtLoad`) and auto-restarts it (`KeepAlive`), automatically discovering Homebrew (`/opt/homebrew/bin`), MacTeX (`/Library/TeX/texbin`), nvm, and local AI CLIs (`agy`, `claude`, `codex`).
  2. **Chrome Native Messaging auto-waker** (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.local.resume_tailor.launcher.json`, plus Chromium/Edge/Brave if installed) — wakes the server on demand when opening the sidebar.
- **On Windows (WSL2):**
  1. **WSL `systemd --user` service** (`resume-tailor.service`, `Restart=always`).
  2. **Silent Windows Startup launcher** (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ResumeTailorWSL.vbs`) — starts WSL & the server hidden on every Windows login.
  3. **Chrome Native Messaging auto-waker** (`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.local.resume_tailor.launcher`) — wakes WSL & the server automatically if you ran `wsl --shutdown`.

To remove all auto-start entries cleanly at any time:

```bash
./scripts/uninstall-autostart.sh
```

*(Prefer running manually instead? Run `./scripts/start-server.sh`.)*

### 3. Load the Chrome Extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension` directory:
   - **macOS:** `~/code/paint-it-black/extension` (or wherever you cloned this repo)
   - **Windows (via WSL):** `\\wsl$\<Distro>\home\<username>\path\to\extension` (or `\\wsl.localhost\<Distro>\home\<username>\path\to\extension`)
4. Pin **Resume Tailor — Local AI** to your toolbar.
   *(When pulling updates, click **Reload** on the extension card in `chrome://extensions`.)*

### 4. Use It on Any Job Posting

1. Open any job listing (LinkedIn, Greenhouse, Lever, Ashby, Workday, Indeed, or a company careers page).
   - Entering a new job description page automatically resets the sidebar chat and preview session for that job.
2. Click the **Resume Tailor** toolbar icon (or press `⌘+Shift+Y` on macOS / `Ctrl+Shift+Y` on Windows, or right-click highlighted text → **Tailor Resume for This Job**).
3. Click **Generate Resume** for a 1-page tailored PDF — the floating **Resume Preview** popup opens beside Chrome while leaving the sidebar open.
4. Use the **unified chat** at the bottom of the sidebar for Q&A, bullet edits, or full structural changes:
   - **Q&A** (e.g., *"What skills am I missing?"*, *"Draft a recruiter DM"*) — answered in chat without modifying your PDF.
   - **Fast Bullet Edits** (e.g., *"Make bullet 2 more concise"*, *"Emphasize Go and Kubernetes"*) — uses targeted slot updates for low latency, recompiles a verified 1-page PDF, increments the revision (`v1` → `v2`…), and live-refreshes the preview window.
   - **Full Structural Edits** (e.g., *"Remove the Publications section and add a new Work Experience entry for …"*) — automatically switches to full-LaTeX edit mode so the model can add/remove/reorder sections, roles, or projects directly.
5. Use the top-right **Reconnect (`↻`)**, **History**, and **Settings** buttons to reconnect/re-warm local CLI clients, reopen saved drafts, pick a direct save folder, switch master resumes, or configure your AI backend, **Model**, and **Reasoning effort** independently.

## Where Files Are Saved

- **Local Resume Archive (always saved):**
  - `~/code/resume/tailored/<company>-<jobtitle>/job.md`
  - `~/code/resume/tailored/<company>-<jobtitle>/resume.tex`
  - `~/code/resume/tailored/<company>-<jobtitle>/resume.pdf`
  - `~/code/resume/tailored/<company>-<jobtitle>/resume-<company>-<jobtitle>.pdf`
  - `~/code/resume/tailored/<company>-<jobtitle>/metadata.json`
- **Save Folder / Save As:**
  - Writes directly to your selected folder (when chosen with active permission) and/or opens Chrome's native Save As dialog pre-filled with `resume-{companyname}-{jobtitle}.pdf`.
- **Master resumes (`resume.tex`, `resume-parttime.tex`) are never modified.**

## Supported AI Backends

Switch anytime in **Settings → AI backend**:

| Backend | Adapter | How It Runs | Auth / Keys |
|---|---|---|---|
| **Antigravity CLI (`agy`)** | `server/agents/antigravity.mjs` | Persistent `stream-json` worker pool; dynamically loads models & effort tiers from `agy models` | Local `agy` login |
| **Claude Code CLI (`claude`)** | `server/agents/claude-code.mjs` | Headless `claude -p --output-format json --json-schema` with `--resume` session reuse | Local `claude login` or `ANTHROPIC_API_KEY` |
| **OpenAI Codex CLI (`codex`)** | `server/agents/codex.mjs` | `codex exec --sandbox read-only --output-schema` with strict schema normalization | Local `codex login` or `OPENAI_API_KEY` |
| **Direct API / Local URL** | `server/agents/api-key.mjs` | Direct HTTP `fetch()` with in-memory multi-turn session history (**OpenAI**, **OpenRouter**, **Local URL** for Ollama/LM Studio/vLLM, **Anthropic**, **Google Gemini**) | Settings UI (local to Chrome, never written to disk archives) or server env vars; optional for Local URLs |

To add another backend, implement `checkStatus()` and `runStructuredPrompt(...)` (and optionally `runUnifiedTurn(...)`) and register it in `createDefaultRegistry()` inside `server/agents/registry.mjs`.

## Configuration (Environment Variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Localhost port for the companion server |
| `RESUME_REPO_DIR` | `~/code/resume` | Path to your LaTeX resume repository |
| `AGY_BIN` | `~/.gemini/bin/agy` (or on `PATH`) | Path to the Antigravity CLI binary |
| `CLAUDE_BIN` | `~/.local/bin/claude` (or on `PATH`) | Path to the Claude Code CLI binary |
| `CODEX_BIN` | `~/.local/bin/codex` (or on `PATH`) | Path to the Codex CLI binary |
| `OPENAI_API_KEY` | *(unset)* | Optional server-side API key for OpenAI |
| `OPENROUTER_API_KEY` | *(unset)* | Optional server-side API key for OpenRouter |
| `ANTHROPIC_API_KEY` | *(unset)* | Optional server-side API key for Anthropic API |
| `GEMINI_API_KEY` | *(unset)* | Optional server-side API key for Google Gemini API |
| `LOCAL_API_BASE_URL` | `http://127.0.0.1:11434/v1` | Optional default base URL for Local URL provider (Ollama / LM Studio / vLLM) |
| `API_BASE_URL` | *(provider default)* | Optional custom base URL override for any Direct API provider |
| `MAX_REPAIR_ATTEMPTS` | `2` | Automatic LaTeX / 1-page overflow fix passes |

## Running Tests

```bash
npm test
```

## Inspiration & Credits

- **[srbhr/Resume-Matcher](https://github.com/srbhr/Resume-Matcher)** — early open-source inspiration for local AI-driven ATS keyword matching and resume tailoring.
- **The Rolling Stones — *"Paint It, Black"*** — for the spirit of erasing repetitive job-application grunt work.
