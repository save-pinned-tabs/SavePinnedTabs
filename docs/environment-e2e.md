# Browser environment and recovery test matrix

These scenarios are intentionally outside the default E2E suite. They require persistent browser profiles, destructive browser termination, browser-version changes, or signed-in Sync accounts. Use disposable profiles and accounts. Never put credentials, profile archives, recovery codes, or cookies in this repository.

## Automated quota and recovery suites

Run:

```sh
npm run test:e2e:environment:chromium
npm run test:e2e:environment:firefox
```

The suites use disposable browser profiles and the real browser `storage.sync` API. Chromium relaunches the persistent profile with the unpacked extension supplied again on the command line. Firefox installs a temporary add-on into the profile after every relaunch. These are storage-recovery checks across browser process boundaries; they do **not** prove that a normally installed extension remains installed across restart.

- Firefox rejects one item whose JSON-encoded UTF-8 value plus key exceeds 8,192 bytes.
- Firefox rejects writes after the 102,400-byte aggregate quota is reached and retains every preceding readable item.
- In Firefox and Chromium, a non-ASCII legacy collection larger than 8,192 bytes migrates after a browser relaunch that supplies the unpacked or temporary extension again, the popup lists and loads every set, and the active version-4 generation uses gzip-base64 chunks no larger than the 6 KiB safe payload size.
- Compression reduces the repetitive quota fixture from multiple raw chunks to one retrieved chunk while preserving the complete document.
- In Firefox and Chromium, a generation near the 102,400-byte aggregate quota can be replaced by another generation that fits alone, without requiring both generations to coexist in Sync.
- The normal browser commands exclude these expensive scenarios.

Firefox measures the JSON-stringified value plus key bytes. Assertions deliberately accept browser-version-specific error wording but require an actual rejected `storage.sync.set()` call. This is product and browser behavior, not a storage mock.

The current harness cannot faithfully automate a persisted, normally installed Firefox extension: WebDriver's `installAddon(path, true)` creates a temporary installation that Firefox removes on shutdown. A retained-extension restart needs a signed XPI installed persistently in a disposable profile and remains a manual environment scenario. Record it separately from the automated temporary-reinstall scenarios.

Chromium/Firefox parity is defined by the observable storage, migration, popup, and Autoload results after the documented relaunch boundary—not by identical installation lifecycles. A result must identify whether it came from real installed-extension persistence, an unpacked/temporary reinstall, or a controlled storage-snapshot substitution.

## Authenticated cross-browser Sync

Chrome Sync and Firefox Sync are separate vendor systems; a Chrome profile does not synchronize extension data with Firefox. Test each vendor independently with two installations signed into the same disposable vendor account.

1. Build and install the same extension version in browser A and browser B. Give each browser its own persistent profile.
2. Sign both profiles into the vendor's Sync service and enable extension-data synchronization.
3. In A, save `A only`, enable Autoload, and wait until B's Options page lists it.
4. Disconnect B from the network. In B, save `B offline`; in A, delete `A only` and save `A online`.
5. Reconnect B, wait for Sync to settle, and restart both browsers.
6. Record the sets, Autoload assignment, active generation index, and any legacy keys on both profiles.

Expected product result: both profiles converge without an unreadable generation; a propagated deletion is not resurrected by an older offline value; independently created sets survive; Autoload references only surviving sets. A conflict outcome governed by the vendor's per-key last-writer reconciliation must be recorded as browser behavior.

Controlled substitute for pull requests: seed the two reconciled storage snapshots into disposable profiles and run migration/repository reads. This proves deterministic recovery from the resulting key set. It does **not** prove vendor transport, account authentication, propagation timing, or conflict ordering.

## Chrome incognito and Firefox private browsing

1. Install the extension in a disposable normal profile containing one saved set and an Autoload selection.
2. Chrome: set the manifest's `incognito` key to `spanning` for one build and `split` for another, reinstall each build, then open `chrome://extensions`, open Save Pinned Tabs details, and enable **Allow in Incognito**.
3. Firefox: open `about:addons`, open Save Pinned Tabs permissions, and allow private windows.
4. Open a private/incognito window, invoke the popup, save and load a set, close every private window, then reopen one.
5. Fully quit and relaunch the browser with only a private/incognito startup window.

Expected product result in spanning mode: private windows use the shared extension storage while tab replacement remains scoped to the initiating window. Chrome does not emit `runtime.onStartup` for an incognito profile startup; therefore Autoload on an incognito-only Chrome launch is a browser limitation, not an extension failure. Split mode has an independent extension process, but `storage.sync` and `storage.local` remain shared with the regular process; tab operations and in-memory lifecycle state remain isolated. Automation cannot toggle Chrome's incognito permission reliably, so that permission step remains manual.

## Forced-termination recovery

1. Start Chrome or Firefox with a disposable persistent profile. Save two sets, select one for Autoload, and verify Options can load both.
2. Capture the browser PID from the launcher, not a renderer PID.
3. During an idle state, terminate the browser process tree without a graceful shutdown (`kill -KILL <browser-pid>` on Linux, `taskkill /F /T /PID <pid>` on Windows).
4. Relaunch the same profile. Verify Options lists and loads both sets and that Autoload creates no duplicate pinned tabs.
5. Repeat while replacing a multi-chunk generation: terminate after the local recovery record appears but before old synchronized chunks are removed. Relaunch and verify the previous generation remains readable and the unused recovery record is removed.
6. Repeat after old chunks are removed and after one or more replacement chunks appear, but before the index changes. Relaunch and verify the local recovery copy restores the previous indexed generation and removes replacement orphans.
7. Repeat immediately after the index changes. Relaunch and verify the new generation is readable, old-generation orphans are removed, and local recovery staging is removed.

Expected product result: the index never exposes a partial document to extension readers. Before the index switch, an interrupted replacement restores the previous generation from `storage.local`; after the switch, it retains the verified new generation. Each device caches its last complete synchronized document locally so independently propagated chunk deletion and index updates cannot expose a partial generation; a later complete generation refreshes that cache.

## Chrome startup settings

Run the forced-termination and clean-restart recipes for each row:

| Continue where you left off | Background apps | Expected result |
| --- | --- | --- |
| Off | Off | Autoload restores the configured set once. |
| On | Off | Chrome-restored pinned URLs are retained and not duplicated by Autoload. |
| Off | On | Closing all windows may keep Chrome alive; opening a later window is not a new browser startup. Every-window policy still applies to that new window. |
| On | On | Restored tabs are deduplicated; `runtime.onStartup` timing is recorded separately from window creation. |

Configure session restore at `chrome://settings/onStartup`. Configure background apps at `chrome://settings/system` where the Chrome build exposes it. These settings pages and their policy availability are vendor surfaces; automation may seed managed preferences only when the resulting policy is recorded with the result.

## Browser and extension upgrade

1. Create a disposable profile with browser version N and Save Pinned Tabs 3.1.1.
2. Save multiple legacy sets whose combined representation exceeds 8,192 bytes, plus a normal version 2 document and a late-arriving legacy key. Configure Autoload and browser shortcuts at `chrome://extensions/shortcuts` or Firefox's Manage Extension Shortcuts page.
3. Quit cleanly and archive the profile as the immutable starting fixture.
4. Reopen a copy with browser version N+1 while keeping extension 3.1.1. Record browser-driven storage or shortcut changes.
5. Install the current extension over the same profile without uninstalling it. Restart the browser.
6. Verify Options opens, every pre-upgrade set is visible and loadable, the Autoload selection survives, shortcuts remain assigned, legacy sources are removed only after the encoded generation is readable, and every chunk remains below 6 KiB.
7. Repeat from the archived fixture using forced termination during the first current-version write.

Expected product result: upgrade requires no export/import and preserves set identities, tabs, Autoload configuration, and shortcut assignments. Browser removal of an extension shortcut during upgrade is vendor behavior only if reproduced without an extension manifest command change. Automated unpacked-extension replacement is a controlled substitute for store update delivery; it does not prove Chrome Web Store or AMO rollout behavior and signatures.

## Result record

For every run, record browser name and exact version, OS, extension before/after versions, profile mode, Sync/account state without identifiers, startup settings, termination point, recipe step reached, observed result, and one classification:

- **Product behavior:** extension storage, migration, UI, Autoload, or recovery result.
- **Browser limitation:** documented or reproduced vendor lifecycle/storage behavior.
- **Automation limitation:** a permission, account, store-delivery, or timing condition the harness cannot control faithfully.

A passing controlled substitute must name the vendor behavior it does not prove. A failed credential-dependent run must retain logs only after removing account and profile data.
