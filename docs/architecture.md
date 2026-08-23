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

Two adapters ship:

- `ChromiumAdapter` via Puppeteer + CDP semantics
- `FirefoxAdapter` via Puppeteer + WebDriver BiDi

They differ in how they find a browser's endpoint and in whether a live browser can be shared, not in
the contract above them. See §9.

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
- profile scope (`global` or `project`) and an explicit profile root override
- artifact root
- default timeout / headless / waitUntil
- browser definitions
  - `displayName`
  - `engine`
  - `executablePath`
  - `launchArgs`
  - attach defaults such as `browserURL` or `browserWSEndpoint`

## 4. Profile model

Named profiles are stored on disk under a Pi-managed folder, outside any project directory.

Example:

- `~/.pi/agent/extensions/pi-puppeteer/profiles/chrome/default`
- `~/.pi/agent/extensions/pi-puppeteer/profiles/edge/work`

This gives persistent login/session state without requiring the extension to reuse a user’s personal everyday browser profile.

Profiles were project-local through 0.2.x. They moved for three reasons: a profile holds cookies and
session tokens and so must never sit where `git add -A` can reach it; a single Chromium profile runs
to hundreds of megabytes across thousands of cache files, duplicated per project; and a per-project
profile forces a fresh sign-in for every repository.

Profiles are keyed by name, not by project, so the same name means the same profile everywhere. The
name is taken from the `profile` input. It is deliberately *not* derived from the session label —
labels are auto-generated (`Browser-1`, `Browser-2`), so deriving from them would make unrelated
projects collide by default.

Set `profileScope: "project"` to restore the old layout.

## 4bis. Persistence is opt-in

Omitting `profile` gives a **throwaway** session: a fresh user data dir that is deleted when the
session ends. This is the default because the common case does not want it any other way — most
automation neither needs a signed-in profile nor wants one accumulating hundreds of megabytes of cache
per run, and requiring an answer about persistence before a browser could open made the cheap case pay
for the rare one.

Two consequences fall out of it:

- **Concurrency.** Chromium allows one process per `--user-data-dir`, so the old shared `default`
  profile silently made a second browser impossible. A unique directory per launch removes that limit,
  and `start` without a profile therefore never reuses or adopts: each call is a separate browser.
- **Cleanup has to be certain.** A throwaway directory is removed when its session ends, on both exit
  paths — `stop`, and the disconnect that arrives when the user closes the window. A crash skips both,
  so `session_start` sweeps any throwaway directory no live browser holds. The sidecar below is what
  makes that judgement safe rather than a guess about directory names.

## 4c. Profile identity lives in a sidecar

A profile's identity used to be its directory name: `profiles/chrome/work` *was* the profile "work".
That made "keep this running session" impossible without closing the browser, because renaming meant
moving a live `--user-data-dir`:

- Windows refuses the rename with `EPERM`/`EBUSY` while Chromium holds handles inside the directory.
- POSIX lets it succeed, and then Chromium cannot create new files at the old path it still has cached.
- Copying instead is worse: the `Cookies` and `Local State` SQLite databases can be caught
  mid-transaction, and the corruption is silent until the profile is next opened.

So the directory name is now an opaque ID and the display name lives in `.pi-puppeteer-profile.json`
inside the directory, beside `.pi-puppeteer-owner.json`. Saving a throwaway session, or renaming a
saved profile, is one small JSON write: nothing moves and the running browser never notices. Deleting
still requires an idle profile, because removing a live directory genuinely does break the browser
holding it.

The rules that matter:

- **Nothing is ever renamed on disk.** A saved profile's ID is derived from its name so paths stay
  readable, but it is fixed at creation. After a rename the ID and the display name can differ; that is
  the price of never touching a live directory, and it is deliberate.
- **No migration.** A directory with no sidecar is a profile whose ID happens to equal its name — which
  is exactly what every pre-0.4 directory is. The sidecar is written lazily on first discovery, and the
  directory keeps its name.
- **Names are stored verbatim.** Only the ID is sanitized, so a profile can be called `My Work!`
  without that reaching a path. A traversal in a display name is inert for the same reason.
- **Throwaway IDs carry a `tmp-` prefix**, so the sweep can still recognise one whose sidecar was lost.

## 4a. Storage layout and migration

Two roots, split by what the data is:

- **project** — `<cwd>/.pi/.pi-puppeteer/`: `settings.json`, `artifacts/`, `workflows/`. Created
  lazily, on first write, and carries a `.gitignore` of `*` / `!.gitignore`.
- **global** — `<agentDir>/extensions/pi-puppeteer/`: `profiles/`.

Legacy project profiles migrate on the first `loadConfig` that resolves to the global root, memoized
per project for the process lifetime. The rules that matter:

- **Never merge.** A profile is moved whole with `renameSync`, or not at all. Two same-named profiles
  from different projects would otherwise interleave their `Cookies`, `Local State`, `Preferences`,
  and IndexedDB and corrupt both. First project to migrate wins; the rest are reported and left.
- **Only `EXDEV` earns a copy.** `EPERM`/`EBUSY`/`EACCES` mean a browser holds the profile open, so
  migration defers and retries on a later session rather than copying live files.
- **Cross-volume copies stage and swap.** The copy lands beside the target and is renamed into place,
  so a target directory never exists half-written.

## 4b. Profile ownership across processes

Chromium allows one browser process per `--user-data-dir`; a second launch forwards its command line
to the running instance and exits. With profiles shared across projects, two Pi sessions can want the
same profile, so a session records ownership inside the user data dir (`.pi-puppeteer-owner.json`:
pid, host, state, DevTools URL).

- A session finding a live owner **adopts** that browser: it connects, and on teardown disconnects
  rather than closing or reaping.
- Liveness is always confirmed by a real request to the DevTools endpoint. A pid alone is not enough,
  because Windows recycles pids.
- Process reaping sweeps by user data dir **only** while this process owns the profile, and matches
  the whole `--user-data-dir` argument — a prefix match would let `.../default` reap `.../default-2`.

Ownership is also readable ahead of time. `discoverProfiles` walks the profile root and resolves each
entry to free, starting, or live, probing candidates concurrently because each probe can wait on a
network timeout. It backs the `list_profiles` action and the Browser Manager’s profile picker, so a
contended profile is a visible choice rather than a surprise at launch.

Deleting a profile goes through the same liveness check and refuses while a browser holds the profile,
whether that is a session in this process or a Pi session in another project, because removing a live
user data dir corrupts it. Renaming does not need the check: since §4c it changes only the sidecar.

Detection sees only browsers exposing a debugging endpoint. That covers everything Pi launches; a
browser the user started themselves on the same profile is invisible to it and will collide at launch.

## 5. Session model

A session ID maps to one connected browser instance.

Each session tracks:

- browser identity
- engine
- connection mode (`launch` or `attach`)
- profile name when relevant
- whether the browser was adopted from another process, which decides between disconnect and close on teardown
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
- executable discovery for major Chromium browsers and Firefox
- launch configured browsers with named profiles
- launch, adopt, and attach Firefox over WebDriver BiDi
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
- two Pi sessions driving one Firefox window at the same time: Firefox allows one WebDriver session
  per browser process (Bug 1720707)
- recovering a Firefox left running by a Pi process that was killed outright; its session cannot be
  recreated, so the window has to be closed
- raw CDP escape-hatch tooling
- browser extension injection
- advanced DOM replay / self-healing selectors
- Chrome DevTools Recorder import/export parity
- OS-level browser chrome/window recording (current recording captures the page viewport)
- remote/cloud browser providers
- login/session import from personal browser profiles
- recovering a throwaway session's data after it has closed
- merging two same-named browser profiles from different projects
- per-project isolation of a shared profile (use a distinct `profile` name instead)

## 9. Firefox

Firefox is implemented, over WebDriver BiDi, behind the same `BrowserAdapter` contract as Chromium.
The tool surface above it does not branch on engine anywhere; the manager passes `engine` to
`getAdapter` and is otherwise unaware of which protocol it is talking. What follows is the record of
where the two adapters genuinely differ and why, so the differences are not rediscovered as bugs.

**Finding the endpoint.** Chromium writes `DevToolsActivePort` and answers `/json/version` over HTTP.
Firefox 152 has no CDP at all — no `cdp/` component, no `/json/version`, no `remote.active-protocols`
pref to turn one on — so neither half of that pair exists. Its equivalents are
`WebDriverBiDiServer.json` in the profile directory, holding `{ws_host, ws_port}`, and the
`session.status` command over the WebSocket at `/session`. The adapter waits on the file rather than
on the `WebDriver BiDi listening on …` line Firefox also prints to stderr, because the file is the
only signal *another Pi process* can read, which is the whole point of the parallel. The stderr line
is kept as a fallback and, more usefully, as the text attached to a failed launch: Firefox's own last
words are the only explanation available when a launch does not come up, and the Chromium adapter has
none.

**One session per browser.** `WebDriverBiDi.createSession` throws `SessionNotCreatedError("Maximum
number of active sessions")` if a session already exists; the source comment cites Bug 1720707. That
makes `session.status` a three-state probe rather than a liveness check — nothing listening, listening
and adoptable, listening and taken — and it is why `ProfileState`'s live variant carries
`sessionAvailable` for Firefox. Two Pi sessions cannot share one Firefox window, and the second is
told which project holds the first.

Adoption still works in one direction. Firefox releases its session on `session.end`, which is what
puppeteer's `browser.disconnect()` sends, so a browser an earlier client let go of can be picked up.
A dropped socket instead runs `onConnectionClose`, which unregisters the connection and leaves the
session attached to nothing. The honest failure mode: a Pi process killed outright leaves a Firefox
that is running, holding its profile, and impossible to reconnect to. Nothing can be done from this
side; the window has to be closed, and the error says so. (On Windows the case is largely theoretical
— the spawned browser shares the parent's job object and dies with it.)

**Preferences.** `puppeteer.launch` is avoided for Firefox, and not for Chromium's Edge-refork reason.
It would call `@puppeteer/browsers`' `createProfile`, which writes about sixty preferences into
`user.js`. The asymmetry that makes that unacceptable here: Firefox's own `RecommendedPreferences`
applies an overlapping list at startup and clears it again at `xpcom-shutdown`, so nothing it does
persists — but a `user.js` value is copied into `prefs.js` on every start and survives deletion of
`user.js`. One launch would therefore point a saved profile's `services.settings.server` at
`http://dummy.test/` permanently.

So the adapter provisions the profile itself, writing only what Firefox does not already handle
(`fission.webContentIsolationStrategy`, first-run and startup-page suppression) plus the one thing
Firefox handles in a way that is wrong here: it sets `signon.rememberSignons` and
`signon.autofillForms` to `false` whenever a debugging port is passed, which would make a saved
profile silently incapable of the one thing saved profiles are for. `applyPreferences` skips any pref
that already has a user value, so writing them into `user.js` is the supported way to win.

**Colliding with a browser Pi did not start.** Chromium's second launch on a held profile forwards its
command line and exits — silent and survivable. Firefox's puts a modal dialog on screen and the
endpoint poll then waits out its full timeout behind it. The Firefox adapter therefore checks
`browserHoldsProfile` before spawning and refuses with an explanation. That check stays inside the
adapter rather than becoming a fourth `ProfileState`: as a state it would change Chromium's answer
for the same situation and invent a live profile with no endpoint to connect to, to solve a problem
one guard already solves.

**Process reaping** is shared (`src/adapters/reap.ts`), parameterised only by how each family spells
its profile on the command line — Chromium joins it (`--user-data-dir=<dir>`), Firefox passes it as a
separate argv entry (`--profile <dir>`, quoted when the path has spaces). Both matchers anchor the end
of the argument so `…/default` cannot reap `…/default-2`.

## Recommended implementation sequence

1. scaffold the Pi package
2. implement config loading + browser discovery
3. implement session manager
4. implement Chromium launch + attach
5. implement core actions
6. implement inspect + screenshot
7. validate with Chrome/Edge/Brave/Opera/Vivaldi/Yandex configs
8. add the Firefox adapter over WebDriver BiDi (done; see §9)

## Source notes

Key references used in the design:

- Puppeteer WebDriver BiDi docs: https://pptr.dev/webdriver-bidi
- Puppeteer connect options: https://pptr.dev/api/puppeteer.connectoptions
- Playwright BrowserType docs: https://playwright.dev/docs/api/class-browsertype
- Firefox WebDriver BiDi docs: https://firefox-source-docs.mozilla.org/remote/index.html
- Bugzilla 1773393, why `fission.webContentIsolationStrategy` must be 0: https://bugzilla.mozilla.org/show_bug.cgi?id=1773393
- Bugzilla 1720707, one WebDriver session per Firefox: https://bugzilla.mozilla.org/show_bug.cgi?id=1720707
- Browser Use repository: https://github.com/browser-use/browser-use
- Browser Use CDP rationale post: https://browser-use.com/posts/playwright-to-cdp
- Stagehand repository: https://github.com/browserbase/stagehand
- Stagehand architecture docs: https://browserbase-stagehand.mintlify.app/concepts/how-stagehand-works
