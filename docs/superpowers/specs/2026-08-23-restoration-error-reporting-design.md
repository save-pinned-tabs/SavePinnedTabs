# Restoration Error Reporting Design

## Problem

Firefox rejects `file:` URLs passed to `browser.tabs.create()`. The extension currently removes all pinned tabs, starts replacement tab creation without waiting for it, and reports success even when Firefox rejects one or more URLs.

The extension cannot automatically restore a missing Firefox `file:` tab through the WebExtensions tabs API. It must restore the supported tabs and report every rejected URL accurately.

## Behavior

When a saved set is loaded, the extension will:

1. Remove the current pinned tabs.
2. Attempt to create every saved tab.
3. Wait until every creation attempt has succeeded or failed.
4. Keep all successfully restored tabs.
5. Mark the selected set as active.
6. Save one pending failure report when any creation fails.
7. Show that report once in the popup, then remove it.

A failure report will list each rejected URL and its browser-provided error message. A completely successful load will clear any stale report and will not show an error.

The behavior applies to manual loads and autoloads. Manual loads can show the report after the popup reloads. Autoload failures remain pending until the user next opens the popup.

## Architecture

### Restoration

`Sets.load(id, winid)` will return its promise chain. It will await tab removal before creating replacements. Each `tabs.create()` promise will be converted into a result that retains the source URL. The loader will collect rejected results without allowing one rejection to stop the other restoration attempts.

The loader will persist the rejected results in `browser.storage.local`. The report is data only; restoration code will not depend on popup globals or DOM APIs.

### Popup reporting

A new `Sets.reportRestoreErrors()` operation will read the pending report during popup initialization. If a report exists, it will remove the stored report and display one SweetAlert error containing the rejected URLs and messages.

`popup.js` will call both `Sets.get()` and `Sets.reportRestoreErrors()` after `DOMContentLoaded`. The service worker will not attempt to display UI.

### Stored data

The local-storage key will be `restoreErrors`. Its value will be an array of objects:

```js
{
  url: "file:///home/user/Downloads/example%20book.pdf",
  message: "Illegal URL"
}
```

Only the latest load report is retained. A later successful load removes an earlier stale report.

## Error Handling

- A rejected `tabs.create()` call becomes a report item; it does not reject the entire load.
- A rejected removal, storage read, or storage write remains a load failure because the extension cannot establish the resulting tab-set state reliably.
- The active-set marker is updated only after all creation attempts settle and the failure report is stored or cleared.
- Error text is rendered as text, not injected as HTML.

## Tests

Regression tests will execute the real `Sets.load()` path with a browser API test double.

1. A saved set contains one HTTPS URL and one `file:` URL. HTTPS creation succeeds and Firefox-style file creation rejects. The HTTPS tab exists, the file URL and error are persisted, and the load completes without an unhandled rejection.
2. Every creation succeeds. All tabs exist and stale restoration errors are removed.
3. Popup reporting consumes a stored report once and passes text containing each failed URL to SweetAlert.

The extension build must still succeed after the changes.

## Non-goals

- Circumventing Firefox's prohibition on programmatic `file:` navigation.
- Installing a native-messaging host.
- Preserving file tabs that happen to be open already.
- Retrying failed URLs.
