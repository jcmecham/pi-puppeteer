# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Sessions are now throwaway by default: opening a browser asks nothing, and everything the session
  signs in to is discarded when it closes. Because each one gets its own profile directory, several
  browsers can now run at the same time.
- `save_profile` keeps a throwaway session's signed-in state under a name you choose. It applies
  immediately and the browser keeps running — nothing closes, restarts, or is copied. In the Browser
  Manager it is `S`; `L` loads a browser on a saved profile.
- Orphaned throwaway profiles left behind by a crash are swept on the next Pi session.
- Closing a throwaway session now says what is about to be discarded, behind the existing confirm.
- Screen control hints now wrap instead of being cut off. The Browser Manager's row had grown past
  what a 120-column terminal could show, and because the hints run from routine to rare the first one
  lost was `Esc back`.

### Fixed

- A migration that could never finish. A profile was treated as in use whenever a browser lock file
  was present, but Firefox creates `parent.lock` once and never removes it — it holds the file open
  exclusively while running instead. Any Firefox profile that had ever run therefore reported as open
  forever, deferring its move and reporting "a browser still has them open" on every Pi start, with
  no action a user could take to clear it. Lock files are now tested rather than counted: Windows asks
  the OS whether the marker is actually held, and POSIX reads the pid out of the lock symlink so a
  crashed browser's leftovers are recognised as stale.
- A truncated cell no longer bleeds its colour across the rest of the row. Cutting a styled string to
  fit a column dropped that style's reset, so a long browser or profile name coloured the padding
  after it and ran on into the next column, and on into the border.

### Changed

- **Breaking:** `browser start` without a `profile` now opens a throwaway session instead of using a
  profile named `default`. Nothing it signs in to is kept, and each call opens a separate browser
  rather than reusing an existing one. Pass `profile` to get the previous behaviour; a name that does
  not exist yet is created on first use. Your existing `default` profile is untouched and still opens
  with `profile: "default"`.
- Profile names are stored verbatim rather than being sanitized into a directory name, so `My Work!`
  stays `My Work!`. A profile's directory is named by a separate ID, recorded along with the name in a
  `.pi-puppeteer-profile.json` file inside it. Existing profiles need no migration and are not moved.
- `rename_profile` now works while a browser is running on the profile, because it no longer moves
  anything on disk. `delete_profile` still requires the profile to be idle.
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
  auto-generated, so deriving from them would have made unrelated projects collide by default. The
  Browser Manager prompts for the profile instead of choosing one for you.
- Starting a session on a profile another Pi session already has open now adopts that browser instead
  of launching a second one, and leaves it running when the adopting session ends.
- `<cwd>/.pi/.pi-puppeteer/` is created lazily on first write instead of on every Pi session start.
- Screenshots, recordings, workflows, and `settings.json` remain project-local.

### Added

- `list_profiles` browser action, reporting every profile in the shared root, whether a browser is
  currently running on it, and which project started it.
- The Browser Manager now asks which profile to open, showing each one's state, instead of launching
  blind and discovering a collision afterwards. Picking a running profile connects to that browser.
- `rename_profile` and `delete_profile` actions, with rename and delete also available from the
  profile picker. Both refuse while a browser is running on the profile, including one started by Pi
  in another project.
- Naming a profile now happens on its own screen in the Browser Manager's frame, previewing the name
  as it will be stored and refusing one that is already taken.
- `profileScope` config key (`"global"` or `"project"`, default `"global"`).
- `<cwd>/.pi/.pi-puppeteer/.gitignore` is written whenever the storage directory exists, so runtime
  state cannot be staged by accident.
- Migration results are reported at session start, covering moved, deferred, and conflicting profiles.
- `npm run verify`, a dependency-free harness covering the storage layout, migration, profile
  discovery and management, and screen geometry, wired into `npm run validate` and run on both Ubuntu
  and Windows in CI.

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
