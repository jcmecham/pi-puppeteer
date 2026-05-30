# pi-puppeteer

Pi extension package for browser automation with a browser-agnostic architecture.

## Current milestone

- **Primary runtime:** `puppeteer-core`
- **v1 focus:** Chrome, Edge, Brave, Opera, Vivaldi, and Yandex Browser via a shared Chromium adapter
- **Connection modes:** launch a configured browser profile or attach to an existing Chromium debugging endpoint
- **Tool surface:** one broad `browser` tool with core actions, inspect capabilities, screenshots, and ffmpeg-backed recordings
- **Session model:** explicit session IDs and tab IDs
- **Profile model:** named persistent profiles stored under `.pi/.pi-puppeteer/profiles/`

Firefox is intentionally planned next. The internal architecture already keeps a transport split between **Chromium/CDP** and future **Firefox/WebDriver BiDi** support.

## Why Puppeteer-core

This package is intentionally using Puppeteer rather than Playwright for the first implementation.

Key reasons:

- Puppeteer is a strong fit for **Chromium-first** automation.
- Puppeteer already models **CDP for Chromium** and **WebDriver BiDi for Firefox**, which matches the planned roadmap.
- `puppeteer-core` is library-only, so Pi can target **user-configured browsers** instead of assuming bundled browsers.
- Existing agent-browser projects show that it is worth separating the **high-level action API** from the **browser transport layer**.

See `docs/architecture.md` for the design rationale and research notes.

## Install dependencies

```bash
npm install
```

## Package shape

This repo is a Pi package:

- `package.json` declares the Pi manifest under `pi.extensions`
- `src/index.ts` is the extension entry point

## Load in Pi

Project-local:

```bash
pi -e .
```

Or install it as a Pi package later:

```bash
pi install . -l
```

## Configuration

The extension merges config from:

- global: `~/.pi/agent/extensions/pi-puppeteer.json`
- project: `<cwd>/.pi/.pi-puppeteer/settings.json`

Project config wins.

Project config, persistent profiles, and artifacts live under `<cwd>/.pi/.pi-puppeteer/` by default. If older
`<cwd>/.pi/pi-puppeteer.json`, `<cwd>/.pi/.pi-puppeteer/pi-puppeteer.json`, or `<cwd>/.pi-puppeteer/` paths exist, the extension moves them into the new location on config load.

### Choose the default browser

Fresh installs use `defaultBrowser: "system"`, which means the detected operating-system default browser. On Windows, this reads the per-user `UrlAssociations\\http(s)\\UserChoice` ProgID (for example, `BraveHTML` resolves to `brave`). If detection is unavailable or unsupported, it falls back to Chrome.

Run the interactive picker to keep `system` or choose a discovered browser. It writes `defaultBrowser` to `.pi/.pi-puppeteer/settings.json`:

```bash
npm run configure             # interactive menu
npm run configure -- system   # use the OS default browser
npm run configure -- edge     # set non-interactively
```

Example:

```json
{
  "defaultBrowser": "system",
  "profileRoot": ".pi/.pi-puppeteer/profiles",
  "artifactRoot": ".pi/.pi-puppeteer/artifacts",
  "defaults": {
    "headless": false,
    "timeoutMs": 30000,
    "navigationWaitUntil": "domcontentloaded"
  },
  "browsers": {
    "chrome": {
      "displayName": "Google Chrome",
      "attach": {
        "browserURL": "http://127.0.0.1:9222"
      }
    },
    "edge-work": {
      "displayName": "Edge Work",
      "engine": "chromium",
      "executablePath": "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "launchArgs": ["--start-maximized"]
    },
    "yandex": {
      "displayName": "Yandex Browser",
      "engine": "chromium"
    }
  }
}
```

## Tool overview

The extension exposes a single tool named `browser`.

### Current actions

- `list_browsers`
- `start`
- `attach`
- `sessions`
- `stop`
- `tabs`
- `new_tab`
- `select_tab`
- `close_tab`
- `navigate`
- `click`
- `type`
- `press`
- `scroll`
- `wait_for`
- `extract_text`
- `inspect`
- `screenshot`
- `record_start`
- `record_stop`

### Recording browsing clips

The `record_start` action captures the current tab viewport as PNG frames and pipes them to `ffmpeg`, so it works in both headed and headless sessions without OS-specific screen-capture setup. The package uses the npm `ffmpeg-static` binary when available; otherwise install `ffmpeg` on `PATH`, or pass `ffmpegPath`.

Examples:

```json
{ "action": "record_start", "format": "mp4", "fps": 10 }
{ "action": "record_start", "path": "artifacts/demo.gif", "fps": 8 }
{ "action": "record_stop", "recordingId": "recording-1" }
```

Notes:

- Default output path: `.pi/.pi-puppeteer/artifacts/recordings/<session>-<tab>-<timestamp>.mp4`
- Supported formats: `mp4`, `webm`, `gif`; format is inferred from `path` when possible.
- Recording captures page content, not browser chrome/UI.

### Example prompts to Pi

- “Start Chrome with profile `default` and open example.com.”
- “Attach to my running Edge debugging endpoint on port 9222.”
- “Click the sign in button in browser session 1.”
- “Inspect the current page and summarize headings, forms, and links.”
- “Take a full-page screenshot and save it under artifacts/login.png.”
- “Record a short GIF while you scroll through the page, then stop and save it.”

## Development checks

Run the production validation before committing:

```bash
npm run validate                       # clean generated build output and type-check src + scripts
npm pack --dry-run                     # inspect package contents
```

Browser profiles, screenshots, and recordings created during local use live under `.pi/.pi-puppeteer/`; this runtime state is intentionally ignored by git.

## Notes

- Launches are headed by default; pass `headless: true` to run headless.
- Chromium launch spawns the browser with a remote-debugging port and connects to it (rather than `puppeteer.launch`), so it survives browsers like Edge that fork/relaunch on startup. On stop, launch sessions also reap any leftover processes tied to their profile dir.
- Chromium attach currently expects the target browser to be launched with remote debugging enabled.
- Built-in Chromium-family discovery includes Chrome, Edge, Brave, Opera, Vivaldi, and Yandex Browser.
- Attached browsers are **disconnected**, not forcibly closed, when the extension session shuts down.
- Launch-created sessions are closed on session shutdown.
- Firefox is not fully implemented yet, but the config/types/manager split is designed so it can be added without rewriting the tool surface.
