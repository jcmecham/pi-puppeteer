# pi-puppeteer

[![CI](https://github.com/jcmecham/pi-puppeteer/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jcmecham/pi-puppeteer/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-puppeteer.svg)](https://www.npmjs.com/package/pi-puppeteer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/jcmecham/pi-puppeteer/blob/main/LICENSE)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)

Browser automation for Pi, powered by `puppeteer-core` and designed to work with the browsers already installed on your machine.

## Install

Install the package for Pi:

```bash
pi install npm:pi-puppeteer
```

## What it does

`pi-puppeteer` lets Pi launch, attach to, inspect, and control browser sessions. It is built for agent-friendly browser automation with persistent profiles, saved workflows, screenshots, and viewport recordings.

Use it to ask Pi to:

- open or attach to a browser
- navigate pages and manage tabs
- click, type, press keys, scroll, and wait for elements
- emulate mobile devices or set a custom viewport (touch, mobile UA, DPR)
- extract page text or inspect page structure
- capture full-page screenshots
- record MP4, WebM, or GIF clips of a tab viewport
- record browser workflows and replay them later

## Requirements

- Node.js `>=22`
- Pi with package/extension support
- A Chromium-family browser installed

Current Chromium-family support includes Chrome, Edge, Brave, Opera, Vivaldi, and Yandex Browser.

## Quick examples

After installation, you can ask Pi things like:

- “Start Chrome named `Docs` and open example.com.”
- “Attach to my running Edge debugging endpoint on port 9222.”
- “Click the sign in button in the current browser session.”
- “Inspect this page and summarize the headings, forms, and links.”
- “Take a full-page screenshot and save it as `artifacts/home.png`.”
- “Emulate an iPhone 13 and screenshot the page.”
- “Record a short GIF while you scroll through the page.”
- “Start a workflow recording named `login`, then replay it later.”

## Browser manager

Run `/browser` in Pi to open the browser manager. From there, you can:

- open the default browser
- choose the project default browser
- view active browser sessions
- rename a session
- show, close, or detach from a session

Open browser sessions appear above the editor as a `Browser Session(s)` indicator. You can also press `Alt+B` to open the browser manager.

## Tools exposed to Pi

The package exposes one primary browser-control tool plus dedicated workflow helpers:

- `browser` — launch or attach to browsers, control pages, inspect content, capture screenshots, record clips, and manage workflow recordings
- `workflow_list` — list saved workflows
- `workflow_replay` — replay a saved workflow
- `workflow_details` — inspect workflow steps for troubleshooting or fallback execution

The `browser` tool supports session management, tab management, navigation, page interaction, extraction, inspection, screenshots, recordings, and workflow management.

## Configuration

Fresh installs use the operating-system default browser when it can be detected. If detection is unavailable, the package falls back to Chrome.

Configuration is loaded from:

- global config: `~/.pi/agent/extensions/pi-puppeteer.json`
- project config: `<cwd>/.pi/.pi-puppeteer/settings.json`

Project config takes precedence over global config.

A typical project config looks like this:

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
    "edge-work": {
      "displayName": "Edge Work",
      "engine": "chromium",
      "executablePath": "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "launchArgs": ["--start-maximized"]
    }
  }
}
```

Use `defaultBrowser: "system"` to follow your OS default browser, or set it to a configured browser key such as `chrome`, `edge`, `brave`, or a custom entry like `edge-work`.

## Screenshots and recordings

Screenshots and recordings are saved under the project artifact directory by default:

```text
.pi/.pi-puppeteer/artifacts/
```

Viewport recordings are captured through `ffmpeg`. The package uses the bundled `ffmpeg-static` binary when available. You can also install `ffmpeg` on your `PATH` or pass a custom `ffmpegPath`.

Supported recording formats:

- `mp4`
- `webm`
- `gif`

Recording captures page content only, not the surrounding browser chrome or operating-system UI.

## Workflows

Workflows let you record browser interactions once and replay them later. Open `/workflows` in Pi to manage saved workflows.

You can use workflows to:

- record a login, setup, or navigation flow
- replay a workflow by name or ID
- rename saved workflows
- export generated workflow scripts
- delete workflows you no longer need

Saved workflow files live under:

```text
.pi/.pi-puppeteer/workflows/
```

Workflow recording captures page-level events such as navigation, clicks, form changes, key presses, submits, and scrolls. Password inputs are saved as `<redacted>`.

## Runtime storage

By default, project-specific runtime files live under:

```text
.pi/.pi-puppeteer/
```

This includes:

- `settings.json` — project configuration
- `profiles/` — persistent browser profiles
- `artifacts/` — screenshots and recordings
- `workflows/` — saved workflow recordings and exports

These files are local runtime state and are normally ignored by git.

## Notes

- Browser launches are headed by default. Pass `headless: true` when you want a headless session.
- Attach mode requires the target Chromium browser to be running with remote debugging enabled.
- Attached browsers are disconnected, not forcibly closed, when Pi shuts down.
- Launch-created browser sessions are closed when Pi shuts down.

## Links

- [npm package](https://www.npmjs.com/package/pi-puppeteer)
- [Changelog](https://github.com/jcmecham/pi-puppeteer/blob/main/CHANGELOG.md)
- [Issues](https://github.com/jcmecham/pi-puppeteer/issues)
- [License](https://github.com/jcmecham/pi-puppeteer/blob/main/LICENSE)
