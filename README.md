# pi-puppeteer

Pi extension package for browser automation with a browser-agnostic architecture.

## Current milestone

- **Primary runtime:** `puppeteer-core`
- **v1 focus:** Chrome, Edge, Brave, Opera, Vivaldi, and Yandex Browser via a shared Chromium adapter
- **Connection modes:** launch a configured browser profile or attach to an existing Chromium debugging endpoint
- **Tool surface:** one broad `browser` tool for core browser control plus dedicated `workflow_list`, `workflow_replay`, and `workflow_details` tools for saved workflows
- **Session model:** explicit session IDs and tab IDs, plus friendly browser names in the UI
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

Use `/browser` and press `B` to keep `system` or choose a discovered browser. That writes `defaultBrowser` to `.pi/.pi-puppeteer/settings.json`.

For bootstrap or non-interactive setup, you can still use:

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

The extension exposes one broad browser control tool plus dedicated workflow execution tools:

- `browser` (navigation, interaction, inspect, screenshots, recordings, workflow recording management)
- `workflow_list` (workflow summaries)
- `workflow_replay` (replay a saved workflow)
- `workflow_details` (full steps + raw browser-action fallback sequence)

### Browser actions

- `list_browsers`
- `start`
- `attach`
- `sessions`
- `show_session`
- `rename_session`
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
- `workflow_record_start`
- `workflow_record_stop`
- `workflow_status`
- `workflow_list`
- `workflow_replay`
- `workflow_details`
- `workflow_rename`
- `workflow_delete`
- `workflow_export`

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

### Recording and replaying workflows

Workflows capture page-level interactions as replayable Puppeteer scripts. Start a workflow recording and pi-puppeteer will use the default browser session if one exists, or open the configured default browser for you. Interact with the page manually or through the `browser` tool, then stop the recorder:

```json
{ "action": "workflow_record_start", "workflowName": "login flow" }
{ "action": "workflow_record_stop" }
```

Dedicated workflow tools for agents:

```text
workflow_list({})
workflow_replay({ "workflowName": "login flow" })
workflow_details({ "workflowName": "login flow" })
```

Saved workflow JSON and generated Puppeteer scripts live under `.pi/.pi-puppeteer/workflows/`. Use `/workflows` to open the workflow library UI for recording, replaying, renaming, exporting, and deleting saved workflows.

Open browser sessions show up above the editor as a right-aligned `Browser Session(s): X` indicator when at least one session is open. Press `Alt+B` or run `/browser` to open the browser manager, open the default browser, change the project default browser with `B`, rename a selected browser, show a selected session, or close/detach a session. Browser manager entries use friendly names like `Browser-1` by default, and tool calls can pass `name` when starting or attaching a browser. For launch-mode sessions, `name` also becomes the default profile key unless you explicitly pass `profile`. Within one Pi session, launching the same browser/profile reuses the existing browser session instead of creating duplicates.

Notes:

- Workflow replay follows Puppeteer terminology: use `workflow_replay`, not `workflow_run`.
- Preferred flow for agents: try `workflow_replay` first; if it fails, debug normally first, then use `workflow_details` raw actions only as a last resort.
- While a workflow recording is active, Pi shows a footer status indicator and blocks starting a second workflow recording.
- Recording covers page-level events such as navigation, clicks, form changes, special keys, submits, and scrolls.
- Browser chrome, OS dialogs, native file pickers, and some cross-origin iframe or closed shadow-DOM interactions are outside the page recorder.
- Password inputs are saved as `<redacted>`.

### Example prompts to Pi

- “Start Chrome named `Docs` and open example.com.”
- “Attach to my running Edge debugging endpoint on port 9222 and name it `Debug Edge`.”
- “Click the sign in button in browser session 1.”
- “Inspect the current page and summarize headings, forms, and links.”
- “Take a full-page screenshot and save it under artifacts/login.png.”
- “Record a short GIF while you scroll through the page, then stop and save it.”
- “Start a workflow recording named login, then replay it later.”
- “Open `/workflows` and rename the checkout workflow.”
- “Open `/browser` and close or detach the extra browser session.”

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
