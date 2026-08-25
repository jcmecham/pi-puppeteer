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
- emulate mobile devices or set a custom viewport (touch, UA override, DPR)
- extract page text or inspect page structure
- capture full-page screenshots
- record MP4, WebM, or GIF clips of a tab viewport
- record browser workflows and replay them later

## Requirements

- Node.js `>=22`
- Pi with package/extension support
- A Chromium-family browser or Firefox installed

Current Chromium-family support includes Chrome, Edge, Brave, Opera, Vivaldi, and Yandex Browser.
Firefox is supported too, over WebDriver BiDi rather than CDP. Everything the `browser` tool does
works on both; the handful of places Firefox behaves differently are in [Firefox](#firefox) below.

## Quick examples

After installation, you can ask Pi things like:

- “Start Chrome named `Docs` and open example.com.”
- “Attach to my running Edge debugging endpoint on port 9222.”
- “Start Firefox on the `work` profile and open my dashboard.”
- “Click the sign in button in the current browser session.”
- “Inspect this page and summarize the headings, forms, and links.”
- “Take a full-page screenshot and save it as `artifacts/home.png`.”
- “Emulate an iPhone 13 and screenshot the page.”
- “Record a short GIF while you scroll through the page.”
- “Start a workflow recording named `login`, then replay it later.”

## Browser manager

Run `/browser` in Pi to open the browser manager. From there, you can:

- open the default browser (`N`) — a throwaway session that leaves nothing behind
- open it on a saved profile instead (`L`)
- save a throwaway session as a named profile (`S`), without closing the browser
- choose the project default browser (`B`)
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
  "profileScope": "global",
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

### Profiles are optional

Opening a browser does not ask you about profiles. By default a session is **throwaway**: it gets a
fresh, private profile directory, and everything it accumulates — cookies, logins, cache — is deleted
when the session closes. That is what you want for most automation, and it means several browsers can
run side by side, which a single shared profile makes impossible.

When a session turns out to be worth keeping, save it:

- In the browser manager, press `S` and give it a name.
- Or ask Pi: "save this browser as `work`."

Saving takes effect immediately and **the browser keeps running** — nothing closes, restarts, or is
copied. Afterwards the profile behaves like any other saved one: press `L` in the browser manager, or
ask Pi to start a session with `profile: "work"`, and you are still signed in.

A profile name that does not exist yet is created on first use, so
"open Chrome with the `work` profile" works before `work` exists.

### Where profiles are stored

`profileScope` controls where named browser profiles live:

| Value | Location |
| --- | --- |
| `"global"` (default) | `~/.pi/agent/extensions/pi-puppeteer/profiles/<browser>/<profile>`, shared across all your projects |
| `"project"` | `<cwd>/.pi/.pi-puppeteer/profiles/<browser>/<profile>` |

Set `profileRoot` to override the location outright. It accepts an absolute path or a `~/`-prefixed
one, and takes precedence over `profileScope`.

A profile's directory is named by an ID, and the name you gave it is recorded in a
`.pi-puppeteer-profile.json` file inside. That is what lets a profile be saved or renamed while its
browser is running: only that small file changes, and the live profile directory is never moved.

Because saved profiles are shared across projects, one may already have a browser running on it —
possibly started by Pi in a different project. Ask before you launch:

- “List my browser profiles.” (`list_profiles`) reports every profile and whether it is in use, and
  names the project that started it.
- Creating a session from the Browser Manager opens a profile picker showing the same list.

Only one browser can run per profile, so starting a session on a profile that is already running
connects you to that browser rather than opening a second window.

### Managing profiles

The profile picker doubles as a profile manager — `N` for a new profile, `R` to rename, `D` twice to
delete. The same actions are available to Pi as `save_profile`, `rename_profile`, and `delete_profile`.

Names are kept exactly as you type them, punctuation included; the picker only refuses a name that is
already in use.

Renaming works at any time, including while a browser is running on the profile. Deleting does not —
a live profile directory cannot be removed without corrupting the browser holding it, so close that
browser first, even if it was started by Pi in another project. Deleting a profile permanently
discards everything it holds, including the sites it was signed in to.

### Firefox

Firefox works like any other browser here — `browserKey: "firefox"`, the same profiles, the same
actions — but it speaks WebDriver BiDi instead of CDP, and three consequences are worth knowing
before you hit them.

**One automation session per browser.** Firefox permits exactly one WebDriver session per process
([Bug 1720707](https://bugzilla.mozilla.org/show_bug.cgi?id=1720707)). Two Pi sessions in two
projects can share one Chrome window; they cannot share one Firefox window. The second one is told
so by name, and told which project is holding it, rather than failing obscurely. Pass a different
`profile` to get a separate window.

A Firefox that Pi disconnected from cleanly *can* be picked up again later — that is what adoption
means here, and it is also how you attach to a Firefox you started yourself. A Pi process that was
killed outright is the exception: Firefox never learns the session ended and cannot hand it back, so
that window has to be closed.

**Pi writes a few preferences into the profile.** They live in a marked block in `user.js`, and
anything you have set yourself outside that block is left alone:

- `fission.webContentIsolationStrategy` — without it, clicks do not reach cross-origin iframes.
- `browser.aboutwelcome.enabled`, `browser.startup.page`, `browser.startup.homepage` — so a session's
  first tab is the page you asked for and not an onboarding tour or last week's restored tabs.
- `signon.rememberSignons` and `signon.autofillForms`, on saved profiles only — Firefox switches both
  off by itself whenever a debugging port is passed, which would quietly stop a profile whose whole
  job is staying signed in from ever saving a password.

That list is deliberately short. Firefox applies its own, much longer set of automation preferences
at startup and clears them again when it exits, so writing them here would only make them permanent.

**`inspect` has no accessibility snapshot** on Firefox, and `emulate` has no `isMobile`: the viewport,
scale, and user agent are applied, but layout that keys off that flag alone is unchanged. Turning
touch emulation on or off reloads the tab.

**On Firefox older than 145, `emulate` still resizes the viewport.** Screen orientation, touch, and
user-agent emulation arrived as WebDriver BiDi commands in Firefox 144 and 145; on anything earlier —
the whole 140 ESR line included — Pi applies the size and tells you which refinements the browser was
too old for, rather than failing the action. Checking a layout at 390px wide works everywhere.

## Screenshots and recordings

Screenshots and recordings are saved under the project artifact directory by default:

```text
.pi/.pi-puppeteer/artifacts/
```

That directory carries its own `.gitignore`. Pass an explicit `path` to write a file your repository
can see.

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

Workflows stay project-local: a recorded login or setup flow belongs to the app it was recorded
against.

Workflow recording captures page-level events such as navigation, clicks, form changes, key presses, submits, and scrolls. Password inputs are saved as `<redacted>`.

## Runtime storage

Storage is split in two, according to what the data is.

**Project storage** — `<cwd>/.pi/.pi-puppeteer/`

- `settings.json` — project configuration
- `artifacts/` — screenshots and recordings
- `workflows/` — saved workflow recordings and exports
- `.gitignore` — written automatically, so none of the above can be staged by accident

This directory is created lazily. Starting Pi in a project does not create it; only writing a
screenshot, recording, workflow, or setting does.

**Global storage** — `~/.pi/agent/extensions/pi-puppeteer/`

- `profiles/<browser>/<id>` — browser profiles, saved and throwaway alike

Throwaway profiles are removed when their session closes. If Pi is killed before that happens, the
next Pi session sweeps up whatever was left behind.

Profiles live outside your repositories for two reasons. A browser profile holds cookies and session
tokens, and a single Chromium profile routinely runs to hundreds of megabytes across thousands of
cache files — neither belongs in a project directory. Because profiles are keyed by name rather than
by project, signing in to a site once makes that session available to every project using the same
profile name.

To save a screenshot or recording somewhere git can see it, pass an explicit `path`; it is resolved
against the project directory rather than the artifact root.

## Notes

- Sessions are throwaway unless you name a profile. Nothing a throwaway session signs in to survives
  it closing, and every launch without a profile opens a separate browser.
- Browser launches are headed by default. Pass `headless: true` when you want a headless session.
- Attach mode requires the target browser to be running with remote debugging enabled: a Chromium
  browser started with `--remote-debugging-port=9222`, or Firefox started the same way — for Firefox
  the endpoint is `ws://127.0.0.1:9222/session`, and the `http://` spelling of the same address is
  accepted too.
- Attached browsers are disconnected, not forcibly closed, when Pi shuts down.
- Launch-created browser sessions are closed when Pi shuts down.
- Only one browser can run per profile. Starting a session on a profile another Pi session already
  has open adopts that browser instead of launching a second one; an adopted browser stays open when
  the adopting session ends. Pass a different `profile` when you want a separate window. Firefox can
  only be adopted while nothing else is driving it — see [Firefox](#firefox).
- A browser running on a profile is only detectable if it exposes a debugging endpoint, which is the
  case for anything Pi launched. A browser you started yourself, outside Pi, on the same profile will
  not be reported as in use. Firefox is the exception: Pi checks its profile lock before launching,
  so starting a session on a profile your own Firefox has open fails with an explanation rather than
  colliding.

## Upgrading from 0.2.x

Browser profiles move out of your projects on the first run. Each `<cwd>/.pi/.pi-puppeteer/profiles`
directory is relocated to the shared global root, and Pi reports what it moved.

- Profiles are never merged. If a profile of the same name already exists globally — likely, since
  the old default derived the profile name from the session label — the project copy is left exactly
  where it is and reported. Start a session with a different `profile` name to keep using it, or
  delete the directory once you no longer need it.
- A profile a browser still has open is deferred. Close the browser and restart Pi to finish.
- Set `"profileScope": "project"` to keep profiles project-local.
- A `profileRoot` of `.pi/.pi-puppeteer/profiles` is treated as the old default and upgraded. Any
  other value is left alone.

If browser profile data was ever committed, remove it from the index with
`git rm -r --cached .pi/.pi-puppeteer` and rotate any credentials for sites you were signed into on
a repository that has a public remote.

## Links

- [npm package](https://www.npmjs.com/package/pi-puppeteer)
- [Changelog](https://github.com/jcmecham/pi-puppeteer/blob/main/CHANGELOG.md)
- [Issues](https://github.com/jcmecham/pi-puppeteer/issues)
- [License](https://github.com/jcmecham/pi-puppeteer/blob/main/LICENSE)
