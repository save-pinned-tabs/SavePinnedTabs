# Restoration Error Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore every browser-supported saved tab and show one accurate popup report for URLs Firefox rejects.

**Architecture:** `Sets.load()` will become an awaited orchestration operation that removes old pinned tabs, settles every independent creation attempt, persists rejected URL/error pairs, and only then marks the set active. A popup-only `Sets.reportRestoreErrors()` method will consume the pending data and render it with the existing SweetAlert library, keeping DOM/UI dependencies out of the service worker.

**Tech Stack:** Manifest V3 WebExtensions, JavaScript ES modules, `browser.tabs`/`browser.storage` APIs through the existing `chrome` alias, Node.js built-in test runner, SweetAlert.

## Global Constraints

- Restore supported tabs even when another saved URL is rejected.
- Attempt every saved URL; do not pre-filter `file:` URLs because Chromium may support them.
- Retain only the latest load report in `browser.storage.local` under `restoreErrors`.
- Render browser error data as SweetAlert text, never as HTML.
- Do not add native messaging, retries, or preservation of already-open file tabs.

---

### Task 1: Restoration Result Persistence

**Files:**
- Create: `test/restoration-errors.test.mjs`
- Modify: `functions.js:11-19,48-76`
- Modify: `package.json:6-20`

**Interfaces:**
- Consumes: `browser.storage.sync.get(id)`, `browser.tabs.query(query)`, `browser.tabs.remove(ids)`, `browser.tabs.create(properties)`, and `browser.storage.local.set/remove`.
- Produces: `Sets.load(id: string, winid: number): Promise<void>` and local-storage `restoreErrors: Array<{url: string, message: string}>`.

- [ ] **Step 1: Add the Node test command and browser API harness**

Add `"test": "node --test"` to `package.json` scripts. Create `test/restoration-errors.test.mjs` with a `loadSets()` helper that installs `globalThis.chrome` and `globalThis.window`, imports a fresh data-URL copy of `functions.js`, invokes `await Sets.load('saved', 1)`, and returns created tabs plus local-storage state. The `tabs.create` mock must resolve for HTTPS and throw `new Error('Illegal URL')` for `file:`.

```js
async function loadSets(savedTabs, initialLocal = {}) {
  const createdTabs = [];
  const local = { ...initialLocal };
  // Mock windows, sync/local storage, query/remove/create.
  // Import functions.js through a unique data URL.
  await Sets.load('saved', 1);
  return { createdTabs, local };
}
```

- [ ] **Step 2: Write the rejected-URL regression test**

```js
test('restores supported tabs and records rejected tabs', async () => {
  const fileUrl = 'file:///home/user/Downloads/example%20book.pdf';
  const result = await loadSets(['https://example.com/', fileUrl]);

  assert.deepEqual(result.createdTabs.map(({ url }) => url), ['https://example.com/']);
  assert.deepEqual(result.local.restoreErrors, [
    { url: fileUrl, message: 'Illegal URL' },
  ]);
});
```

Assert that the load promise resolves; any unhandled creation rejection must fail the Node test automatically.

- [ ] **Step 3: Write the successful-load stale-report test**

```js
test('clears stale restoration errors after a successful load', async () => {
  const result = await loadSets(
    ['https://example.com/'],
    { restoreErrors: [{ url: 'file:///old.pdf', message: 'Illegal URL' }] },
  );

  assert.deepEqual(result.createdTabs.map(({ url }) => url), ['https://example.com/']);
  assert.equal('restoreErrors' in result.local, false);
});
```

- [ ] **Step 4: Run the tests and verify the exact failure**

Run: `npm test`

Expected: both tests fail because `Sets.load()` returns before creation settles; the rejected URL is not persisted and the stale report is not cleared.

- [ ] **Step 5: Make active-state updates awaitable and worker-safe**

Change `set_active()` to return its storage promise. Preserve popup navigation only when a window object exists:

```js
var set_active = function (id, winid) {
    return browser.storage.local.get(['activeTabs']).then(function(result) {
        var atabs = result.activeTabs || {};
        atabs[winid] = id;
        return browser.storage.local.set({'activeTabs': atabs}).then(function() {
            console.log('Active tabset for window '+winid+' is set to '+id);
            if (typeof window !== 'undefined') {
                window.location.href = 'popup.html';
            }
        });
    });
}
```

- [ ] **Step 6: Implement settled tab creation and report persistence**

Replace `Sets.load()` with an `async` method. Await the sync read, pinned-tab query, and removal. Map every URL to an async creation attempt that returns `null` on success or `{ url, message }` on rejection. Use `Promise.all()` over these caught attempts so every URL is attempted without an unhandled rejection.

```js
load: async function (id, winid) {
    var set = await browser.storage.sync.get(id);
    var tabs = set[id].tabs;
    var currentTabs = await browser.tabs.query({ pinned: true, windowId: winid });
    var tabIds = currentTabs.map(function (tab) { return tab.id; });

    if (tabIds.length > 0) {
        await browser.tabs.remove(tabIds);
    }

    var results = await Promise.all(tabs.map(async function (url) {
        try {
            await browser.tabs.create({
                windowId: winid,
                url: url,
                active: false,
                pinned: true
            });
            return null;
        } catch (error) {
            return {
                url: url,
                message: error && error.message ? error.message : String(error)
            };
        }
    }));
    var restoreErrors = results.filter(function (result) { return result !== null; });

    if (restoreErrors.length > 0) {
        await browser.storage.local.set({ restoreErrors: restoreErrors });
        console.log('Loaded tabs with '+restoreErrors.length+' error(s)');
    } else {
        await browser.storage.local.remove('restoreErrors');
        console.log('Loaded tabs');
    }

    await set_active(id, winid);
},
```

- [ ] **Step 7: Run the focused tests**

Run: `npm test`

Expected: 2 tests pass, 0 fail, and no unhandled rejection appears.

- [ ] **Step 8: Commit the restoration behavior**

```bash
git add package.json functions.js test/restoration-errors.test.mjs
git commit -m "fix: report tabs rejected during restoration"
```

---

### Task 2: One-Time Popup Error Report

**Files:**
- Modify: `functions.js` in the public `Sets` return object
- Modify: `popup.js:14`
- Test: `test/restoration-errors.test.mjs`

**Interfaces:**
- Consumes: local-storage `restoreErrors: Array<{url: string, message: string}>` from Task 1 and global `swal(options)` loaded by `popup.html`.
- Produces: `Sets.reportRestoreErrors(): Promise<void>`, which consumes at most one pending report.

- [ ] **Step 1: Add a SweetAlert capture to the test harness**

Set `globalThis.swal` to a function that records its options. Return the captured calls from the harness so tests can inspect the exact `title`, `text`, and `icon` without a DOM.

```js
const alerts = [];
globalThis.swal = (options) => {
  alerts.push(options);
  return Promise.resolve();
};
```

- [ ] **Step 2: Write the one-time reporting regression test**

Import `Sets` with local storage containing two errors, call `await Sets.reportRestoreErrors()` twice, and assert one alert only, removal of `restoreErrors`, and text containing both URLs and both messages.

```js
assert.equal(alerts.length, 1);
assert.equal(alerts[0].title, 'Some tabs could not be restored');
assert.equal(alerts[0].icon, 'error');
assert.match(alerts[0].text, /file:\/\/\/first\.pdf\nIllegal URL/);
assert.match(alerts[0].text, /file:\/\/\/second\.pdf\nAccess denied/);
assert.equal('restoreErrors' in local, false);
```

- [ ] **Step 3: Run the reporting test and verify it fails**

Run: `node --test --test-name-pattern="reports restoration errors once" test/restoration-errors.test.mjs`

Expected: FAIL because `Sets.reportRestoreErrors` does not exist.

- [ ] **Step 4: Implement report consumption**

Add this public operation to `Sets`:

```js
reportRestoreErrors: async function () {
    var result = await browser.storage.local.get(['restoreErrors']);
    var restoreErrors = result.restoreErrors || [];
    if (restoreErrors.length === 0) return;

    await browser.storage.local.remove('restoreErrors');
    var text = restoreErrors.map(function (error) {
        return error.url + '\n' + error.message;
    }).join('\n\n');

    await swal({
        title: 'Some tabs could not be restored',
        text: text,
        icon: 'error'
    });
},
```

The SweetAlert `text` property preserves text rendering and does not interpret browser-provided values as HTML.

- [ ] **Step 5: Wire popup initialization**

Replace the single callback registration in `popup.js` with an async callback that waits for both startup operations:

```js
document.addEventListener('DOMContentLoaded', async function () {
    Sets.get();
    await Sets.reportRestoreErrors();
});
```

`Sets.get()` remains non-blocking as before; the error report is independent of saved-set list rendering.

- [ ] **Step 6: Run all regression tests**

Run: `npm test`

Expected: 3 tests pass, 0 fail.

- [ ] **Step 7: Commit popup reporting**

```bash
git add functions.js popup.js test/restoration-errors.test.mjs
git commit -m "feat: show failed tab restoration report"
```

---

### Task 3: Extension Verification and Cleanup

**Files:**
- Verify: `functions.js`
- Verify: `popup.js`
- Verify: `test/restoration-errors.test.mjs`
- Verify: `docs/superpowers/specs/2026-08-23-restoration-error-reporting-design.md`

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: a tested, buildable Manifest V3 extension with no temporary instrumentation.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: 3 tests pass, 0 fail, no unhandled rejections.

- [ ] **Step 2: Build the extension artifact**

Run: `npm run build`

Expected: `web-ext build` exits 0 and reports `dist/save_pinned_tabs-2.0.1.zip` ready.

- [ ] **Step 3: Check for temporary debugging instrumentation**

Search tracked source for `\[DEBUG-`.

Expected: no matches.

- [ ] **Step 4: Confirm the documentation scope**

The approved design is the required technical documentation. Do not change README feature claims because Firefox still cannot automatically restore missing `file:` tabs.

- [ ] **Step 5: Inspect the final working tree**

Run: `git status --short`

Expected: no unexpected files; only intentional implementation changes remain if the task commits were not made.
