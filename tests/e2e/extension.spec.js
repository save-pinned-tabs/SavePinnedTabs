const http = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  expect,
  launchExtension,
  openExtensionPage,
  test,
} = require("./extension.fixture");

async function createPinnedTabs(page, urls) {
  await page.evaluate(async (tabUrls) => {
    await Promise.all(
      tabUrls.map((url) => chrome.tabs.create({ url, pinned: true, active: false })),
    );
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

async function saveSet(page, name) {
  await page.getByPlaceholder("Enter a name for set...").fill(name);
  const pageLoadTime = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole("button", { name: "Save", exact: true }).click();
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

test("a user can save, update, load, and delete a pinned tab set", async ({
  extension,
}) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const tabFixture = `chrome-extension://${extensionId}/options.html`;
  const firstUrl = `${tabFixture}?first`;
  const secondUrl = `${tabFixture}?second`;
  const unwantedUrl = `${tabFixture}?unwanted`;

  await createPinnedTabs(popup, [firstUrl]);
  await saveSet(popup, "Work");

  await createPinnedTabs(popup, [secondUrl]);
  const pageLoadTime = await popup.evaluate(() => performance.timeOrigin);
  await popup
    .locator(".load-row", { hasText: "Work" })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(popup.getByRole("status")).toHaveText("Tab set saved.");
  expect(await popup.evaluate(() => performance.timeOrigin)).toBe(pageLoadTime);

  await createPinnedTabs(popup, [unwantedUrl]);
  await popup
    .locator(".load-row", { hasText: "Work" })
    .getByRole("button", { name: "Load", exact: true })
    .click();
  await expect(popup.getByRole("status")).toHaveText("Tab set loaded.");

  await expectOpenTabs(context, [firstUrl, secondUrl], [unwantedUrl]);
  const workRow = popup.locator(".load-row", { hasText: "Work" });
  await workRow.getByRole("button", { name: "Del" }).click();
  await expect(popup.locator("#delete-dialog")).toBeVisible();
  await popup.keyboard.press("Escape");
  await expect(popup.locator("#delete-dialog")).toBeHidden();
  await expect(workRow).toBeVisible();
  await deleteSet(popup, "Work");
});

test("Append and Unload preserve ordering and duplicate multiplicity without reloading", async ({
  extension,
}) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const windowId = await currentWindowId(popup);
  const firstUrl = `chrome-extension://${extensionId}/options.html?append-first`;
  const duplicateUrl = `chrome-extension://${extensionId}/options.html?append-duplicate`;
  const trailingUrl = `chrome-extension://${extensionId}/options.html?append-trailing`;

  await createPinnedTabs(popup, [firstUrl, duplicateUrl, duplicateUrl]);
  await saveSet(popup, "Appendable");
  await removePinnedTabs(popup);
  await createPinnedTabs(popup, [trailingUrl, duplicateUrl]);
  const pageLoadTime = await popup.evaluate(() => performance.timeOrigin);

  const row = popup.locator(".load-row", { hasText: "Appendable" });
  await row.getByRole("button", { name: "Append" }).click();
  await expect(popup.getByRole("status")).toHaveText("Tab set appended.");
  expect(await pinnedUrls(popup, windowId)).toEqual([
    trailingUrl,
    duplicateUrl,
    firstUrl,
    duplicateUrl,
  ]);
  expect(await popup.evaluate(() => performance.timeOrigin)).toBe(pageLoadTime);

  await row.getByRole("button", { name: "Unload" }).click();
  await expect(popup.getByRole("status")).toHaveText("Tab set unloaded.");
  expect(await pinnedUrls(popup, windowId)).toEqual([trailingUrl]);
  expect(await popup.evaluate(() => performance.timeOrigin)).toBe(pageLoadTime);
});

test("shortcut assignments persist and registered commands dispatch or no-op", async ({
  extension,
}) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const assignedUrl = `chrome-extension://${extensionId}/options.html?shortcut`;
  const unwantedUrl = `chrome-extension://${extensionId}/options.html?shortcut-unwanted`;
  await createPinnedTabs(popup, [assignedUrl]);
  await saveSet(popup, "Shortcut target");

  const options = await openExtensionPage(context, extensionId, "options.html");
  const assignment = options.locator('[data-shortcut-command="load-set-1"]');
  await assignment.selectOption({ label: "Shortcut target" });
  await expect(options.getByRole("status")).toHaveText("Shortcut assignment saved.");
  const assignedSetId = await assignment.inputValue();
  await options.reload();
  await expect(assignment).toHaveValue(assignedSetId);
  await createPinnedTabs(popup, [unwantedUrl]);

  const worker = context.serviceWorkers()[0];
  expect(await worker.evaluate(async () => savePinnedTabsCommandListener("load-set-1")))
    .toMatchObject({ status: "success", value: { executed: true } });
  await expectOpenTabs(context, [assignedUrl], [unwantedUrl]);

  const before = await pinnedUrls(popup, await currentWindowId(popup));
  expect(await worker.evaluate(async () => savePinnedTabsCommandListener("load-set-4")))
    .toEqual({ status: "success", value: { executed: false } });
  expect(await pinnedUrls(popup, await currentWindowId(popup))).toEqual(before);
});

test("multi-set Autoload replaces then appends in every normal window and ignores popups", async ({
  extension,
}) => {
  const { context, extensionId } = extension;
  const options = await openExtensionPage(context, extensionId, "options.html");
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const firstUrl = `chrome-extension://${extensionId}/options.html?autoload-first`;
  const secondUrl = `chrome-extension://${extensionId}/options.html?autoload-second`;
  const duplicateUrl = `chrome-extension://${extensionId}/options.html?autoload-duplicate`;
  const document = {
    version: 2,
    sets: [
      { id: firstId, name: "First Autoload", tabs: [firstUrl, duplicateUrl] },
      { id: secondId, name: "Second Autoload", tabs: [duplicateUrl, secondUrl] },
    ],
    autoload: { scope: "every-window", setIds: [firstId, secondId] },
  };
  await options.locator("#import-input").setInputFiles({
    name: "autoload.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await options.getByRole("button", { name: "Import" }).click();
  await expect(options.getByRole("status")).toHaveText("Successfully imported 2 tab sets.");
  await options.evaluate(async () => {
    const { handleStartup } = await import(chrome.runtime.getURL("service_worker.js"));
    await chrome.storage.session.remove("savePinnedTabs:lifecycle");
    await handleStartup();
  });
  const existingWindowId = await currentWindowId(options);
  await expect.poll(() => pinnedUrls(options, existingWindowId)).toEqual([
    firstUrl,
    duplicateUrl,
    secondUrl,
  ]);

  const normalWindowId = await options.evaluate(async () => (
    await chrome.windows.create({ type: "normal" })
  ).id);
  await expect.poll(() => pinnedUrls(options, normalWindowId)).toEqual([
    firstUrl,
    duplicateUrl,
    secondUrl,
  ]);

  const popupWindowId = await options.evaluate(async () => (
    await chrome.windows.create({ type: "popup", url: chrome.runtime.getURL("popup.html") })
  ).id);
  await expect.poll(() => pinnedUrls(options, popupWindowId)).toEqual([]);
  await options.evaluate(
    async (windowIds) => Promise.all(windowIds.map((id) => chrome.windows.remove(id))),
    [normalWindowId, popupWindowId],
  );
});

test("a pending failure blocks duplicate commands and recovers in place", async ({
  extension,
}) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const existingUrl = `chrome-extension://${extensionId}/options.html?existing`;
  await createPinnedTabs(popup, [existingUrl]);
  await saveSet(popup, "Existing");

  await popup.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.captureCommands = 0;
    chrome.runtime.sendMessage = (message) => {
      if (message?.operation !== "captureAndSave") return original(message);
      globalThis.captureCommands += 1;
      return new Promise((resolve, reject) => {
        globalThis.rejectCapture = () => reject(
          new Error("Storage is unavailable; try again."),
        );
      });
    };
  });
  await popup.getByPlaceholder("Enter a name for set...").fill("Fails");
  const save = popup.getByRole("button", { name: "Save", exact: true }).first();
  await save.dblclick();
  await expect(popup.locator("body")).toHaveAttribute("aria-busy", "true");
  await expect(save).toBeDisabled();
  await expect(popup.getByRole("status")).toHaveText("Saving tab set…");
  await popup.evaluate(() => globalThis.rejectCapture());
  await expect(popup.getByRole("status")).toHaveText(/Storage is unavailable; try again\./);
  expect(await popup.evaluate(() => globalThis.captureCommands)).toBe(1);
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
      "popup.html",
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
        sessionSetId: local["savePinnedTabs:local"].windowSessions["1"],
        shortcutSetId: local["savePinnedTabs:local"].shortcutAssignments["load-set-1"],
      };
    }, { legacyKey });
    expect(migrated.legacyRemoved).toBe(true);
    expect(migrated.set).toMatchObject({
      name: "Legacy Work",
      tabs: ["https://example.com/legacy"],
    });
    expect(migrated.autoloadSetIds).toEqual([migrated.set.id]);
    expect(migrated.sessionSetId).toBe(migrated.set.id);
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
      "popup.html",
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
  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const longName =
    "A very long saved tab set title that remains readable instead of being truncated";
  await createPinnedTabs(popup, [
    `chrome-extension://${extensionId}/options.html?long-title`,
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

test("a user can export and import tab sets", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup.html");

  await createPinnedTabs(popup, [
    `chrome-extension://${extensionId}/options.html?exported`,
  ]);
  await saveSet(popup, "Backup");

  const options = await openExtensionPage(context, extensionId, "options.html");
  const downloadPromise = options.waitForEvent("download");
  await options.getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  const exportPath = await download.path();
  expect(download.suggestedFilename()).toMatch(/^SavePinnedTabs_export_.*\.json$/);

  await deleteSet(popup, "Backup");
  await options.locator("#import-input").setInputFiles(exportPath);
  await options.getByRole("button", { name: "Import" }).click();
  await expect(
    options.getByText("Successfully imported 1 tab set.", { exact: true }),
  ).toBeVisible();

  await popup.reload();
  await expect(popup.locator(".load-row", { hasText: "Backup" })).toBeVisible();
});

test("an imported tab-set name is rendered as text", async ({ extension }) => {
  const { context, extensionId } = extension;
  const options = await openExtensionPage(context, extensionId, "options.html");
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

  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const row = popup.locator(".load-row", { hasText: setName });
  await expect(row.locator("span")).toHaveText(setName);
  await expect(popup.locator("#injected-markup")).toHaveCount(0);
});

test("a schema-invalid import is rejected", async ({ extension }) => {
  const { context, extensionId } = extension;
  const options = await openExtensionPage(context, extensionId, "options.html");
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

  const popup = await openExtensionPage(context, extensionId, "popup.html");
  await expect(popup.locator(".load-row", { hasText: "Invalid" })).toHaveCount(0);
});


test("startup keeps an already restored pinned tab open", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const autoloadUrl = `chrome-extension://${extensionId}/tests/e2e/tab.html?already-restored`;

  await createPinnedTabs(popup, [autoloadUrl]);
  await saveSet(popup, "Already restored");
  await selectAutoloadSet(popup, "Already restored");

  const tabIdBeforeStartup = await popup.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs[0].id;
  }, autoloadUrl);

  await popup.evaluate(async () => {
    await chrome.storage.session.remove("savePinnedTabs:lifecycle");
    const { handleStartup } = await import(chrome.runtime.getURL("service_worker.js"));
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
  const popup = await openExtensionPage(context, extensionId, "popup.html");

  const localState = await popup.evaluate(async () => {
    await chrome.storage.local.set({
      activeTabs: { 1: "stale" },
      unrelated: "keep",
    });
    const { handleStartup } = await import(chrome.runtime.getURL("service_worker.js"));
    await chrome.storage.session.remove("savePinnedTabs:lifecycle");
    await handleStartup();
    return chrome.storage.local.get(null);
  });

  expect(localState.unrelated).toBe("keep");
});

test("the startup handler restores the configured pinned tabs", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const autoloadUrl = `chrome-extension://${extensionId}/options.html?startup-handler`;

  await createPinnedTabs(popup, [autoloadUrl]);
  await saveSet(popup, "Startup handler");
  await selectAutoloadSet(popup, "Startup handler");
  await removePinnedTabs(popup);

  await popup.evaluate(async () => {
    await chrome.storage.session.remove("savePinnedTabs:lifecycle");
    const { handleStartup } = await import(chrome.runtime.getURL("service_worker.js"));
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
      "popup.html",
    );
    const { port } = server.address();
    const autoloadUrl = `http://127.0.0.1:${port}/autoloaded`;

    await createPinnedTabs(popup, [autoloadUrl]);
    await saveSet(popup, "Startup");
    await selectAutoloadSet(popup, "Startup");
    await firstLaunch.context.close();
    firstLaunch = undefined;

    secondLaunch = await launchExtension(userDataDir);
    const reopenedPopup = await openExtensionPage(
      secondLaunch.context,
      secondLaunch.extensionId,
      "popup.html",
    );
    await expect(
      reopenedPopup
        .locator(".load-row", { hasText: "Startup" })
        .locator("input[name=autoload]"),
    ).toBeChecked();
    await expectOpenTabs(secondLaunch.context, [autoloadUrl]);
  } finally {
    await firstLaunch?.context.close();
    await secondLaunch?.context.close();
    await rm(userDataDir, { recursive: true, force: true });
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

