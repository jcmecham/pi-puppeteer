# pi-puppeteer

Pi extension package for browser automation with a browser-agnostic architecture.

## Current milestone

- **Primary runtime:** `puppeteer-core`
- **v1 focus:** Chrome, Edge, Brave, Opera, Vivaldi, and Yandex Browser via a shared Chromium adapter
- **Connection modes:** launch a configured browser profile or attach to an existing Chromium debugging endpoint
- **Tool surface:** one broad `browser` tool with core actions plus inspect capabilities
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

Run the interactive picker to see which browsers were discovered on this machine and
select the default. It writes `defaultBrowser` to `.pi/.pi-puppeteer/settings.json`:

```bash
npm run configure          # interactive menu
npm run configure -- edge  # set non-interactively
```

Example:

```json
{
  "defaultBrowser": "chrome",
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

### Example prompts to Pi

- “Start Chrome with profile `default` and open example.com.”
- “Attach to my running Edge debugging endpoint on port 9222.”
- “Click the sign in button in browser session 1.”
- “Inspect the current page and summarize headings, forms, and links.”
- “Take a full-page screenshot and save it under artifacts/login.png.”

## Development checks

Run the production validation before committing:

```bash
npm run validate                       # clean generated build output and type-check src + scripts
npm pack --dry-run                     # inspect package contents
```

Browser profiles and screenshots created during local use live under `.pi/.pi-puppeteer/`; this runtime state is intentionally ignored by git.

## Notes

- Launches are headed by default; pass `headless: true` to run headless.
- Chromium launch spawns the browser with a remote-debugging port and connects to it (rather than `puppeteer.launch`), so it survives browsers like Edge that fork/relaunch on startup. On stop, launch sessions also reap any leftover processes tied to their profile dir.
- Chromium attach currently expects the target browser to be launched with remote debugging enabled.
- Built-in Chromium-family discovery includes Chrome, Edge, Brave, Opera, Vivaldi, and Yandex Browser.
- Attached browsers are **disconnected**, not forcibly closed, when the extension session shuts down.
- Launch-created sessions are closed on session shutdown.
- Firefox is not fully implemented yet, but the config/types/manager split is designed so it can be added without rewriting the tool surface.
