# Architecture

## User decisions captured

These are the design choices confirmed for the first milestone:

- **Connection model:** launch + attach
- **Browser scope:** top Chromium browsers first
- **Tool surface:** one broad browser tool
- **Capabilities:** core actions + inspect capabilities + screenshots + ffmpeg-backed viewport recordings
- **Profiles:** named persistent profiles
- **Packaging:** Pi package
- **State model:** explicit session IDs
- **Automation runtime:** hybrid-adapter idea, but using **Puppeteer** instead of Playwright

## Research summary

### Transferable patterns from similar projects

1. **Browser Use**
   - Publicly emphasizes agent-friendly browser control.
   - Has used Playwright integration, but also published a rationale for moving closer to raw CDP for Chromium-specific power.
   - Transferable lesson: keep the high-level action API separate from the underlying transport so Chromium can go deeper without rewriting the entire agent-facing surface.

2. **Stagehand**
   - Uses a layered architecture with a clear separation between orchestration and browser connection internals.
   - Transferable lesson: isolate a browser connection layer from the action/extract/observe layer.

3. **Playwright**
   - Strong evidence for multi-browser abstractions and Chromium attach via `connectOverCDP`.
   - Important constraint: Playwright documentation explicitly warns that non-bundled browsers are less guaranteed when using arbitrary executable paths.
   - Transferable lesson: the abstraction boundary is good, but the first implementation here benefits from a Puppeteer-centered runtime because the project goal is user-configured browsers rather than Playwright-managed bundles.

4. **Puppeteer**
   - `puppeteer-core` is designed as a library for externally managed browsers.
   - Chromium uses **CDP** by default.
   - Firefox uses **WebDriver BiDi** by default when launched through Puppeteer.
   - Transferable lesson: Puppeteer already matches the intended transport roadmap: Chromium now, Firefox next.

## Why the first implementation uses Puppeteer-core

The project goal is not merely “browser automation.” It is:

- Pi-controlled browser interaction
- with **user-configured browsers**
- starting with **Chromium-family browsers**
- while keeping a clean path to **Firefox later**

That makes `puppeteer-core` a strong first base because:

1. it does not force bundled browser assumptions;
2. it fits Chromium/CDP well;
3. it has a future lane for Firefox/BiDi;
4. it lets us keep the extension package light and configuration-driven.

## Proposed architecture

## 1. Agent-facing surface

Expose one Pi tool:

- `browser`

The tool accepts an `action` plus action-specific parameters.

Examples:

- `start`
- `attach`
- `navigate`
- `click`
- `type`
- `inspect`
- `screenshot`

This matches the requested “single broad tool” while still keeping the internals modular.

## 2. Internal layers

### A. Config + discovery layer

Responsibilities:

- merge global and project config
- define browser entries (`chrome`, `edge`, `brave`, `opera`, `vivaldi`, `yandex`, and `firefox`)
- resolve executable paths from config or common install locations
- resolve named profile and artifact directories

### B. Browser adapter layer

Responsibilities:

- normalize launch vs attach semantics
- hide protocol differences from the Pi tool surface
- expose common operations such as page selection, navigation, typing, screenshots, and inspection

Initial adapter shape:

- `ChromiumAdapter` via Puppeteer + CDP semantics

Planned next:

- `FirefoxAdapter` via Puppeteer + WebDriver BiDi

### C. Session manager layer

Responsibilities:

- create Pi-visible browser session IDs
- track current session and current tab
- keep explicit tab IDs stable within a session
- distinguish between launch-owned sessions and attached sessions
- close launched sessions cleanly while only disconnecting attached sessions

### D. Action execution layer

Responsibilities:

- validate action-specific arguments
- resolve target session and tab
- execute the browser operation
- return compact, LLM-friendly summaries instead of raw oversized page dumps

## 3. Config model

Use two JSON files:

- global: `~/.pi/agent/extensions/pi-puppeteer.json`
- project: `<cwd>/.pi/.pi-puppeteer/settings.json`

Project config overrides global config.

The config should support:

- default browser key
- profile root
- artifact root
- default timeout / headless / waitUntil
- browser definitions
  - `displayName`
  - `engine`
  - `executablePath`
  - `launchArgs`
  - attach defaults such as `browserURL` or `browserWSEndpoint`

## 4. Profile model

Named profiles are stored on disk under a Pi-managed folder.

Example:

- `.pi/.pi-puppeteer/profiles/chrome/default`
- `.pi/.pi-puppeteer/profiles/edge/work`

This gives persistent login/session state without requiring the extension to reuse a user’s personal everyday browser profile.

## 5. Session model

A session ID maps to one connected browser instance.

Each session tracks:

- browser identity
- engine
- connection mode (`launch` or `attach`)
- profile name when relevant
- current tab ID
- tab map

This is more explicit and safer than a purely implicit “current browser/tab” model.

## 6. Inspect model

The inspect path should return concise structured summaries, not giant DOM dumps.

Initial inspect data:

- page URL
- title
- readiness
- text sample
- heading summary
- link summary
- form summary
- active element
- optional accessibility snapshot summary when available

This is enough to support many agent workflows without flooding context.

## 7. Workflow model

Saved workflows live under `.pi/.pi-puppeteer/workflows/` as canonical JSON plus generated Puppeteer scripts. The browser tool uses Puppeteer terminology: recorded flows are replayed with `workflow_replay`.

Workflow recording combines two sources:

- tool-level navigation steps emitted by the `browser` manager;
- a page-injected recorder for clicks, form changes, special keys, submits, and scrolls.

This keeps normal Pi tool actions and manual headed-browser interactions in the same workflow library. Replay executes the saved steps against the current tab when possible, or starts a browser session from the workflow metadata when no session is active.

## 8. v1 scope

### In scope now

- package scaffold
- config loading
- executable discovery for major Chromium browsers
- launch configured browsers with named profiles
- attach to existing Chromium debugging endpoints
- session + tab management
- core interaction actions
- screenshot saving
- MP4/WebM/GIF viewport recording via ffmpeg
- saved workflow recording, listing, replay, rename, delete, and export
- `/workflows` library UI
- inspect / text extraction primitives

### Explicitly deferred

- Safari/WebKit support, which Puppeteer does not provide
- mobile-only browser automation for Samsung Internet, UC Browser, and Android Browser
- full Firefox parity
- raw CDP escape-hatch tooling
- browser extension injection
- advanced DOM replay / self-healing selectors
- Chrome DevTools Recorder import/export parity
- OS-level browser chrome/window recording (current recording captures the page viewport)
- remote/cloud browser providers
- login/session import from personal browser profiles

## 9. Firefox plan

The current code structure should allow adding Firefox by implementing a dedicated adapter while keeping the same Pi tool contract.

Expected differences:

- protocol defaults move from CDP to WebDriver BiDi
- feature parity for accessibility / inspect may differ
- attach semantics may require separate handling from Chromium attach

That is why the tool surface must stay generic while the adapter layer stays protocol-aware.

## Recommended implementation sequence

1. scaffold the Pi package
2. implement config loading + browser discovery
3. implement session manager
4. implement Chromium launch + attach
5. implement core actions
6. implement inspect + screenshot
7. validate with Chrome/Edge/Brave/Opera/Vivaldi/Yandex configs
8. add Firefox parity next milestone

## Source notes

Key references used in the design:

- Puppeteer WebDriver BiDi docs: https://pptr.dev/webdriver-bidi
- Puppeteer connect options: https://pptr.dev/api/puppeteer.connectoptions
- Playwright BrowserType docs: https://playwright.dev/docs/api/class-browsertype
- Browser Use repository: https://github.com/browser-use/browser-use
- Browser Use CDP rationale post: https://browser-use.com/posts/playwright-to-cdp
- Stagehand repository: https://github.com/browserbase/stagehand
- Stagehand architecture docs: https://browserbase-stagehand.mintlify.app/concepts/how-stagehand-works
