# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-20

### Security

- Browser profiles are no longer written into project directories. Profiles hold cookies and session
  tokens, so a `git add -A` in a project that had one could stage live credentials ([#3]).

### Changed

- **Breaking:** browser profiles now live under `~/.pi/agent/extensions/pi-puppeteer/profiles/<browser>/<profile>`
  and are shared across projects by name. Existing project profiles are moved there automatically on
  the first run, and never merged: a profile whose name already exists globally is left in the project
  and reported. Set `"profileScope": "project"` to keep the previous layout.
- **Breaking:** a `profileRoot` of `.pi/.pi-puppeteer/profiles` (the old default, which the README
  handed out as boilerplate) now resolves to the shared global root. Any other value is honoured
  verbatim.
- **Breaking:** the profile for a new session is no longer derived from the session name; it defaults
  to `default`. Pass `profile` explicitly for a separate browser window. Session labels are
  auto-generated, so deriving from them would have made unrelated projects collide by default.
- Starting a session on a profile another Pi session already has open now adopts that browser instead
  of launching a second one, and leaves it running when the adopting session ends.
- `<cwd>/.pi/.pi-puppeteer/` is created lazily on first write instead of on every Pi session start.
- Screenshots, recordings, workflows, and `settings.json` remain project-local.

### Added

- `profileScope` config key (`"global"` or `"project"`, default `"global"`).
- `<cwd>/.pi/.pi-puppeteer/.gitignore` is written whenever the storage directory exists, so runtime
  state cannot be staged by accident.
- Migration results are reported at session start, covering moved, deferred, and conflicting profiles.
- `npm run verify:storage`, a dependency-free harness covering the storage layout and migration, wired
  into `npm run validate` and run on both Ubuntu and Windows in CI.

### Fixed

- Browser teardown no longer force-kills a browser owned by a different Pi session, and no longer
  reaps a browser whose profile path merely shares a prefix with the one being torn down
  (`.../default` used to kill `.../default-2`).
- Profile names can no longer resolve outside the profile root.

[#3]: https://github.com/jcmecham/pi-puppeteer/issues/3

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
