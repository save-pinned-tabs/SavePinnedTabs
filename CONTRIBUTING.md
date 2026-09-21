# Development Documentation

## Requirements

On Linux, install Nix with flakes enabled. Then enter the development shell:

```sh
nix develop
```

The shell supplies Node.js 22, Chromium, Firefox Developer Edition, and GeckoDriver.
Install the JavaScript dependencies after you enter the shell:

```sh
npm ci
```

On macOS or without Nix, install Node.js 22 and both browsers separately.
Set `CHROMIUM_BINARY` and `FIREFOX_BINARY` to the browser executable paths.

## Commit Messages

All commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<optional scope>): <description>
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `build`, `ci`.
- Description in lowercase, imperative mood, no trailing period.
- Breaking changes: append `!` after the type/scope and note them in a `BREAKING CHANGE:` footer.
- Examples: `feat(popup): add search filter for pinned tabs`, `fix: persist pinned set on browser restart!`

## Coding Standards

Add a concise JSDoc comment to every function, method, class, interface, and type alias in `src`.
Describe the behavior, purpose, invariants, side effects, or error conditions that are not clear from the signature.

## Tests

The npm scripts are the test interface for local development and CI:

```sh
npm run test:unit
npm run test:e2e
npm run test:e2e:brave
npm run test:e2e:firefox
npm run test:e2e:environment:chromium
npm run test:e2e:environment:firefox
npm test
```

The extension runtime source is in `src/**/*.ts`. Test scripts compile it before they run.
Unit and browser tests load JavaScript from `.extension-build`. This directory is generated and is not tracked.

The environment suite is intentionally excluded from the default test command because it exercises real browser quota limits and persistent-profile recovery. See [`docs/environment-e2e.md`](docs/environment-e2e.md) for its automated coverage and the reproducible manual recipes for authenticated Sync, private browsing, forced termination, startup settings, and upgrades.

You can run a command without entering the development shell:

```sh
nix develop -c npm test
```

## Browser Test Parity

Chromium and Firefox end-to-end suites must cover the same observable behaviors and browser edge cases.
Use one focused test for each behavior. Keep corresponding scenario names and assertions aligned across both suites.

Chromium exercises Manifest V3 worker suspension directly because Playwright exposes its service-worker target. Firefox's WebDriver surface does not expose a supported way to suspend the extension background worker, so Firefox covers the equivalent browser-restart boundary instead. Assigned shortcut testing is not applicable because browser commands were removed in PR #107 pending further product design.

## Modify Sets Schema

After you modify the sets schema, update `schema/sets.json`. Then regenerate the validation script:

`npm run compile-sets-schema`

Storage readers normalize missing optional fields in a current-version document.
They reject documents with invalid required fields before the data enters application modules.

## Launch extension in isolated browser profile

- Create a new browser profile:

  - Chromium: `npm run new-profile:chromium`
  - Chromium Mac OS: `npm run new-profile:chromium-mac`
  - Firefox: `npm run new-profile:firefox`
  - Firefox Mac OS: `npm run new-profile:firefox-mac`
  - Brave: `npm run new-profile:brave`
  - Brave: `npm run new-profile:vivaldi`

- Run the extension within the new profile, saving data to the profile

  - Chromium: `npm run run:chromium`
  - Chromium Mac OS: `npm run run:chromium-mac`
  - Firefox: `npm run run:firefox`
  - Firefox Mac OS: `npm run run:firefox-mac`
  - Brave: `npm run run:brave`
  - Brave: `npm run run:vivaldi`

## Build

- Set the version number in package.json

- Set the version number in `src/manifest.json`

- Build the extension

  `npm run build`

- The extension archive will be saved to `dist/save_pinned_tabs-X.Y.Z.zip`
