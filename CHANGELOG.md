# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-03

### Added

- Added a `browser` tool `emulate` action for mobile/device emulation using Puppeteer known device presets such as `iPhone 13`, `Pixel 5`, and `iPad Pro`.
- Added custom viewport emulation options for width, height, mobile viewport behavior, touch support, device scale factor, and optional user-agent override.
- Documented mobile emulation usage in the README.

## [0.1.4] - 2026-06-21

### Fixed

- Handled stale browser session closes gracefully.
- Kept the browser manager open after closing sessions.
- Fixed custom TUI key handling.
- Fixed the npm trusted publishing workflow.

### Changed

- Refined README installation and usage documentation.
- Updated development dependencies for stability and feature support.

## [0.1.3] - 2026-06-07

### Changed

- Prepared the 0.1.3 release metadata.

## [0.1.2] - 2026-06-07

### Changed

- Switched the release workflow to npm trusted publishing.

## [0.1.1] - 2026-06-07

### Added

- Added publish-ready package metadata, MIT license, release validation script, CI workflow, README badges, automated npm publish workflow, and contributor documentation.

## [0.1.0] - 2026-06-07

### Added

- Initial Pi package for browser automation built on `puppeteer-core`.
- Chromium-family browser discovery, launch, and attach flows.
- Browser session and tab management.
- Page navigation, interaction, inspection, text extraction, screenshots, and recordings.
- Workflow recording, replay, export, rename, delete, and library management.
- Project-scoped browser profiles, artifacts, and settings.
