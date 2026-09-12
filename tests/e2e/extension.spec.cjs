const http = require("node:http");
const { execFile } = require("node:child_process");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { chromium } = require("@playwright/test");
const {
  expect,
  extensionPath,
  launchExtension,
  openExtensionPage,
  test,
} = require("./extension.fixture.cjs");


const execFileAsync = promisify(execFile);

async function installUnpackedExtension(page) {
  await page.goto("chrome://extensions");
  const toolbar = page.locator("extensions-toolbar");
  await toolbar.locator("#devMode").click();
  await toolbar.locator("#loadUnpacked").click();
  await execFileAsync("xdotool", ["search", "--name", "Extensions - Google Chrome", "windowactivate", "--sync"], {
    env: process.env,
  });
  await execFileAsync("xdotool", ["key", "--clearmodifiers", "ctrl+l"], { env: process.env });
  await execFileAsync("xdotool", ["type", "--delay", "1", extensionPath], { env: process.env });
  await execFileAsync("xdotool", ["key", "Return"], { env: process.env });
  const item = page.locator("extensions-item").filter({ hasText: "Save Pinned Tabs" });
  await expect(item).toBeVisible({ timeout: 30_000 });
  return item.getAttribute("id");
}
async function createTabs(page, urls, pinned = true) {
  await page.evaluate(async ({ tabUrls, isPinned }) => {
    for (const url of tabUrls) {
      await chrome.tabs.create({ url, pinned: isPinned, active: false });
    }
  }, { tabUrls: urls, isPinned: pinned });
}

async function removeOrUnpinTabs(page, urls) {
  await page.evaluate(async (tabUrls) => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const matchingTabs = tabs.filter((tab) => tab.url && tabUrls.includes(tab.url));
    await chrome.tabs.update(matchingTabs[0].id, { pinned: false });
    await chrome.tabs.remove(matchingTabs.slice(1).map((tab) => tab.id));
  }, urls);
}


async function removePinnedTabs(page) {
  await page.evaluate(async () => {
    const tabs = await chrome.tabs.query({ pinned: true, currentWindow: true });
    await chrome.tabs.remove(tabs.map((tab) => tab.id));
  });
}

async function pinnedUrls(page, windowId) {
  return page.evaluate(async (targetWindowId) => {
    const tabs = await chrome.tabs.query({ pinned: true, windowId: targetWindowId });
    return tabs.map((tab) => tab.url);
  }, windowId);
}

async function currentWindowId(page) {
  return page.evaluate(async () => (await chrome.windows.getCurrent()).id);
}
async function restartExtension(extension, userDataDir) {
  await extension.context.close();
  await new Promise((resolve) => setTimeout(resolve, 250));
  return launchExtension(userDataDir);
}


async function saveSet(page, name) {
  await page.getByPlaceholder("Enter a name for set...").fill(name);
  const pageLoadTime = await page.evaluate(() => performance.timeOrigin);
  await page.locator("#save-button").click();
  await expect(page.getByRole("status")).toHaveText("Tab set saved.");
  await expect(page.locator(".load-row", { hasText: name })).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(pageLoadTime);
}

async function selectAutoloadSet(page, name) {
  await page
    .locator(".load-row", { hasText: name })
    .locator("input[name=autoload]")
    .check();
  await expect(page.getByRole("status")).toHaveText("Autoload selection updated.");
}

async function clearAutoloadSet(page, name) {
  await page
    .locator(".load-row", { hasText: name })
    .locator("input[name=autoload]")
    .uncheck();
  await expect(page.getByRole("status")).toHaveText("Autoload selection updated.");
}

async function runStartupHandler(page) {
  await page.evaluate(async () => {
    await chrome.storage.session.remove("savePinnedTabs:lifecycle");
    const { handleStartup } = await import(
      chrome.runtime.getURL("background/service-worker.js")
    );
    await handleStartup();
  });
}

async function deleteSet(page, name) {
  const row = page.locator(".load-row", { hasText: name });
  await row.getByRole("button", { name: "Del" }).click();
  await expect(page.locator("#delete-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Tab set deleted.");
  await expect(row).toHaveCount(0);
}

async function expectOpenTabs(context, expectedUrls, absentUrls = []) {
  await expect
    .poll(() => context.pages().map((page) => page.url()))
    .toEqual(expect.arrayContaining(expectedUrls));

  for (const url of absentUrls) {
    await expect.poll(() => context.pages().some((page) => page.url() === url)).toBe(false);
  }
}
async function importDocument(page, document, fileName = "import.json") {
  await page.locator("#import-input").setInputFiles({
    name: fileName,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await page.getByRole("button", { name: "Import" }).click();
}

test("a user can save a pinned tab set without reloading", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  await createTabs(popup, [`chrome-extension://${extensionId}/options/options.html?save`]);
  await saveSet(popup, "Work");
  const row = popup.locator(".load-row", { hasText: "Work" });
  await expect(row.getByRole("button", { name: "Append" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Unload" })).toHaveCount(0);
  await popup.bringToFront();
  await expect(popup.getByRole("status")).toBeEmpty({ timeout: 4_000 });
});

test("a user can update a pinned tab set without reloading", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  await createTabs(popup, [`chrome-extension://${extensionId}/options/options.html?first`]);
  await saveSet(popup, "Work");
  const secondUrl = `chrome-extension://${extensionId}/options/options.html?second`;
  await createTabs(popup, [secondUrl]);
  const pageLoadTime = await popup.evaluate(() => performance.timeOrigin);
  await popup.locator(".load-row", { hasText: "Work" })
    .getByRole("button", { name: "Save", exact: true }).click();
  await expect(popup.getByRole("status")).toHaveText("Tab set saved.");
  expect(await pinnedUrls(popup, await currentWindowId(popup))).toContain(secondUrl);
  expect(await popup.evaluate(() => performance.timeOrigin)).toBe(pageLoadTime);
});
test("updating a set removes tabs that were unpinned or closed", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const removedUrls = [
    `chrome-extension://${extensionId}/options/options.html?unpin-on-update`,
    `chrome-extension://${extensionId}/options/options.html?close-on-update`,
  ];
  const retainedUrl = `chrome-extension://${extensionId}/options/options.html?retain-on-update`;
  await createTabs(popup, [...removedUrls, retainedUrl]);
  await saveSet(popup, "Updated");
  await removeOrUnpinTabs(popup, removedUrls);

  await popup.locator(".load-row", { hasText: "Updated" })
    .getByRole("button", { name: "Save", exact: true }).click();
  await expect(popup.getByRole("status")).toHaveText("Tab set saved.");
  await removePinnedTabs(popup);
  await popup.locator(".load-row", { hasText: "Updated" })
    .getByRole("button", { name: "Load", exact: true }).click();

  await expect(popup.getByRole("status")).toHaveText("Tab set loaded.");
  expect(await pinnedUrls(popup, await currentWindowId(popup))).toEqual([retainedUrl]);
});

test("saving a set ignores unpinned tabs", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const pinnedUrl = `chrome-extension://${extensionId}/options/options.html?pinned`;
  const unpinnedUrl = `chrome-extension://${extensionId}/options/options.html?unpinned`;
  await createTabs(popup, [pinnedUrl]);
  await createTabs(popup, [unpinnedUrl], false);
  await saveSet(popup, "Pinned only");
  await removePinnedTabs(popup);

  await popup.locator(".load-row", { hasText: "Pinned only" })
    .getByRole("button", { name: "Load", exact: true }).click();

  await expect(popup.getByRole("status")).toHaveText("Tab set loaded.");
  expect(await pinnedUrls(popup, await currentWindowId(popup))).toEqual([pinnedUrl]);
  await expectOpenTabs(context, [unpinnedUrl]);
});

test("saving with no pinned tabs does not create an empty set", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  await createTabs(popup, [
    `chrome-extension://${extensionId}/options/options.html?only-unpinned`,
  ], false);
  await popup.getByPlaceholder("Enter a name for set...").fill("Empty");

  await popup.getByRole("button", { name: "Save", exact: true }).click();

  await expect(popup.getByRole("status"))
    .toHaveText("Failed to save tab set: No pinned tabs found.");
  await expect(popup.locator(".load-row", { hasText: "Empty" })).toHaveCount(0);
});


test("a user can load a pinned tab set without reloading", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const savedUrl = `chrome-extension://${extensionId}/options/options.html?saved`;
  const unwantedUrl = `chrome-extension://${extensionId}/options/options.html?unwanted`;
  await createTabs(popup, [savedUrl]);
  await saveSet(popup, "Work");
  await createTabs(popup, [unwantedUrl]);
  const pageLoadTime = await popup.evaluate(() => performance.timeOrigin);
  await popup.locator(".load-row", { hasText: "Work" })
    .getByRole("button", { name: "Load", exact: true }).click();
  await expect(popup.getByRole("status")).toHaveText("Tab set loaded.");
  await expectOpenTabs(context, [savedUrl], [unwantedUrl]);
  expect(await popup.evaluate(() => performance.timeOrigin)).toBe(pageLoadTime);
});

test("loading a set changes only the initiating window and preserves pinned order", async ({
  extension,
}) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const savedUrls = [
    `chrome-extension://${extensionId}/options/options.html?ordered-first`,
    `chrome-extension://${extensionId}/options/options.html?ordered-second`,
  ];
  await createTabs(popup, savedUrls);
  await saveSet(popup, "Ordered");
  await removePinnedTabs(popup);
  const otherUrl = `chrome-extension://${extensionId}/options/options.html?other-window`;
  const otherWindow = await popup.evaluate(async (url) => {
    const window = await chrome.windows.create({ url });
    const [tab] = await chrome.tabs.query({ windowId: window.id });
    await chrome.tabs.update(tab.id, { pinned: true });
    return window;
  }, otherUrl);
  await popup.bringToFront();

  await popup.locator(".load-row", { hasText: "Ordered" })
    .getByRole("button", { name: "Load", exact: true }).click();

  await expect(popup.getByRole("status")).toHaveText("Tab set loaded.");
  await expect.poll(
    () => pinnedUrls(popup, otherWindow.id),
  ).toEqual([otherUrl]);
  expect(await pinnedUrls(popup, await currentWindowId(popup))).toEqual(savedUrls);
});

test("a tab creation failure preserves original pinned tabs and reports the failed URL", async ({
  extension,
}) => {
  const { context, extensionId } = extension;
  const originalUrl = `chrome-extension://${extensionId}/options/options.html?original`;
  const failedUrl = "http://[invalid";
  const options = await openExtensionPage(context, extensionId, "options/options.html");
  const failingSetId = "00000000-0000-4000-8000-000000000001";
  await importDocument(options, {
    version: 2,
    sets: [{ id: failingSetId, name: "Failing", tabs: [failedUrl] }],
    autoload: { scope: "first-window", setIds: [] },
  }, "failing.json");
  await expect(
    options.getByText("Successfully imported 1 tab set.", { exact: true }),
  ).toBeVisible();
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  await createTabs(popup, [originalUrl]);

  await popup.locator(".load-row", { hasText: "Failing" })
    .getByRole("button", { name: "Load", exact: true }).click();

  await expect(popup.getByRole("status")).toContainText(failedUrl);
  expect(await pinnedUrls(popup, await currentWindowId(popup))).toEqual([originalUrl]);
});

test("a user can cancel deletion with Escape", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  await createTabs(popup, [`chrome-extension://${extensionId}/options/options.html?cancel-delete`]);
  await saveSet(popup, "Work");
  const row = popup.locator(".load-row", { hasText: "Work" });
  await row.getByRole("button", { name: "Del" }).click();
  await expect(popup.locator("#delete-dialog")).toBeVisible();
  await popup.keyboard.press("Escape");
  await expect(popup.locator("#delete-dialog")).toBeHidden();
  await expect(row).toBeVisible();
});

test("a user can delete a pinned tab set without reloading", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  await createTabs(popup, [`chrome-extension://${extensionId}/options/options.html?delete`]);
  await saveSet(popup, "Work");
  const pageLoadTime = await popup.evaluate(() => performance.timeOrigin);
  await deleteSet(popup, "Work");
  expect(await popup.evaluate(() => performance.timeOrigin)).toBe(pageLoadTime);
});
test("deleting a shortcut-assigned set clears its assignment", async ({ extension }) => {
  const { assignment, options, popup } = await createShortcutFixture(extension);
  await popup.bringToFront();

  await deleteSet(popup, "Shortcut target");
  await options.bringToFront();
  await options.reload();

  await expect(assignment).toHaveValue("");
});



async function createShortcutFixture(extension, command = "load-set-1") {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const assignedUrl = `chrome-extension://${extensionId}/options/options.html?shortcut`;
  await createTabs(popup, [assignedUrl]);
  await saveSet(popup, "Shortcut target");
  const options = await openExtensionPage(context, extensionId, "options/options.html");
  const assignment = options.locator(`[data-shortcut-command="${command}"]`);
  await assignment.selectOption({ label: "Shortcut target" });
  await expect(options.getByRole("status")).toHaveText("Shortcut assignment saved.");
  return { assignedUrl, assignment, options, popup };
}

test("a shortcut assignment persists", async ({ extension }) => {
  const { assignment, options } = await createShortcutFixture(extension);
  const assignedSetId = await assignment.inputValue();
  await options.reload();
  await expect(assignment).toHaveValue(assignedSetId);
});

test("an assigned command dispatches through the registered listener", async ({ extension }) => {
  const { context, extensionId } = extension;
  const { assignedUrl, popup } = await createShortcutFixture(extension);
  const unwantedUrl = `chrome-extension://${extensionId}/options/options.html?shortcut-unwanted`;
  await createTabs(popup, [unwantedUrl]);
  expect(await context.serviceWorkers()[0]
    .evaluate(async () => savePinnedTabsCommandListener("load-set-1")))
    .toMatchObject({ status: "success", value: { executed: true } });
  await expectOpenTabs(context, [assignedUrl], [unwantedUrl]);
});

test("an unassigned command is a no-op", async ({ extension }) => {
  const { context } = extension;
  const popup = await openExtensionPage(context, extension.extensionId, "popup/popup.html");
  const before = await pinnedUrls(popup, await currentWindowId(popup));
  expect(await context.serviceWorkers()[0]
    .evaluate(async () => savePinnedTabsCommandListener("load-set-4")))
    .toEqual({ status: "success", value: { executed: false } });
  expect(await pinnedUrls(popup, await currentWindowId(popup))).toEqual(before);
});


test("a pending failure blocks duplicate commands and recovers in place", async ({
  extension,
}) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const existingUrl = `chrome-extension://${extensionId}/options/options.html?existing`;
  await createTabs(popup, [existingUrl]);
  await saveSet(popup, "Existing");

  await popup.evaluate(() => {
    const controller = globalThis.savePinnedTabsController;
    controller.testCommandCount = 0;
    Object.defineProperty(controller, "saveSet", {
      configurable: true,
      value() {
        controller.testCommandCount += 1;
        return new Promise((resolve) => {
          controller.rejectTestCommand = () => resolve({
            status: "error",
            error: new Error("Storage is unavailable; try again."),
          });
        });
      },
    });
  });
  await popup.getByPlaceholder("Enter a name for set...").fill("Fails");
  const save = popup.getByRole("button", { name: "Save", exact: true }).first();
  await save.dblclick();
  await expect(popup.locator("body")).toHaveAttribute("aria-busy", "true");
  await expect(save).toBeDisabled();
  await expect(popup.getByRole("status")).toHaveText("Saving tab set…");
  await popup.evaluate(() => globalThis.savePinnedTabsController.rejectTestCommand());
  await expect(popup.getByRole("status")).toHaveText("Storage is unavailable; try again.");
  expect(await popup.evaluate(
    () => globalThis.savePinnedTabsController.testCommandCount,
  )).toBe(1);
  await expect(popup.locator(".load-row", { hasText: "Existing" })).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(popup.locator("body")).toHaveAttribute("aria-busy", "false");
});


test("a legacy profile migrates sets and references exactly once across restarts", async () => {
  test.slow();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-migration-"));
  let firstLaunch;
  let secondLaunch;
  let thirdLaunch;
  const legacyKey = Buffer.from("Legacy Work").toString("base64");
  const lateLegacyKey = Buffer.from("Late Legacy").toString("base64");

  try {
    firstLaunch = await launchExtension(userDataDir);
    expect(await firstLaunch.context.serviceWorkers()[0].evaluate(
      async ({ legacyKey }) => {
        while (!("savePinnedTabs:sync" in await chrome.storage.sync.get(null))) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await chrome.storage.sync.set({
          [legacyKey]: {
            autoload: 1,
            set_name: "Legacy Work",
            tabs: ["https://example.com/legacy"],
          },
        });
        await chrome.storage.local.set({
          activeTabs: { 1: legacyKey },
          shortcutSets: { "load-set-1": legacyKey },
        });
        await chrome.storage.sync.remove("savePinnedTabs:sync");
        await chrome.storage.local.remove("savePinnedTabs:local");
        return "savePinnedTabs:sync" in await chrome.storage.sync.get(null);
      },
      { legacyKey },
    )).toBe(false);
    await firstLaunch.context.close();
    firstLaunch = undefined;

    secondLaunch = await launchExtension(userDataDir);
    const popup = await openExtensionPage(
      secondLaunch.context,
      secondLaunch.extensionId,
      "popup/popup.html",
    );
    await expect(popup.locator(".load-row", { hasText: "Legacy Work" })).toBeVisible();
    const migrated = await popup.evaluate(async ({ legacyKey }) => {
      const sync = await chrome.storage.sync.get(null);
      const local = await chrome.storage.local.get(null);
      const setId = Object.keys(sync["savePinnedTabs:sync"].sets)[0];
      return {
        legacyRemoved: !(legacyKey in sync),
        set: sync["savePinnedTabs:sync"].sets[setId],
        autoloadSetIds: sync["savePinnedTabs:sync"].autoload.setIds,
        shortcutSetId: local["savePinnedTabs:local"].shortcutAssignments["load-set-1"],
      };
    }, { legacyKey });
    expect(migrated.legacyRemoved).toBe(true);
    expect(migrated.set).toMatchObject({
      name: "Legacy Work",
      tabs: ["https://example.com/legacy"],
    });
    expect(migrated.autoloadSetIds).toEqual([migrated.set.id]);
    expect(migrated.shortcutSetId).toBe(migrated.set.id);

    await popup.evaluate(async ({ lateLegacyKey }) => {
      await chrome.storage.sync.set({
        [lateLegacyKey]: {
          autoload: 0,
          set_name: "Late Legacy",
          tabs: ["https://example.com/late"],
        },
      });
    }, { lateLegacyKey });
    await secondLaunch.context.close();
    secondLaunch = undefined;

    thirdLaunch = await launchExtension(userDataDir);
    const restartedPopup = await openExtensionPage(
      thirdLaunch.context,
      thirdLaunch.extensionId,
      "popup/popup.html",
    );
    await expect(restartedPopup.locator(".load-row", { hasText: "Legacy Work" })).toBeVisible();
    await expect(
      restartedPopup.locator(".load-row", { hasText: "Late Legacy" }),
    ).toHaveCount(0);
  } finally {
    await firstLaunch?.context.close();
    await secondLaunch?.context.close();
    await thirdLaunch?.context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
test("saved-set titles can exceed 30 characters and wrap", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const longName =
    "A very long saved tab set title that remains readable instead of being truncated";
  await createTabs(popup, [
    `chrome-extension://${extensionId}/options/options.html?long-title`,
  ]);

  await saveSet(popup, longName);

  const title = popup.locator(".load-row", { hasText: longName }).locator("span");
  await expect(title).toHaveText(longName);
  const wraps = await title.evaluate((element) => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    return element.scrollHeight > lineHeight * 1.5;
  });
  expect(wraps).toBe(true);
});

test("export and import preserve multiple sets, tab order, identities, and autoload", async ({
  extension,
}) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const firstUrls = [
    `chrome-extension://${extensionId}/options/options.html?export-first-a`,
    `chrome-extension://${extensionId}/options/options.html?export-first-b`,
  ];
  const secondUrls = [
    `chrome-extension://${extensionId}/options/options.html?export-second-a`,
    `chrome-extension://${extensionId}/options/options.html?export-second-b`,
  ];
  await createTabs(popup, firstUrls);
  await saveSet(popup, "First backup");
  await removePinnedTabs(popup);
  await createTabs(popup, secondUrls);
  await saveSet(popup, "Second backup");
  await selectAutoloadSet(popup, "Second backup");

  const options = await openExtensionPage(context, extensionId, "options/options.html");
  const downloadPromise = options.waitForEvent("download");
  await options.getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  const exportPath = await download.path();
  const exportedDocument = JSON.parse(await readFile(exportPath, "utf8"));
  expect(download.suggestedFilename()).toMatch(/^SavePinnedTabs_export_.*\.json$/);
  expect(exportedDocument.version).toBe(2);
  expect(exportedDocument.sets).toHaveLength(2);
  const firstExport = exportedDocument.sets.find((set) => set.name === "First backup");
  const secondExport = exportedDocument.sets.find((set) => set.name === "Second backup");
  expect(firstExport.tabs).toEqual(firstUrls);
  expect(secondExport.tabs).toEqual(secondUrls);
  expect(exportedDocument.sets.map((set) => set.id)).toEqual([
    expect.stringMatching(/^[0-9a-f-]{36}$/),
    expect.stringMatching(/^[0-9a-f-]{36}$/),
  ]);
  expect(new Set(exportedDocument.sets.map((set) => set.id)).size).toBe(2);
  expect(exportedDocument.autoload).toEqual({
    scope: "first-window",
    setIds: [secondExport.id],
  });

  await deleteSet(popup, "First backup");
  await deleteSet(popup, "Second backup");
  await options.locator("#import-input").setInputFiles(exportPath);
  await options.getByRole("button", { name: "Import" }).click();
  await expect(
    options.getByText("Successfully imported 2 tab sets.", { exact: true }),
  ).toBeVisible();

  await popup.reload();
  const firstRow = popup.locator(".load-row", { hasText: "First backup" });
  const secondRow = popup.locator(".load-row", { hasText: "Second backup" });
  await expect(secondRow.locator("input[name=autoload]")).toBeChecked();
  await firstRow.getByRole("button", { name: "Load", exact: true }).click();
  await expect.poll(
    async () => pinnedUrls(popup, await currentWindowId(popup)),
  ).toEqual(firstUrls);
  await secondRow.getByRole("button", { name: "Load", exact: true }).click();
  await expect.poll(
    async () => pinnedUrls(popup, await currentWindowId(popup)),
  ).toEqual(secondUrls);
});

test("identity collisions and repeated imports create independent usable sets", async ({
  extension,
}) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const existingUrl = `chrome-extension://${extensionId}/options/options.html?collision-existing`;
  const importedUrl = `chrome-extension://${extensionId}/options/options.html?collision-imported`;
  await createTabs(popup, [existingUrl]);
  await saveSet(popup, "Duplicate");
  const existingId = await popup.evaluate(async () => {
    const storage = await chrome.storage.sync.get("savePinnedTabs:sync");
    return Object.keys(storage["savePinnedTabs:sync"].sets)[0];
  });
  const document = {
    version: 2,
    sets: [{ id: existingId, name: "Duplicate", tabs: [importedUrl] }],
    autoload: { scope: "first-window", setIds: [] },
  };
  const options = await openExtensionPage(context, extensionId, "options/options.html");
  await importDocument(options, document, "collision.json");
  await expect(options.getByText("Successfully imported 1 tab set.", { exact: true }))
    .toBeVisible();
  await importDocument(options, document, "collision-again.json");
  await expect(options.getByText("Successfully imported 1 tab set.", { exact: true }))
    .toBeVisible();

  await popup.reload();
  const duplicateRows = popup.locator('.load-row[data-name="Duplicate"]');
  await expect(duplicateRows).toHaveCount(3);

  async function loadDuplicateUrls(count) {
    const urls = [];
    for (let index = 0; index < count; index += 1) {
      const row = duplicateRows.nth(index);
      await row.getByRole("button", { name: "Load", exact: true }).click();
      await expect(row).toHaveClass(/active/);
      urls.push((await pinnedUrls(popup, await currentWindowId(popup)))[0]);
    }
    return urls;
  }

  const loadedUrls = await loadDuplicateUrls(3);
  expect(loadedUrls.toSorted()).toEqual(
    [existingUrl, importedUrl, importedUrl].toSorted(),
  );

  const importedIndex = loadedUrls.indexOf(importedUrl);
  await duplicateRows.nth(importedIndex).getByRole("button", { name: "Del" }).click();
  await popup.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(duplicateRows).toHaveCount(2);

  const remainingUrls = await loadDuplicateUrls(2);
  expect(remainingUrls.toSorted()).toEqual([existingUrl, importedUrl].toSorted());
});

test("an imported tab-set name is rendered as text", async ({ extension }) => {
  const { context, extensionId } = extension;
  const options = await openExtensionPage(context, extensionId, "options/options.html");
  const setName = '<img id="injected-markup" src="invalid">';
  const backup = {
    markup: {
      autoload: 0,
      set_name: setName,
      tabs: ["https://example.com"],
    },
  };

  await options.locator("#import-input").setInputFiles({
    name: "markup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await options.getByRole("button", { name: "Import" }).click();
  await expect(
    options.getByText("Successfully imported 1 tab set.", { exact: true }),
  ).toBeVisible();

  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const row = popup.locator(".load-row", { hasText: setName });
  await expect(row.locator("span")).toHaveText(setName);
  await expect(popup.locator("#injected-markup")).toHaveCount(0);
});

test("a schema-invalid import is rejected", async ({ extension }) => {
  const { context, extensionId } = extension;
  const options = await openExtensionPage(context, extensionId, "options/options.html");
  const invalidBackup = {
    invalid: {
      autoload: 2,
      set_name: "Invalid",
      tabs: ["https://example.com"],
    },
  };

  await options.locator("#import-input").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(invalidBackup)),
  });
  await options.getByRole("button", { name: "Import" }).click();

  await expect(
    options.getByText(/Import validation failed/),
  ).toBeVisible();

  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  await expect(popup.locator(".load-row", { hasText: "Invalid" })).toHaveCount(0);
});

test("an imported every-window set autoloads in existing and new windows", async ({
  extension,
}) => {
  const { context, extensionId } = extension;
  const autoloadUrl = `chrome-extension://${extensionId}/options/options.html?every-window`;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const secondWindow = await popup.evaluate(
    (url) => chrome.windows.create({ url }),
    `chrome-extension://${extensionId}/options/options.html?existing-window`,
  );
  const options = await openExtensionPage(context, extensionId, "options/options.html");
  const everyWindowSetId = "00000000-0000-4000-8000-000000000002";
  await importDocument(options, {
    version: 2,
    sets: [{ id: everyWindowSetId, name: "Every window", tabs: [autoloadUrl] }],
    autoload: { scope: "every-window", setIds: [everyWindowSetId] },
  }, "every-window.json");
  await expect(
    options.getByText("Successfully imported 1 tab set.", { exact: true }),
  ).toBeVisible();
  await runStartupHandler(popup);
  const firstWindowId = await currentWindowId(popup);

  await expect.poll(() => pinnedUrls(popup, firstWindowId)).toEqual([autoloadUrl]);
  await expect.poll(() => pinnedUrls(popup, secondWindow.id)).toEqual([autoloadUrl]);

  const thirdWindow = await popup.evaluate(
    (url) => chrome.windows.create({ url }),
    `chrome-extension://${extensionId}/options/options.html?new-window`,
  );
  await expect.poll(() => pinnedUrls(popup, thirdWindow.id)).toEqual([autoloadUrl]);
});

test("installed Chrome delivers runtime.onStartup without command-line extension loading", async () => {
  test.skip(
    process.env.CHROME_INSTALLED_PROFILE_E2E !== "1",
    "Chrome cannot load an unpacked extension through its native directory picker in headless mode; run under Xvfb with a window manager and CHROME_INSTALLED_PROFILE_E2E=1.",
  );
  test.slow();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-installed-"));
  const executablePath = process.env.GOOGLE_CHROME_BINARY || "google-chrome-stable";
  let firstContext;
  let secondContext;

  try {
    firstContext = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: false,
      args: ["--no-first-run"],
    });
    const manager = firstContext.pages()[0] || await firstContext.newPage();
    const extensionId = await installUnpackedExtension(manager);
    const options = await openExtensionPage(
      firstContext,
      extensionId,
      "options/options.html",
    );
    const restoredUrls = [
      `chrome-extension://${extensionId}/options/options.html?startup-first`,
      `chrome-extension://${extensionId}/options/options.html?startup-second`,
    ];
    const everyWindowSetId = "00000000-0000-4000-8000-000000000002";
    await importDocument(options, {
      version: 2,
      sets: [{
        id: everyWindowSetId,
        name: "Every window",
        tabs: restoredUrls,
      }],
      autoload: { scope: "every-window", setIds: [everyWindowSetId] },
    }, "every-window.json");
    await expect(
      options.getByText("Successfully imported 1 tab set.", { exact: true }),
    ).toBeVisible();
    await options.evaluate(
      (url) => chrome.windows.create({ url }),
      `chrome-extension://${extensionId}/options/options.html?existing-window`,
    );
    const browserClosed = firstContext.waitForEvent("close");
    const session = await firstContext.newCDPSession(manager);
    await session.send("Browser.close");
    await browserClosed;
    firstContext = undefined;

    secondContext = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: false,
      args: ["--no-first-run", "--restore-last-session"],
    });
    const reopenedPopup = await openExtensionPage(
      secondContext,
      extensionId,
      "popup/popup.html",
    );
    const existingWindowIds = await reopenedPopup.evaluate(async () => (
      await chrome.windows.getAll({ windowTypes: ["normal"] })
    ).map((window) => window.id));
    expect(existingWindowIds.length).toBeGreaterThanOrEqual(2);
    for (const windowId of existingWindowIds) {
      await expect.poll(() => pinnedUrls(reopenedPopup, windowId), {
        timeout: 30_000,
      }).toEqual(restoredUrls);
    }
    const newWindow = await reopenedPopup.evaluate(
      (url) => chrome.windows.create({ url }),
      `chrome-extension://${extensionId}/options/options.html?new-window`,
    );
    await expect.poll(() => pinnedUrls(reopenedPopup, newWindow.id), {
      timeout: 30_000,
    }).toEqual(restoredUrls);

    const lifecycle = await reopenedPopup.evaluate(async () => (
      await chrome.storage.session.get("savePinnedTabs:lifecycle")
    )["savePinnedTabs:lifecycle"]);
    expect(lifecycle.startupObserved).toBe(true);
    expect(lifecycle.openNormalWindowIds).toEqual(
      expect.arrayContaining(existingWindowIds),
    );
    expect(lifecycle.restoredWindowIds).toEqual(
      expect.arrayContaining([...existingWindowIds, newWindow.id]),
    );
  } finally {
    await firstContext?.close();
    await secondContext?.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});



test("startup keeps an already restored pinned tab open", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const autoloadUrl = `chrome-extension://${extensionId}/tests/e2e/tab.html?already-restored`;

  await createTabs(popup, [autoloadUrl]);
  await saveSet(popup, "Already restored");
  await selectAutoloadSet(popup, "Already restored");

  const tabIdBeforeStartup = await popup.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs[0].id;
  }, autoloadUrl);

  await popup.evaluate(async () => {
    await chrome.storage.session.remove("savePinnedTabs:lifecycle");
    const { handleStartup } = await import(chrome.runtime.getURL("background/service-worker.js"));
    await handleStartup();
  });

  const tabIdAfterStartup = await popup.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs[0].id;
  }, autoloadUrl);
  expect(tabIdAfterStartup).toBe(tabIdBeforeStartup);
});

test("startup preserves unrelated local extension state", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");

  const localState = await popup.evaluate(async () => {
    await chrome.storage.local.set({
      activeTabs: { 1: "stale" },
      unrelated: "keep",
    });
    const { handleStartup } = await import(chrome.runtime.getURL("background/service-worker.js"));
    await chrome.storage.session.remove("savePinnedTabs:lifecycle");
    await handleStartup();
    return chrome.storage.local.get(null);
  });

  expect(localState.unrelated).toBe("keep");
});

test("the startup handler restores the configured pinned tabs", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup/popup.html");
  const autoloadUrl = `chrome-extension://${extensionId}/options/options.html?startup-handler`;

  await createTabs(popup, [autoloadUrl]);
  await saveSet(popup, "Startup handler");
  await selectAutoloadSet(popup, "Startup handler");
  await removePinnedTabs(popup);

  await popup.evaluate(async () => {
    await chrome.storage.session.remove("savePinnedTabs:lifecycle");
    const { handleStartup } = await import(chrome.runtime.getURL("background/service-worker.js"));
    await handleStartup();
  });

  await expectOpenTabs(context, [autoloadUrl]);
});

test("an autoload selection persists across browser restart", async () => {
  test.slow();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-restart-"));
  const server = http.createServer((request, response) => {
    response.end("<!doctype html><title>Restored tab</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let firstLaunch;
  let secondLaunch;

  try {
    firstLaunch = await launchExtension(userDataDir);
    const popup = await openExtensionPage(
      firstLaunch.context,
      firstLaunch.extensionId,
      "popup/popup.html",
    );
    const { port } = server.address();
    const autoloadUrl = `http://127.0.0.1:${port}/autoloaded`;
    const previousSessionUrl = `http://127.0.0.1:${port}/previous-session`;

    await createTabs(popup, [autoloadUrl]);
    await saveSet(popup, "Startup");
    await selectAutoloadSet(popup, "Startup");
    await removePinnedTabs(popup);
    await createTabs(popup, [previousSessionUrl]);
    await firstLaunch.context.close();
    firstLaunch = undefined;

    secondLaunch = await launchExtension(userDataDir);
    const reopenedPopup = await openExtensionPage(
      secondLaunch.context,
      secondLaunch.extensionId,
      "popup/popup.html",
    );
    await expect(
      reopenedPopup
        .locator(".load-row", { hasText: "Startup" })
        .locator("input[name=autoload]"),
    ).toBeChecked();
    await expectOpenTabs(
      secondLaunch.context,
      [autoloadUrl],
      [previousSessionUrl],
    );
  } finally {
    await firstLaunch?.context.close();
    await secondLaunch?.context.close();
    await rm(userDataDir, { recursive: true, force: true });
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("restart leaves pinned tabs unchanged without an autoload selection", async () => {
  test.slow();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-no-autoload-"));
  const server = http.createServer((request, response) => {
    response.end("<!doctype html><title>Pinned tab</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let firstLaunch;
  let secondLaunch;

  try {
    firstLaunch = await launchExtension(userDataDir);
    const popup = await openExtensionPage(
      firstLaunch.context,
      firstLaunch.extensionId,
      "popup/popup.html",
    );
    const { port } = server.address();
    const pinnedUrl = `http://127.0.0.1:${port}/no-autoload`;
    await createTabs(popup, [pinnedUrl]);
    await firstLaunch.context.close();
    firstLaunch = undefined;

    secondLaunch = await launchExtension(userDataDir);
    const reopenedPopup = await openExtensionPage(
      secondLaunch.context,
      secondLaunch.extensionId,
      "popup/popup.html",
    );
    await runStartupHandler(reopenedPopup);
    expect(await pinnedUrls(reopenedPopup, await currentWindowId(reopenedPopup)))
      .toEqual([pinnedUrl]);
  } finally {
    await firstLaunch?.context.close();
    await secondLaunch?.context.close();
    await rm(userDataDir, { recursive: true, force: true });
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("first-window autoload does not restore into a later window", async () => {
  test.slow();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-first-window-"));
  const server = http.createServer((request, response) => {
    response.end("<!doctype html><title>First window</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let launch;

  try {
    launch = await launchExtension(userDataDir);
    let popup = await openExtensionPage(
      launch.context,
      launch.extensionId,
      "popup/popup.html",
    );
    const { port } = server.address();
    const autoloadUrl = `http://127.0.0.1:${port}/first-window`;
    const secondWindowUrl = `http://127.0.0.1:${port}/second-window`;
    await createTabs(popup, [autoloadUrl]);
    await saveSet(popup, "First window");
    await selectAutoloadSet(popup, "First window");
    await removePinnedTabs(popup);
    launch = await restartExtension(launch, userDataDir);
    popup = await openExtensionPage(launch.context, launch.extensionId, "popup/popup.html");
    await runStartupHandler(popup);
    await expectOpenTabs(launch.context, [autoloadUrl]);
    const secondWindow = await popup.evaluate(
      (url) => chrome.windows.create({ url }),
      secondWindowUrl,
    );

    await expect.poll(() => pinnedUrls(popup, secondWindow.id)).toEqual([]);
  } finally {
    await launch?.context.close();
    await rm(userDataDir, { recursive: true, force: true });
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("repeated restarts do not duplicate autoloaded pinned tabs", async () => {
  test.slow();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-repeat-"));
  let launch;

  try {
    launch = await launchExtension(userDataDir);
    let popup = await openExtensionPage(
      launch.context,
      launch.extensionId,
      "popup/popup.html",
    );
    const autoloadUrl = `chrome-extension://${launch.extensionId}/options/options.html?repeat`;
    await createTabs(popup, [autoloadUrl]);
    await saveSet(popup, "Repeat");
    await selectAutoloadSet(popup, "Repeat");

    for (let restart = 0; restart < 2; restart += 1) {
      launch = await restartExtension(launch, userDataDir);
      popup = await openExtensionPage(
        launch.context,
        launch.extensionId,
        "popup/popup.html",
      );
      await runStartupHandler(popup);
      const urls = await pinnedUrls(popup, await currentWindowId(popup));
      expect(urls.filter((url) => url === autoloadUrl)).toHaveLength(1);
    }
  } finally {
    await launch?.context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("cleared autoload selection is not restored after restart", async () => {
  test.slow();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-clear-autoload-"));
  let launch;

  try {
    launch = await launchExtension(userDataDir);
    let popup = await openExtensionPage(
      launch.context,
      launch.extensionId,
      "popup/popup.html",
    );
    const autoloadUrl = `chrome-extension://${launch.extensionId}/options/options.html?clear`;
    await createTabs(popup, [autoloadUrl]);
    await saveSet(popup, "Clear");
    await selectAutoloadSet(popup, "Clear");
    await clearAutoloadSet(popup, "Clear");
    await removePinnedTabs(popup);
    launch = await restartExtension(launch, userDataDir);
    popup = await openExtensionPage(launch.context, launch.extensionId, "popup/popup.html");
    await runStartupHandler(popup);
    expect(await pinnedUrls(popup, await currentWindowId(popup))).not.toContain(autoloadUrl);
  } finally {
    await launch?.context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("deleted autoload set is not restored after restart", async () => {
  test.slow();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-delete-autoload-"));
  let launch;

  try {
    launch = await launchExtension(userDataDir);
    let popup = await openExtensionPage(
      launch.context,
      launch.extensionId,
      "popup/popup.html",
    );
    const autoloadUrl = `chrome-extension://${launch.extensionId}/options/options.html?deleted`;
    await createTabs(popup, [autoloadUrl]);
    await saveSet(popup, "Deleted");
    await selectAutoloadSet(popup, "Deleted");
    await deleteSet(popup, "Deleted");
    await removePinnedTabs(popup);
    launch = await restartExtension(launch, userDataDir);
    popup = await openExtensionPage(launch.context, launch.extensionId, "popup/popup.html");
    await runStartupHandler(popup);
    expect(await pinnedUrls(popup, await currentWindowId(popup))).not.toContain(autoloadUrl);
  } finally {
    await launch?.context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

