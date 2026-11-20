# Paint It Black — An AI-Native Resume Tailor (Chrome Extension for Local AI Agents)

> *"I see a red door and I want it painted black / No colors anymore, I want them to turn black."* — The Rolling Stones

## Why "Paint It Black"?

Job hunting turns into an endless loop of rewriting the same LaTeX bullets over and over just to get past ATS filters and stand out — *"I look inside myself and see my heart is black"* every time another 800-word job description opens up.

Worse yet, existing browser extensions (like Simplify) lock basic resume tailoring behind pricey subscriptions. When you already have plenty of AI tokens sitting in your own Antigravity subscription, paying extra for someone else's wrapper makes zero sense. Inspired by open-source projects like [Resume-Matcher](https://github.com/srbhr/Resume-Matcher), I uninstalled Simplify, plugged my own local tokens and LaTeX workflow straight into Chrome, and **painted the whole tedious process black** — turning `"Maybe then I'll fade away and not have to face the facts"` of manual resume tweaking into a single click and a fast live chat.

A Manifest V3 Chrome extension + cross-platform local companion server (supports **Windows via WSL2** and **macOS natively**) that reads the job description from your active browser tab, customizes your local LaTeX resume in `~/code/resume/` using your signed-in **Antigravity CLI (`agy`)**, compiles and verifies a strict **1-page PDF** with LaTeX (`pdflatex` / `latexmk`), archives everything locally, and saves `resume-{companyname}-{jobtitle}.pdf` straight to your chosen folder (with a Save As window).

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
  │  5. Invokes local `agy` CLI (--output-format stream-json --json-schema ...)
  │  6. Writes tailored/<company>-<role>/{job.md, resume.tex}
  │  7. Compiles PDF via TeX Live / MacTeX (`latexmk -pdf` or `pdflatex`)
  │     (auto-repairs up to 2 passes if LaTeX errors or > 1 page)
  │  8. Archives resume-{companyname}-{jobtitle}.pdf locally
  ▼
Chrome Side Panel + Floating Preview Window
  │  9. Live-renders PDF in a popup window alongside Chrome while chat stays open
  │ 10. Saves to your Chosen Folder and/or native Save As dialog
```

## Quick Start

### Prerequisites

- **All platforms:** Node.js `>= 20`, Google Chrome (or Chromium/Edge/Brave), Antigravity CLI (`agy`), and your LaTeX master resume folder at `~/code/resume/`.
- **macOS:** Install LaTeX via **MacTeX** or **BasicTeX** (`brew install --cask mactex-no-gui` or `brew install --cask basictex`). If using BasicTeX, ensure `latexmk` and any packages your resume template uses are installed via `tlmgr`.
- **Windows (WSL2):** Install Node.js `>= 20`, TeX Live (`~/texlive` or `apt`), and `agy` inside your WSL distro.

### 1. Sign in to Antigravity CLI (one-time)

Open **Terminal** (macOS) or **WSL** (Windows) and sign into `agy` once interactively:

```bash
agy   # or ~/.gemini/bin/agy
```

Exit with `/exit` (or `Ctrl+D` twice) and verify with:

```bash
agy models
```

### 2. Enable Zero-Touch Auto-Start (Windows WSL & macOS)

Run the same unified installer in **macOS Terminal** or **Windows WSL**:

```bash
git clone https://github.com/GearlessJoeL/paint-it-black.git
cd paint-it-black
./scripts/install-autostart.sh
```

What it sets up automatically for your OS:

- **On macOS:**
  1. **LaunchAgent (`~/Library/LaunchAgents/com.local.resume_tailor.server.plist`)** — starts the companion server at login (`RunAtLoad`) and auto-restarts it (`KeepAlive`), automatically discovering Homebrew (`/opt/homebrew/bin`), MacTeX (`/Library/TeX/texbin`), nvm, and `agy`.
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
4. Use the **unified chat** at the bottom of the sidebar for either Q&A or resume edits:
   - **Q&A** (e.g., *"What skills am I missing?"*, *"Draft a recruiter DM"*) — answered in chat without modifying your PDF.
   - **Edits & Regeneration** (e.g., *"Make bullet 2 more concise"*, *"Emphasize Go and Kubernetes"*) — updates `resume.tex`, compiles a verified 1-page PDF, increments the revision (`v1` → `v2`…), and live-refreshes the preview window.
5. Use the top-right **History** and **Settings** buttons to reopen saved drafts, pick a direct save folder, switch master resumes, or select an Antigravity model.

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

## Adding More Local AI Agents

All local agents follow the adapter contract in `server/agents/registry.mjs`. Add a new file in `server/agents/` implementing `checkStatus()` and `runStructuredPrompt(...)` and register it in `createDefaultRegistry()`.

## Configuration (Environment Variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Localhost port for the companion server |
| `RESUME_REPO_DIR` | `~/code/resume` | Path to your LaTeX resume repository |
| `AGY_BIN` | `~/.gemini/bin/agy` (or on `PATH`) | Path to the Antigravity CLI binary |
| `MAX_REPAIR_ATTEMPTS` | `2` | Automatic LaTeX / 1-page overflow fix passes |

## Running Tests

```bash
npm test
```

## Inspiration & Credits

- **[srbhr/Resume-Matcher](https://github.com/srbhr/Resume-Matcher)** — early open-source inspiration for local AI-driven ATS keyword matching and resume tailoring.
- **The Rolling Stones — *"Paint It, Black"*** — for the spirit of erasing repetitive job-application grunt work.
