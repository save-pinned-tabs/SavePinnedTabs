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

## Tests

The npm scripts are the test interface for local development and CI:

```sh
npm run test:unit
npm run test:e2e
npm run test:e2e:firefox
npm test
```

You can run a command without entering the development shell:

```sh
nix develop -c npm test
```

## Browser Test Parity

Chromium and Firefox end-to-end suites must cover the same observable behaviors and browser edge cases.
Use one focused test for each behavior. Keep corresponding scenario names and assertions aligned across both suites.

## Modify Sets Schema

After you modify the sets schema, update `schema/sets.json`. Then regenerate the validation script:

`npm run compile-sets-schema`

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
