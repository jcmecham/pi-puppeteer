# Contributing

Thanks for contributing to `pi-puppeteer`.

## Development setup

```bash
npm install
```

Requirements:

- Node.js 22+
- Pi installed locally
- At least one supported Chromium-family browser for smoke testing

## Common commands

```bash
npm run check
npm run validate
npm run publish:check
npm run configure
```

What they do:

- `npm run check` — type-check the project
- `npm run validate` — clean generated output and type-check
- `npm run publish:check` — validate and preview the npm tarball
- `npm run configure` — write local project browser defaults

## Local testing in Pi

Run the extension directly from the repo:

```bash
pi -e .
```

Or install it into the current project:

```bash
pi install . -l
```

Suggested smoke-test flows before opening a PR or publishing:

1. Start a browser session.
2. Navigate to a page and run a simple click/type flow.
3. Capture a screenshot.
4. Run `inspect` or `extract_text`.
5. Record and stop a short workflow or viewport recording.

## Code and docs expectations

- Keep the public tool surface stable and clearly documented.
- Update `README.md` when user-facing behavior changes.
- Update `docs/architecture.md` when architectural direction changes.
- Add a changelog entry for notable user-facing changes.
- Keep runtime dependencies in `dependencies` and Pi-shared packages in `peerDependencies`.

## Release checklist

Before publishing:

```bash
npm run publish:check
```

Then verify:

- package metadata is correct in `package.json`
- the tarball contents look intentional
- `README.md` matches the current tool surface
- the changelog reflects the release
- npm trusted publishing is configured for this repo, or `NPM_TOKEN` exists in GitHub secrets

Release with:

```bash
npm version patch
git push && git push --tags
```

Then publish the corresponding GitHub Release. The `publish` workflow will publish to npm automatically.

After publishing, verify install from Pi:

```bash
pi install npm:pi-puppeteer
```
