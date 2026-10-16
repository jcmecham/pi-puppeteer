# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-15

### Security

- Browser profiles are no longer written into project directories. Profiles hold cookies and session
  tokens, so a `git add -A` in a project that had one could stage live credentials ([#3]).

### Added

- Firefox is a real engine now rather than a reserved seat. It launches on named and throwaway
  profiles, attaches to a Firefox you started yourself, adopts one an earlier Pi session left
  running, and does everything the Chromium engines do — navigate, click, type, inspect, screenshot,
  record, and record and replay workflows. What differs is that Firefox allows exactly one automation
  session per browser, so two Pi sessions cannot share one window the way two can share Chrome. The
  second one is told which project is holding it, by name, instead of failing obscurely ([#8]).
- `emulate` works on a Firefox that predates the `emulation.*` BiDi commands, which means the whole
  140 ESR line. Puppeteer sets the viewport and the screen orientation in one batch, so on an older
  browser the orientation command it cannot answer failed the entire call and no viewport was ever
  applied. Pi now re-issues the part that works and names the refinements — orientation, touch, user
  agent — the browser was too old for, instead of throwing a protocol stack trace. Checking a layout
  at a phone width works on every Firefox back to 140.
- An action that fails because the browser build is too old now says which command is missing.
  Firefox reports these as a protocol error wrapped around a `chrome://` stack trace, which buried
  the one useful word in several screens of noise.
- Pi writes six preferences into a marked block in a Firefox profile's `user.js` and leaves the
  rest of the file alone. Puppeteer's own Firefox support writes about sixty, one of which switches
  the password manager off — reasonable for a test harness, wrong for a profile whose entire job is
  staying signed in, and permanent, because a `user.js` value outlives the file it came from.
- Starting a session on a profile your own Firefox already has open now fails in under a second with
  an explanation. Firefox answers a second process on one profile with a modal dialog, so without
  this the launch sat behind it until it timed out.
- Attach defaults are per engine. `attach` with no endpoint now reaches `ws://127.0.0.1:9222/session`
  for Firefox instead of a Chromium DevTools URL that could never have answered — Firefox 152 serves
  no HTTP debugging endpoint at all.
- Sessions are now throwaway by default: opening a browser asks nothing, and everything the session
  signs in to is discarded when it closes. Because each one gets its own profile directory, several
  browsers can now run at the same time.
- `save_profile` keeps a throwaway session's signed-in state under a name you choose. It applies
  immediately and the browser keeps running — nothing closes, restarts, or is copied. In the Browser
  Manager it is `S`; `L` loads a browser on a saved profile.
- Orphaned throwaway profiles left behind by a crash are swept on the next Pi session.
- Closing a throwaway session now says what is about to be discarded, behind the existing confirm.
- `list_profiles` browser action, reporting every profile in the shared root, whether a browser is
  currently running on it, and which project started it.
- The Browser Manager's profile picker shows each profile's state, and picking a running profile
  connects to that browser instead of launching a second one.
- `rename_profile` and `delete_profile` actions, also available from the profile picker. Renaming
  works while a browser is running on the profile; deleting refuses while one is, including one
  started by Pi in another project.
- Naming a profile now happens on its own screen in the Browser Manager's frame, previewing the name
  as it will be stored and refusing one that is already taken.
- `profileScope` config key (`"global"` or `"project"`, default `"global"`).
- `<cwd>/.pi/.pi-puppeteer/.gitignore` is written whenever the storage directory exists, so runtime
  state cannot be staged by accident.
- Migration results are reported at session start, covering moved, deferred, and conflicting profiles.
- Screen control hints now wrap instead of being cut off. The Browser Manager's row had grown past
  what a 120-column terminal could show, and because the hints run from routine to rare the first one
  lost was `Esc back`.
- `npm run verify`, a dependency-free harness covering the storage layout, migration, profile
  discovery and management, and screen geometry, wired into `npm run validate` and run on both Ubuntu
  and Windows in CI.

### Changed

- **Breaking:** `browser start` without a `profile` now opens a throwaway session instead of deriving
  a profile from the session name. Nothing it signs in to is kept, and each call opens a separate
  browser rather than reusing an existing one. Pass `profile` to keep a browser's state; a name that
  does not exist yet is created on first use, and an existing profile such as `default` still opens
  by name.
- **Breaking:** browser profiles now live under `~/.pi/agent/extensions/pi-puppeteer/profiles/<browser>/<profile>`
  and are shared across projects by name. Existing project profiles are moved there automatically on
  the first run, and never merged: a profile whose name already exists globally is left in the project
  and reported. Set `"profileScope": "project"` to keep the previous layout.
- **Breaking:** a `profileRoot` of `.pi/.pi-puppeteer/profiles` (the old default, which the README
  handed out as boilerplate) now resolves to the shared global root. Any other value is honoured
  verbatim.
- Starting a session on a profile another Pi session already has open now adopts that browser instead
  of launching a second one, and leaves it running when the adopting session ends.
- Profile names are stored verbatim rather than being sanitized into a directory name, so `My Work!`
  stays `My Work!`. A profile's directory is named by a separate ID, recorded along with the name in a
  `.pi-puppeteer-profile.json` file inside it. Existing profiles need no migration and are not moved.
- `<cwd>/.pi/.pi-puppeteer/` is created lazily on first write instead of on every Pi session start.
- Screenshots, recordings, workflows, and `settings.json` remain project-local.
- The Browser Manager no longer changes height while you use it. Its screens are drawn inline rather
  than as an overlay, so every line the box grew or shrank by repainted everything below it — and the
  box grew or shrank on almost every keypress: the `… earlier` / `… more` markers appeared only when
  the list overflowed, `S save profile` only for a throwaway session, the warning row only when a
  close was armed, and closing collapsed the whole control block to one line. All of those rows are
  now always reserved, and a hint that does not apply is dimmed rather than removed. The screen's
  height is now decided by the number of rows and the terminal width, and by nothing else; the
  profile picker and the new default-browser picker are held to the same rule.
- Renaming a browser and changing the default browser are drawn in the Browser Manager's own frame
  instead of dropping out to a generic prompt and list. Renaming a browser now also rejects a blank
  or duplicate name in the field, the way naming a profile does.
- Opening, showing, closing, renaming, and saving a browser now run with the Browser Manager still on
  screen, saying what they are doing, rather than handing the terminal back to the editor for the
  duration. Looking for profiles does the same, which matters most where it is slowest: discovery
  probes each profile with a timeout, and that wait used to happen on a blank editor.
- Internal: a live profile's ownership record names the engine that holds it, so an endpoint can
  never be handed to the wrong protocol. Records written by earlier versions still read correctly.
  No configuration changes.

### Fixed

- `Alt+B`, `Alt+R`, and `Alt+S` did nothing in terminals that negotiate a modern keyboard protocol,
  VS Code's among them. The shortcuts were matched by comparing the raw bytes against `ESC` plus the
  letter, which is only how a terminal speaking neither protocol sends them. Pi queries for the Kitty
  keyboard protocol on startup and falls back to xterm's `modifyOtherKeys`, and under either one the
  same keypress arrives as `\x1b[98;3u` or `\x1b[27;3;98~` instead, so the comparison silently never
  fired. Matching now goes through Pi's own protocol-aware `matchesKey`.
- `emulate` claimed in a comment to run over CDP whichever browser it was talking to. On Firefox it
  runs over WebDriver BiDi, and it now says what Firefox does not do — there is no `isMobile`
  equivalent, and changing touch emulation reloads the tab — rather than quietly not doing it.
- A truncated cell no longer bleeds its colour across the rest of the row. Cutting a styled string to
  fit a column dropped that style's reset, so a long browser or profile name coloured the padding
  after it and ran on into the next column, and on into the border.
- Browser teardown no longer force-kills a browser owned by a different Pi session, and no longer
  reaps a browser whose profile path merely shares a prefix with the one being torn down
  (`.../default` used to kill `.../default-2`).
- Profile names can no longer resolve outside the profile root.

[#3]: https://github.com/jcmecham/pi-puppeteer/issues/3
[#8]: https://github.com/jcmecham/pi-puppeteer/issues/8

## [0.2.0] - 2026-07-03

### Added

- Added a `browser` tool `emulate` action for mobile/device emulation using Puppeteer known device presets such as `iPhone 13`, `Pixel 5`, and `iPad Pro`.
- Added custom viewport emulation options for width, height, mobile viewport behavior, touch support, device scale factor, and optional user-agent override.
- Documented mobile emulation usage in the README.

## [0.1.4] - 2026-06-21

### Fixed

- Handled stale browser session closes gracefully.
- Kept the browser manager open after closing sessions.
- Fixed custom TUI key handling in the browser manager.
- Fixed the npm trusted publishing workflow.

### Changed

- Refined README installation and usage documentation.
- Updated development dependencies for stability and feature support.

## [0.1.3] - 2026-06-07

### Changed

- Bumped package metadata for the 0.1.3 release.

## [0.1.2] - 2026-06-07

### Changed

- Switched the release workflow to npm trusted publishing.

## [0.1.1] - 2026-06-07

### Added

- Added system default browser resolution for launch flows.
- Added ffmpeg-backed browser recording support.
- Added workflow recording, replay, export, rename, delete, and library management.
- Added browser session manager UI and session reuse support.
- Added publish-ready package metadata, MIT license, release validation script, CI workflow, README badges, automated npm publish workflow, and contributor documentation.

### Changed

- Polished the browser manager default-browser experience.
- Updated browser manager shortcut hints from `Alt+P` to `Alt+B`.

## [0.1.0] - 2026-06-07

### Added

- Initial Pi package for browser automation built on `puppeteer-core`.
- Added Chromium-family browser discovery, launch, and attach flows.
- Added browser session and tab management.
- Added page navigation, interaction, inspection, text extraction, and screenshot support.
- Added project-scoped browser profiles, artifacts, and settings.
