import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Builder, By, Key, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

const extensionId = "savepinnedtabs@buildyourweb.app";
const packageJson = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
const buildPath = path.resolve(
  `dist/save_pinned_tabs-${packageJson.version}-firefox.zip`,
);
const firefoxBinary = process.env.FIREFOX_BINARY;
let driver;
let temporaryDirectory;
let addonPath;
let extensionOrigin;
let profileDirectory;

async function launchFirefox({ installAddon = false } = {}) {
  const options = new firefox.Options()
    .addArguments("-headless", "-profile", profileDirectory)
    .setPreference("xpinstall.signatures.required", false)
    .setPreference("browser.download.dir", temporaryDirectory)
    .setPreference("browser.download.folderList", 2)
    .setPreference("browser.helperApps.neverAsk.saveToDisk", "application/json");
  if (firefoxBinary) options.setBinary(firefoxBinary);
  const service = new firefox.ServiceBuilder().addArguments("--allow-system-access");
  const nextDriver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();

  try {
    if (installAddon) await nextDriver.installAddon(addonPath, true);
    await nextDriver.setContext(firefox.Context.CHROME);
    const extensionUuids = await nextDriver.executeScript(
      'return Services.prefs.getStringPref("extensions.webextensions.uuids");',
    );
    const extensionUuid = JSON.parse(extensionUuids)[extensionId];
    assert.ok(extensionUuid, `Firefox did not register ${extensionId}`);
    await nextDriver.setContext(firefox.Context.CONTENT);
    return {
      driver: nextDriver,
      extensionOrigin: `moz-extension://${extensionUuid}`,
    };
  } catch (error) {
    await nextDriver.quit();
    throw error;
  }
}

beforeEach(async () => {
  driver = undefined;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-firefox-"));
  addonPath = path.join(temporaryDirectory, "save-pinned-tabs.xpi");
  profileDirectory = path.join(temporaryDirectory, "profile");
  await mkdir(profileDirectory);
  await copyFile(buildPath, addonPath);
  ({ driver, extensionOrigin } = await launchFirefox({ installAddon: true }));
});

afterEach(async () => {
  await driver?.quit();
  driver = undefined;
  await rm(temporaryDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

async function openExtensionPage(pageName) {
  await driver.get(`${extensionOrigin}/${pageName}`);
  await driver.wait(
    () => driver.executeScript('return document.body.getAttribute("aria-busy") === "false";'),
    30_000,
    `${pageName} controls to become ready`,
  );
}

async function waitForStatus(id, text) {
  const element = await driver.findElement(By.id(id));
  await driver.wait(until.elementTextIs(element, text), 10_000, `status "${text}"`);
}

async function openStorageFixturePage() {
  await driver.get(`${extensionOrigin}/manifest.json`);
}

async function createTabs(urls, pinned = true) {
  const error = await driver.executeAsyncScript(async (tabUrls, isPinned, done) => {
    try {
      for (const url of tabUrls) {
        await browser.tabs.create({ url, pinned: isPinned, active: false });
      }
      done(null);
    } catch (cause) {
      done(cause.message);
    }
  }, urls, pinned);
  if (error) throw new Error(`Failed to create tabs: ${error}`);
}

async function removeOrUnpinTabs(urls) {
  const error = await driver.executeAsyncScript(async (tabUrls, done) => {
    try {
      const tabs = await browser.tabs.query({ currentWindow: true });
      const matchingTabs = tabs.filter((tab) => tab.url && tabUrls.includes(tab.url));
      await browser.tabs.update(matchingTabs[0].id, { pinned: false });
      await browser.tabs.remove(matchingTabs.slice(1).map((tab) => tab.id));
      done(null);
    } catch (cause) {
      done(cause.message);
    }
  }, urls);
  if (error) throw new Error(`Failed to remove or unpin tabs: ${error}`);
}


async function removePinnedTabs() {
  const error = await driver.executeAsyncScript((done) => {
    browser.tabs.query({ pinned: true, currentWindow: true })
      .then((tabs) => browser.tabs.remove(tabs.map((tab) => tab.id)))
      .then(() => done(null), (cause) => done(cause.message));
  });
  if (error) throw new Error(`Failed to remove pinned tabs: ${error}`);
}

async function pinnedUrls(windowId) {
  return driver.executeAsyncScript((targetWindowId, done) => {
    const query = targetWindowId === null
      ? { pinned: true, currentWindow: true }
      : { pinned: true, windowId: targetWindowId };
    browser.tabs.query(query).then(
      (tabs) => done(tabs.map((tab) => tab.url)),
      (error) => done({ error: error.message }),
    );
  }, windowId ?? null);
}
async function waitForPinnedUrls(expectedUrls) {
  await driver.wait(
    async () => JSON.stringify(await pinnedUrls()) === JSON.stringify(expectedUrls),
    10_000,
    `pinned URLs ${JSON.stringify(expectedUrls)}`,
  );
}



async function saveSet(name) {
  await driver.findElement(By.id("save-name")).sendKeys(name);
  await driver.findElement(By.id("save-button")).click();
  await driver.wait(until.elementLocated(By.css(`.load-row[data-name="${name}"]`)), 10_000);
}

async function selectAutoloadSet(name) {
  await driver.findElement(
    By.css(`.load-row[data-name="${name}"] input[name=autoload]`),
  ).click();
  await waitForStatus("popup-status", "Autoload selection updated.");
}

async function clearAutoloadSet(name) {
  await driver.findElement(
    By.css(`.load-row[data-name="${name}"] input[name=autoload]`),
  ).click();
  await waitForStatus("popup-status", "Autoload selection updated.");
}

async function deleteSet(name) {
  const row = await driver.findElement(By.css(`.load-row[data-name="${name}"]`));
  await row.findElement(By.css(".set-delete")).click();
  await driver.findElement(By.css("#delete-dialog button[value=delete]")).click();
  await waitForStatus("popup-status", "Tab set deleted.");
}

async function restartFirefox() {
  await driver.quit();
  driver = undefined;
  ({ driver, extensionOrigin } = await launchFirefox({ installAddon: true }));
}

async function runStartupHandler() {
  const error = await driver.executeAsyncScript(async (done) => {
    try {
      await browser.storage.session.remove("savePinnedTabs:lifecycle");
      const { handleStartup } = await import(
        browser.runtime.getURL("background/service-worker.js")
      );
      await handleStartup();
      done(null);
    } catch (cause) {
      done(cause.message);
    }
  });
  if (error) throw new Error(`Failed to run startup handler: ${error}`);
}

async function importDocument(document, fileName = "import.json") {
  const importPath = path.join(temporaryDirectory, fileName);
  await writeFile(importPath, JSON.stringify(document));
  await driver.findElement(By.id("import-input")).sendKeys(importPath);
  await driver.findElement(By.id("import-button")).click();
}

test("a user can save a pinned tab set without reloading", async () => {
  await openExtensionPage("popup/popup.html");
  await createTabs([`${extensionOrigin}/options/options.html?save`]);
  const pageLoadTime = await driver.executeScript("return performance.timeOrigin");
  await saveSet("Work");
  assert.equal(await driver.executeScript("return performance.timeOrigin"), pageLoadTime);
});

test("set names are trimmed and preserve duplicate, Unicode, RTL, and combining text", async () => {
  await openExtensionPage("popup/popup.html");
  await createTabs([`${extensionOrigin}/options/options.html?names`]);
  const saveName = await driver.findElement(By.id("save-name"));

  await saveName.sendKeys("   ", Key.ENTER);
  await waitForStatus("popup-status", "Enter a name for the tab set.");

  for (const name of ["  Trimmed  ", "日本語", "مرحبا", "Cafe\u0301", "日本語"]) {
    await saveName.sendKeys(name, Key.ENTER);
    await waitForStatus("popup-status", "Tab set saved.");
  }

  assert.equal((await driver.findElements(By.css('.load-row[data-name="Trimmed"]'))).length, 1);
  assert.equal((await driver.findElements(By.css('.load-row[data-name="日本語"]'))).length, 2);
  assert.equal((await driver.findElements(By.css('.load-row[data-name="مرحبا"]'))).length, 1);
  assert.equal((await driver.findElements(By.css('.load-row[data-name="Café"]'))).length, 1);
});

test("keyboard focus follows the popup control order", async () => {
  await openExtensionPage("popup/popup.html");
  await createTabs([`${extensionOrigin}/options/options.html?keyboard`]);
  await saveSet("Keyboard");
  await driver.findElement(By.id("save-name")).click();

  const focusOrder = [
    ["id", "save-name"],
    ["id", "save-button"],
    ["name", "autoload"],
    ["class", "set-save"],
    ["class", "set-load"],
    ["class", "set-delete"],
  ];
  for (const [attribute, value] of focusOrder) {
    assert.equal(
      await driver.switchTo().activeElement().getAttribute(attribute),
      value,
    );
    await driver.actions().sendKeys(Key.TAB).perform();
  }
});

test("a user can update a pinned tab set without reloading", async () => {
  await openExtensionPage("popup/popup.html");
  await createTabs([`${extensionOrigin}/options/options.html?first`]);
  await saveSet("Work");
  const secondUrl = `${extensionOrigin}/options/options.html?second`;
  await createTabs([secondUrl]);
  const pageLoadTime = await driver.executeScript("return performance.timeOrigin");
  await driver.findElement(By.css('.load-row[data-name="Work"] .set-save')).click();
  await waitForStatus("popup-status", "Tab set saved.");
  assert.ok((await pinnedUrls()).includes(secondUrl));
  assert.equal(await driver.executeScript("return performance.timeOrigin"), pageLoadTime);
});

test("updating a set removes tabs that were unpinned or closed", async () => {
  await openExtensionPage("popup/popup.html");
  const removedUrls = [
    `${extensionOrigin}/options/options.html?unpin-on-update`,
    `${extensionOrigin}/options/options.html?close-on-update`,
  ];
  const retainedUrl = `${extensionOrigin}/options/options.html?retain-on-update`;
  await createTabs([...removedUrls, retainedUrl]);
  await saveSet("Updated");
  await removeOrUnpinTabs(removedUrls);

  await driver.findElement(By.css('.load-row[data-name="Updated"] .set-save')).click();
  await waitForStatus("popup-status", "Tab set saved.");
  await removePinnedTabs();
  await driver.findElement(By.css('.load-row[data-name="Updated"] .set-load')).click();

  await waitForStatus("popup-status", "Tab set loaded.");
  assert.deepEqual(await pinnedUrls(), [retainedUrl]);
});

test("saving a set ignores unpinned tabs", async () => {
  await openExtensionPage("popup/popup.html");
  const pinnedUrl = `${extensionOrigin}/options/options.html?pinned`;
  const unpinnedUrl = `${extensionOrigin}/options/options.html?unpinned`;
  await createTabs([pinnedUrl]);
  await createTabs([unpinnedUrl], false);
  await saveSet("Pinned only");
  await removePinnedTabs();

  await driver.findElement(By.css('.load-row[data-name="Pinned only"] .set-load')).click();

  await waitForStatus("popup-status", "Tab set loaded.");
  assert.deepEqual(await pinnedUrls(), [pinnedUrl]);
  assert.equal(await driver.executeAsyncScript((url, done) => {
    browser.tabs.query({ currentWindow: true })
      .then((tabs) => done(tabs.some((tab) => tab.url === url)));
  }, unpinnedUrl), true);
});

test("saving with no pinned tabs does not create an empty set", async () => {
  await openExtensionPage("popup/popup.html");
  await createTabs([`${extensionOrigin}/options/options.html?only-unpinned`], false);
  await driver.findElement(By.id("save-name")).sendKeys("Empty");

  await driver.findElement(By.id("save-button")).click();

  await waitForStatus(
    "popup-status",
    "Failed to save tab set: No pinned tabs found.",
  );
  assert.equal(
    (await driver.findElements(By.css('.load-row[data-name="Empty"]'))).length,
    0,
  );
});

test("a user can load a pinned tab set without reloading", async () => {
  await openExtensionPage("popup/popup.html");
  const savedUrl = `${extensionOrigin}/options/options.html?saved`;
  await createTabs([savedUrl]);
  await saveSet("Work");
  await createTabs([`${extensionOrigin}/options/options.html?unwanted`]);
  const pageLoadTime = await driver.executeScript("return performance.timeOrigin");
  await driver.findElement(By.css('.load-row[data-name="Work"] .set-load')).click();
  await waitForStatus("popup-status", "Tab set loaded.");
  assert.deepEqual(await pinnedUrls(), [savedUrl]);
  assert.equal(await driver.executeScript("return performance.timeOrigin"), pageLoadTime);
});

test("loading a set changes only the initiating window and preserves pinned order", async () => {
  await openExtensionPage("popup/popup.html");
  const savedUrls = [
    `${extensionOrigin}/options/options.html?ordered-first`,
    `${extensionOrigin}/options/options.html?ordered-second`,
  ];
  await createTabs(savedUrls);
  await saveSet("Ordered");
  await removePinnedTabs();
  const otherUrl = `${extensionOrigin}/options/options.html?other-window`;
  const otherWindowId = await driver.executeAsyncScript(async (url, done) => {
    const window = await browser.windows.create({ url });
    const [tab] = await browser.tabs.query({ windowId: window.id });
    await browser.tabs.update(tab.id, { pinned: true });
    done(window.id);
  }, otherUrl);
  await openExtensionPage("popup/popup.html");
  const initiatingWindowId = await driver.executeAsyncScript((done) => {
    browser.windows.getCurrent().then((window) => done(window.id));
  });

  await driver.findElement(By.css('.load-row[data-name="Ordered"] .set-load')).click();

  await waitForStatus("popup-status", "Tab set loaded.");
  assert.deepEqual(await pinnedUrls(initiatingWindowId), savedUrls);
  assert.deepEqual(await pinnedUrls(otherWindowId), [otherUrl]);
});

test("a tab creation failure preserves original pinned tabs and reports the failed URL", async () => {
  const failedUrl = "http://[invalid";
  await openExtensionPage("options/options.html");
  const failingSetId = "00000000-0000-4000-8000-000000000001";
  await importDocument({
    version: 2,
    sets: [{ id: failingSetId, name: "Failing", tabs: [failedUrl] }],
    autoload: { scope: "first-window", setIds: [] },
  }, "failing.json");
  await waitForStatus("options-status", "Successfully imported 1 tab set.");
  await openExtensionPage("popup/popup.html");
  const originalUrl = `${extensionOrigin}/options/options.html?original`;
  await createTabs([originalUrl]);

  await driver.findElement(By.css('.load-row[data-name="Failing"] .set-load')).click();

  await driver.wait(async () => (
    (await driver.findElement(By.id("popup-status")).getText()).includes(failedUrl)
  ), 10_000, "actionable failed URL");
  assert.deepEqual(await pinnedUrls(), [originalUrl]);
});

test("the delete dialog contains focus and returns it after cancellation", async () => {
  await openExtensionPage("popup/popup.html");
  await createTabs([`${extensionOrigin}/options/options.html?cancel-delete`]);
  await saveSet("Work");
  const opener = await driver.findElement(By.css('.load-row[data-name="Work"] .set-delete'));
  await opener.click();
  const dialog = await driver.findElement(By.id("delete-dialog"));
  const cancel = await driver.findElement(By.css('#delete-dialog button[value="cancel"]'));
  await driver.wait(until.elementIsVisible(dialog), 10_000);
  assert.equal(
    await driver.switchTo().activeElement().getAttribute("value"),
    "cancel",
  );

  await driver.actions().sendKeys(Key.TAB).perform();
  assert.equal(
    await driver.switchTo().activeElement().getAttribute("value"),
    "delete",
  );
  await driver.actions().sendKeys(Key.TAB).perform();
  assert.equal(
    await driver.executeScript(
      'return document.querySelector("#delete-dialog").contains(document.activeElement);',
    ),
    true,
  );
  await cancel.click();

  await driver.wait(until.elementIsNotVisible(dialog), 10_000);
  await driver.wait(async () => (
    await driver.switchTo().activeElement().getAttribute("class")
  ) === "set-delete", 10_000, "delete opener to regain focus");
  await waitForStatus("popup-status", "Deletion canceled.");

  await opener.click();
  await driver.actions().sendKeys(Key.ESCAPE).perform();
  await driver.wait(until.elementIsNotVisible(dialog), 10_000);
  await driver.wait(async () => (
    await driver.switchTo().activeElement().getAttribute("class")
  ) === "set-delete", 10_000, "delete opener to regain focus");
});

test("a user can delete a pinned tab set without reloading", async () => {
  await openExtensionPage("popup/popup.html");
  await createTabs([`${extensionOrigin}/options/options.html?delete`]);
  await saveSet("Work");
  const pageLoadTime = await driver.executeScript("return performance.timeOrigin");
  const row = await driver.findElement(By.css('.load-row[data-name="Work"]'));
  await row.findElement(By.css(".set-delete")).click();
  await driver.findElement(By.css("#delete-dialog button[value=delete]")).click();
  await waitForStatus("popup-status", "Tab set deleted.");
  await driver.wait(until.stalenessOf(row), 10_000);
  assert.equal(await driver.executeScript("return performance.timeOrigin"), pageLoadTime);
});
test("a pending failure blocks duplicate commands and recovers in place", async () => {
  await openExtensionPage("popup/popup.html");
  const existingUrl = `${extensionOrigin}/options/options.html?existing`;
  await createTabs([existingUrl]);
  await saveSet("Existing");
  await driver.executeScript(() => {
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
  await driver.findElement(By.id("save-name")).sendKeys("Fails");
  const save = await driver.findElement(By.id("save-button"));
  await driver.executeScript("arguments[0].click(); arguments[0].click();", save);
  await driver.wait(
    () => driver.executeScript(
      "return globalThis.savePinnedTabsController.testCommandCount === 1 && typeof globalThis.savePinnedTabsController.rejectTestCommand === 'function'",
    ),
    10_000,
    "one controller command to become pending",
  );
  await driver.wait(until.elementIsDisabled(save), 10_000);
  assert.equal(await driver.findElement(By.css("body")).getAttribute("aria-busy"), "true");
  assert.equal(await driver.findElement(By.id("popup-status")).getText(), "Saving tab set…");
  await driver.executeScript("globalThis.savePinnedTabsController.rejectTestCommand()");
  await waitForStatus("popup-status", "Storage is unavailable; try again.");
  assert.equal(
    await driver.executeScript("return globalThis.savePinnedTabsController.testCommandCount"),
    1,
  );
  assert.ok(await driver.findElement(By.css('.load-row[data-name="Existing"]')));
  await driver.wait(until.elementIsEnabled(save), 10_000);
  assert.equal(await driver.findElement(By.css("body")).getAttribute("aria-busy"), "false");
});

test("a legacy profile migrates sets and references exactly once across restarts", async () => {
  const legacyKey = Buffer.from("Legacy Work").toString("base64");
  const lateLegacyKey = Buffer.from("Late Legacy").toString("base64");
  await openStorageFixturePage();
  const schemaExists = await driver.executeAsyncScript((setKey, done) => {
    (async () => {
      let sync = await browser.storage.sync.get(null);
      while (!("savePinnedTabs:index" in sync)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        sync = await browser.storage.sync.get(null);
      }
      const oldChunks = sync["savePinnedTabs:index"].chunks;
      await browser.storage.sync.set({
        [setKey]: {
          autoload: 1,
          set_name: "Legacy Work",
          tabs: ["https://example.com/legacy"],
        },
      });
      await browser.storage.local.set({
        activeTabs: { 1: setKey },
      });
      await Promise.all([
        browser.storage.sync.remove(["savePinnedTabs:index", ...oldChunks]),
        browser.storage.local.remove("savePinnedTabs:local"),
      ]);
      done("savePinnedTabs:index" in await browser.storage.sync.get(null));
    })().catch((error) => done({ error: String(error) }));
  }, legacyKey);
  assert.equal(schemaExists, false);
  await restartFirefox();
  await openExtensionPage("popup/popup.html");
  await driver.wait(until.elementLocated(By.css('.load-row[data-name="Legacy Work"]')), 10_000);
  const migrated = await driver.executeAsyncScript((setKey, done) => {
    Promise.all([browser.storage.sync.get(null), browser.storage.local.get(null)])
      .then(([sync, local]) => {
        const index = sync["savePinnedTabs:index"];
        const document = JSON.parse(index.chunks.map((key) => sync[key]).join(""));
        const setId = Object.keys(document.sets)[0];
        done({
          legacyRemoved: !(setKey in sync),
          set: document.sets[setId],
          autoloadSetIds: document.autoload.setIds,
        });
      });
  }, legacyKey);
  assert.equal(migrated.legacyRemoved, true);
  assert.deepEqual(migrated.set, {
    id: migrated.set.id,
    name: "Legacy Work",
    tabs: ["https://example.com/legacy"],
  });
  assert.deepEqual(migrated.autoloadSetIds, [migrated.set.id]);
  await driver.executeAsyncScript((setKey, done) => {
    browser.storage.sync.set({
      [setKey]: { autoload: 0, set_name: "Late Legacy", tabs: ["https://example.com/late"] },
    }).then(() => done());
  }, lateLegacyKey);
  await restartFirefox();
  await openExtensionPage("popup/popup.html");
  assert.equal((await driver.findElements(By.css('.load-row[data-name="Late Legacy"]'))).length, 1);
});

test("saved-set titles can exceed 30 characters and wrap", async () => {
  await openExtensionPage("popup/popup.html");
  const longName = "A very long saved tab set title that remains readable instead of being truncated";
  await createTabs([`${extensionOrigin}/options/options.html?long-title`]);
  await saveSet(longName);
  const title = await driver.findElement(By.css(`.load-row[data-name="${longName}"] span`));
  assert.equal(await title.getText(), longName);
  assert.equal(await driver.executeScript((element) => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    return element.scrollHeight > lineHeight * 1.5;
  }, title), true);
});

test("export and import preserve multiple sets, tab order, identities, and autoload", async () => {
  await openExtensionPage("popup/popup.html");
  const firstUrls = [
    `${extensionOrigin}/options/options.html?export-first-a`,
    `${extensionOrigin}/options/options.html?export-first-b`,
  ];
  const secondUrls = [
    `${extensionOrigin}/options/options.html?export-second-a`,
    `${extensionOrigin}/options/options.html?export-second-b`,
  ];
  await createTabs(firstUrls);
  await saveSet("First backup");
  await removePinnedTabs();
  await createTabs(secondUrls);
  await saveSet("Second backup");
  await selectAutoloadSet("Second backup");

  await openExtensionPage("options/options.html");
  await driver.findElement(By.id("export-button")).click();
  await waitForStatus("options-status", "Tab sets exported.");
  let exportName;
  await driver.wait(async () => {
    exportName = (await readdir(temporaryDirectory))
      .find((name) => /^SavePinnedTabs_export_.*\.json$/.test(name));
    return Boolean(exportName);
  }, 10_000);
  const exportPath = path.join(temporaryDirectory, exportName);
  const exportedDocument = JSON.parse(await readFile(exportPath, "utf8"));
  assert.equal(exportedDocument.version, 2);
  assert.equal(exportedDocument.sets.length, 2);
  const firstExport = exportedDocument.sets.find((set) => set.name === "First backup");
  const secondExport = exportedDocument.sets.find((set) => set.name === "Second backup");
  assert.deepEqual(firstExport.tabs, firstUrls);
  assert.deepEqual(secondExport.tabs, secondUrls);
  assert.equal(exportedDocument.sets.every((set) => /^[0-9a-f-]{36}$/.test(set.id)), true);
  assert.equal(new Set(exportedDocument.sets.map((set) => set.id)).size, 2);
  assert.deepEqual(exportedDocument.autoload, {
    scope: "first-window",
    setIds: [secondExport.id],
  });

  await openExtensionPage("popup/popup.html");
  await deleteSet("First backup");
  await deleteSet("Second backup");
  await openExtensionPage("options/options.html");
  await driver.findElement(By.id("import-input")).sendKeys(exportPath);
  await driver.findElement(By.id("import-button")).click();
  await waitForStatus("options-status", "Successfully imported 2 tab sets.");

  await openExtensionPage("popup/popup.html");
  assert.equal(
    await driver.findElement(
      By.css('.load-row[data-name="Second backup"] input[name=autoload]'),
    ).isSelected(),
    true,
  );
  await driver.findElement(By.css('.load-row[data-name="First backup"] .set-load')).click();
  await waitForPinnedUrls(firstUrls);
  await driver.findElement(By.css('.load-row[data-name="Second backup"] .set-load')).click();
  await waitForPinnedUrls(secondUrls);
});

test("identity collisions and repeated imports create independent usable sets", async () => {
  await openExtensionPage("popup/popup.html");
  const existingUrl = `${extensionOrigin}/options/options.html?collision-existing`;
  const importedUrl = `${extensionOrigin}/options/options.html?collision-imported`;
  await createTabs([existingUrl]);
  await saveSet("Duplicate");
  const existingId = await driver.executeAsyncScript((done) => {
    browser.storage.sync.get(null).then((storage) => {
      const index = storage["savePinnedTabs:index"];
      const document = JSON.parse(index.chunks.map((key) => storage[key]).join(""));
      done(Object.keys(document.sets)[0]);
    });
  });
  const document = {
    version: 2,
    sets: [{ id: existingId, name: "Duplicate", tabs: [importedUrl] }],
    autoload: { scope: "first-window", setIds: [] },
  };
  await openExtensionPage("options/options.html");
  await importDocument(document, "collision.json");
  await waitForStatus("options-status", "Successfully imported 1 tab set.");
  await importDocument(document, "collision-again.json");
  await waitForStatus("options-status", "Successfully imported 1 tab set.");

  await openExtensionPage("popup/popup.html");
  let duplicateRows = await driver.findElements(By.css('.load-row[data-name="Duplicate"]'));
  assert.equal(duplicateRows.length, 3);
  await duplicateRows[0].findElement(By.css(".set-load")).click();
  await waitForStatus("popup-status", "Tab set loaded.");
  await waitForPinnedUrls([existingUrl]);
  duplicateRows = await driver.findElements(By.css('.load-row[data-name="Duplicate"]'));
  await duplicateRows[1].findElement(By.css(".set-load")).click();
  await waitForStatus("popup-status", "Tab set loaded.");
  await waitForPinnedUrls([importedUrl]);
  duplicateRows = await driver.findElements(By.css('.load-row[data-name="Duplicate"]'));
  await duplicateRows[1].findElement(By.css(".set-delete")).click();
  await driver.findElement(By.css("#delete-dialog button[value=delete]")).click();
  await waitForStatus("popup-status", "Tab set deleted.");
  duplicateRows = await driver.findElements(By.css('.load-row[data-name="Duplicate"]'));
  assert.equal(duplicateRows.length, 2);
  await duplicateRows[1].findElement(By.css(".set-load")).click();
  await waitForStatus("popup-status", "Tab set loaded.");
  await waitForPinnedUrls([importedUrl]);
});

test("an imported tab-set name is rendered as text", async () => {
  await openExtensionPage("options/options.html");
  const setName = '<img id="injected-markup" src="invalid">';
  await importDocument({
    markup: { autoload: 0, set_name: setName, tabs: ["https://example.com"] },
  }, "markup.json");
  await waitForStatus("options-status", "Successfully imported 1 tab set.");
  await openExtensionPage("popup/popup.html");
  const rows = await driver.findElements(By.css(".load-row"));
  assert.equal(await rows[0].findElement(By.css("span")).getText(), setName);
  assert.equal((await driver.findElements(By.id("injected-markup"))).length, 0);
});

test("a schema-invalid import is rejected", async () => {
  await openExtensionPage("options/options.html");
  await importDocument({
    invalid: { autoload: 2, set_name: "Invalid", tabs: ["https://example.com"] },
  }, "invalid.json");
  await driver.wait(async () => (
    (await driver.findElement(By.id("options-status")).getText()).includes("Import validation failed")
  ), 10_000);
  await openExtensionPage("popup/popup.html");
  assert.equal((await driver.findElements(By.css('.load-row[data-name="Invalid"]'))).length, 0);
});

test("malformed JSON and unsupported import versions announce actionable errors", async () => {
  await openExtensionPage("options/options.html");
  const malformedPath = path.join(temporaryDirectory, "malformed.json");
  await writeFile(malformedPath, "{");
  await driver.findElement(By.id("import-input")).sendKeys(malformedPath);
  await driver.findElement(By.id("import-button")).click();
  await waitForStatus(
    "options-status",
    "Malformed JSON file. Choose a valid Save Pinned Tabs export.",
  );
  assert.equal(
    await driver.findElement(By.id("options-status")).getAttribute("data-kind"),
    "error",
  );

  await importDocument({ version: 99, sets: [] }, "future.json");
  await waitForStatus(
    "options-status",
    'Failed to import tab sets: Failed to import tab set "import payload": Unsupported tab-set document version "99". Supported versions are 1 and 2',
  );
  assert.equal(
    await driver.findElement(By.id("options-status")).getAttribute("data-kind"),
    "error",
  );
});

test("keyboard focus follows the options control order", async () => {
  await openExtensionPage("options/options.html");
  await driver.actions().sendKeys(Key.TAB).perform();
  assert.equal(await driver.switchTo().activeElement().getAttribute("id"), "export-button");
  await driver.actions().sendKeys(Key.TAB).perform();
  assert.equal(await driver.switchTo().activeElement().getAttribute("id"), "import-input");
  await driver.actions().sendKeys(Key.TAB).perform();
  assert.equal(await driver.switchTo().activeElement().getAttribute("id"), "import-button");
});

test("an imported every-window set autoloads in existing and new windows", async () => {
  await openExtensionPage("popup/popup.html");
  await driver.executeAsyncScript((url, done) => {
    browser.windows.create({ url }).then(() => done());
  }, `${extensionOrigin}/options/options.html?existing-window`);
  await openExtensionPage("options/options.html");
  const autoloadUrl = `${extensionOrigin}/options/options.html?every-window`;
  const everyWindowSetId = "00000000-0000-4000-8000-000000000002";
  await importDocument({
    version: 2,
    sets: [{ id: everyWindowSetId, name: "Every window", tabs: [autoloadUrl] }],
    autoload: { scope: "every-window", setIds: [everyWindowSetId] },
  }, "every-window.json");
  await waitForStatus("options-status", "Successfully imported 1 tab set.");
  await runStartupHandler();
  const existingWindowIds = await driver.executeAsyncScript((done) => {
    browser.windows.getAll({ windowTypes: ["normal"] }).then(
      (windows) => done(windows.map((window) => window.id)),
    );
  });
  assert.ok(existingWindowIds.length >= 2, "Firefox restored both existing windows");

  await driver.wait(async () => {
    const tabsByWindow = await Promise.all(existingWindowIds.map(pinnedUrls));
    return tabsByWindow.every((urls) => urls.includes(autoloadUrl));
  }, 30_000, "existing windows to receive imported every-window set");

  const newWindowId = await driver.executeAsyncScript((url, done) => {
    browser.windows.create({ url }).then((window) => done(window.id));
  }, `${extensionOrigin}/options/options.html?new-window`);
  await driver.wait(
    async () => (await pinnedUrls(newWindowId)).includes(autoloadUrl),
    30_000,
    "new window to receive imported every-window set",
  );
  for (const windowId of [...existingWindowIds, newWindowId]) {
    assert.deepEqual(await pinnedUrls(windowId), [autoloadUrl]);
  }
});

test("startup keeps an already restored pinned tab open", async () => {
  await openExtensionPage("popup/popup.html");
  const url = `${extensionOrigin}/options/options.html?already-restored`;
  await createTabs([url]);
  await saveSet("Already restored");
  await selectAutoloadSet("Already restored");
  await restartFirefox();
  await openExtensionPage("popup/popup.html");
  await driver.wait(async () => (await pinnedUrls()).filter((tabUrl) => tabUrl === url).length === 1, 30_000);
});

test("startup preserves unrelated local extension state", async () => {
  await openStorageFixturePage();
  await driver.executeAsyncScript((done) => {
    browser.storage.local.set({ unrelated: "keep" }).then(() => done());
  });
  await restartFirefox();
  await openExtensionPage("options/options.html");
  assert.equal(await driver.executeAsyncScript((done) => {
    browser.storage.local.get("unrelated").then(({ unrelated }) => done(unrelated));
  }), "keep");
});

test("the startup handler restores the configured pinned tabs", async () => {
  await openExtensionPage("popup/popup.html");
  const url = `${extensionOrigin}/options/options.html?startup-handler`;
  await createTabs([url]);
  await saveSet("Startup handler");
  await selectAutoloadSet("Startup handler");
  await removePinnedTabs();
  await restartFirefox();
  await openExtensionPage("options/options.html");
  await driver.wait(async () => (await pinnedUrls()).includes(url), 30_000);
});

test("an autoload selection persists across browser restart", async () => {
  await openExtensionPage("popup/popup.html");
  const url = `${extensionOrigin}/options/options.html?restart`;
  await createTabs([url]);
  await saveSet("Startup");
  await selectAutoloadSet("Startup");
  await removePinnedTabs();
  await restartFirefox();
  await openExtensionPage("popup/popup.html");
  await driver.wait(async () => (await pinnedUrls()).includes(url), 30_000);
  assert.equal(
    await driver.findElement(By.css('.load-row[data-name="Startup"] input[name=autoload]'))
      .isSelected(),
    true,
  );
});

test("restart does not restore a saved set without an autoload selection", async () => {
  await openExtensionPage("popup/popup.html");
  const url = `${extensionOrigin}/options/options.html?no-autoload`;
  await createTabs([url]);
  await saveSet("No autoload");
  await removePinnedTabs();

  await restartFirefox();
  await openExtensionPage("popup/popup.html");

  assert.equal((await pinnedUrls()).includes(url), false);
});

test("first-window autoload does not restore into a later window", async () => {
  await openExtensionPage("popup/popup.html");
  const autoloadUrl = `${extensionOrigin}/options/options.html?first-window`;
  const secondWindowUrl = `${extensionOrigin}/options/options.html?second-window`;
  await createTabs([autoloadUrl]);
  await saveSet("First window");
  await selectAutoloadSet("First window");
  await removePinnedTabs();
  await restartFirefox();
  await openExtensionPage("popup/popup.html");
  const firstWindowId = await driver.executeAsyncScript((done) => {
    browser.windows.getCurrent().then((window) => done(window.id));
  });
  await driver.wait(async () => (await pinnedUrls(firstWindowId)).includes(autoloadUrl), 30_000);
  const secondWindowId = await driver.executeAsyncScript((url, done) => {
    browser.windows.create({ url }).then((window) => done(window.id));
  }, secondWindowUrl);

  await driver.wait(async () => (await pinnedUrls(secondWindowId)).length === 0, 30_000);
});

test("repeated restarts do not duplicate autoloaded pinned tabs", async () => {
  await openExtensionPage("popup/popup.html");
  const url = `${extensionOrigin}/options/options.html?repeat`;
  await createTabs([url]);
  await saveSet("Repeat");
  await selectAutoloadSet("Repeat");

  for (let restart = 0; restart < 2; restart += 1) {
    await restartFirefox();
    await openExtensionPage("popup/popup.html");
    await driver.wait(
      async () => (await pinnedUrls()).filter((tabUrl) => tabUrl === url).length === 1,
      30_000,
    );
  }
});

test("cleared autoload selection is not restored after restart", async () => {
  await openExtensionPage("popup/popup.html");
  const url = `${extensionOrigin}/options/options.html?clear`;
  await createTabs([url]);
  await saveSet("Clear");
  await selectAutoloadSet("Clear");
  await clearAutoloadSet("Clear");
  await removePinnedTabs();

  await restartFirefox();
  await openExtensionPage("popup/popup.html");

  assert.equal((await pinnedUrls()).includes(url), false);
});

test("deleted autoload set is not restored after restart", async () => {
  await openExtensionPage("popup/popup.html");
  const url = `${extensionOrigin}/options/options.html?deleted`;
  await createTabs([url]);
  await saveSet("Deleted");
  await selectAutoloadSet("Deleted");
  await deleteSet("Deleted");
  await removePinnedTabs();

  await restartFirefox();
  await openExtensionPage("popup/popup.html");

  assert.equal((await pinnedUrls()).includes(url), false);
});

test("popup, set loading, and window creation recover after browser restart", async () => {
  await openExtensionPage("popup/popup.html");
  const savedUrl = `${extensionOrigin}/options/options.html?restart-recovery`;
  await createTabs([savedUrl]);
  await saveSet("Restart recovery");
  await removePinnedTabs();

  await restartFirefox();
  await openExtensionPage("popup/popup.html");
  await driver.findElement(
    By.css('.load-row[data-name="Restart recovery"] .set-load'),
  ).click();
  await waitForStatus("popup-status", "Tab set loaded.");
  await waitForPinnedUrls([savedUrl]);

  const windowId = await driver.executeAsyncScript((url, done) => {
    browser.windows.create({ url }).then((window) => done(window.id));
  }, `${extensionOrigin}/options/options.html?restart-window`);
  assert.equal(typeof windowId, "number");
});

test("environment: Firefox enforces quotas without losing the readable generation", async () => {
  await openExtensionPage("popup/popup.html");
  const retainedUrl = `${extensionOrigin}/options/options.html?retained-after-quota`;
  await createTabs([retainedUrl]);
  await saveSet("Before quota");
  await openStorageFixturePage();

  const result = await driver.executeAsyncScript(async (done) => {
    const keys = [];
    const before = await browser.storage.sync.get(null);
    const previousIndex = before["savePinnedTabs:index"];
    try {
      let perItemError = "";
      try {
        await browser.storage.sync.set({ "quota:item": "界".repeat(3_000) });
      } catch (error) {
        perItemError = String(error);
      }

      let totalError = "";
      for (let index = 0; index < 24; index += 1) {
        const key = `quota:total:${index}`;
        try {
          await browser.storage.sync.set({ [key]: "x".repeat(6_000) });
          keys.push(key);
        } catch (error) {
          totalError = String(error);
          break;
        }
      }
      const retained = await browser.storage.sync.get(null);
      const activeIndex = retained["savePinnedTabs:index"];
      const activeDocument = JSON.parse(
        activeIndex.chunks.map((key) => retained[key]).join(""),
      );
      const generationUnchanged = activeIndex.generation === previousIndex.generation;
      const readableSetNames = Object.values(activeDocument.sets).map((set) => set.name);
      await browser.storage.sync.remove(["quota:item", ...keys]);
      done({
        perItemError,
        totalError,
        retainedCount: keys.filter((key) => key in retained).length,
        writtenCount: keys.length,
        generationUnchanged,
        readableSetNames,
      });
    } catch (error) {
      await browser.storage.sync.remove(["quota:item", ...keys]);
      done({ error: String(error) });
    }
  });

  assert.equal(result.error, undefined);
  assert.match(result.perItemError, /quota|8,?192|too large/i);
  assert.match(result.totalError, /quota|102,?400|too large/i);
  assert.equal(result.retainedCount, result.writtenCount);
  assert.equal(result.generationUnchanged, true);
  assert.deepEqual(result.readableSetNames, ["Before quota"]);

  await restartFirefox();
  await openExtensionPage("popup/popup.html");
  const retainedRow = await driver.wait(
    until.elementLocated(By.css('.load-row[data-name="Before quota"]')),
    10_000,
  );
  await retainedRow.findElement(By.css(".set-load")).click();
  await waitForPinnedUrls([retainedUrl]);
});

test("environment: quota-bound migration remains usable and promotes after deletion", async () => {
  const expectedSets = Array.from({ length: 16 }, (_, index) => {
    const name = `Quota recovery ${String(index).padStart(2, "0")}`;
    return {
      key: Buffer.from(name).toString("base64"),
      name,
      tabs: [`https://example.com/${index}/${"x".repeat(6_100)}`],
    };
  });
  await openStorageFixturePage();
  const seededBytes = await driver.executeAsyncScript(async (sets, done) => {
    try {
      const sync = await browser.storage.sync.get(null);
      const index = sync["savePinnedTabs:index"];
      const entries = Object.fromEntries(sets.map((set) => [
        set.key,
        { autoload: 0, set_name: set.name, tabs: set.tabs },
      ]));
      await browser.storage.sync.set(entries);
      await browser.storage.sync.remove([
        "savePinnedTabs:index",
        ...(index?.chunks ?? []),
      ]);
      await browser.storage.local.remove([
        "savePinnedTabs:local",
        "savePinnedTabs:migration-staging",
      ]);
      done(Object.entries(entries).reduce(
        (total, [key, value]) =>
          total + new TextEncoder().encode(key + JSON.stringify(value)).byteLength,
        0,
      ));
    } catch (error) {
      done({ error: error.message });
    }
  }, expectedSets);
  assert.equal(seededBytes.error, undefined);
  assert.ok(seededBytes < 102_400);

  await restartFirefox();
  await openExtensionPage("popup/popup.html");
  const firstLaunchRows = await driver.findElements(By.css(".load-row"));
  assert.equal(
    firstLaunchRows.length,
    expectedSets.length,
    await driver.findElement(By.id("popup-status")).getText(),
  );
  assert.match(
    await driver.findElement(By.id("popup-status")).getText(),
    /Tab sets are available locally/,
  );
  const stagedIds = await driver.executeAsyncScript((done) => {
    browser.storage.local.get("savePinnedTabs:migration-staging").then((local) => {
      done(Object.keys(local["savePinnedTabs:migration-staging"].sets));
    });
  });

  await restartFirefox();
  await openExtensionPage("popup/popup.html");
  assert.equal(
    (await driver.findElements(By.css(".load-row"))).length,
    expectedSets.length,
  );
  assert.deepEqual(
    await driver.executeAsyncScript((done) => {
      browser.storage.local.get("savePinnedTabs:migration-staging").then((local) => {
        done(Object.keys(local["savePinnedTabs:migration-staging"].sets));
      });
    }),
    stagedIds,
  );

  const firstRow = await driver.findElement(
    By.css(`.load-row[data-name="${expectedSets[0].name}"]`),
  );
  await firstRow.findElement(By.css(".set-delete")).click();
  await driver.findElement(By.css("#delete-dialog button[value=delete]")).click();
  await driver.wait(until.stalenessOf(firstRow), 10_000);
  await driver.wait(async () => !(
    await driver.findElement(By.id("popup-status")).getText()
  ).includes("available locally"), 10_000);

  const promoted = await driver.executeAsyncScript(async (done) => {
    const [sync, local] = await Promise.all([
      browser.storage.sync.get(null),
      browser.storage.local.get("savePinnedTabs:migration-staging"),
    ]);
    const index = sync["savePinnedTabs:index"];
    const document = JSON.parse(index.chunks.map((key) => sync[key]).join(""));
    done({
      setCount: Object.keys(document.sets).length,
      stagingPresent: "savePinnedTabs:migration-staging" in local,
    });
  });
  assert.deepEqual(promoted, {
    setCount: expectedSets.length - 1,
    stagingPresent: false,
  });
});

test("environment: oversized UTF-8 legacy collection recovers into bounded chunks", async () => {
  const legacySets = Array.from({ length: 4 }, (_, index) => {
    const name = `Legacy ${index} 日本語`;
    return {
      key: Buffer.from(name).toString("base64"),
      name,
      tabs: Array.from(
        { length: 30 },
        (_, tabIndex) => `https://例え.example/${index}/${tabIndex}/${"路".repeat(12)}`,
      ),
    };
  });
  const versionTwoSet = {
    id: "00000000-0000-4000-8000-000000000101",
    name: "Version two",
    tabs: [`${extensionOrigin}/options/options.html?version-two`],
  };
  await openStorageFixturePage();
  const seededBytes = await driver.executeAsyncScript(async (sets, currentSet, done) => {
    const sync = await browser.storage.sync.get(null);
    const index = sync["savePinnedTabs:index"];
    const entries = Object.fromEntries(sets.map((set) => [
      set.key,
      { autoload: 0, set_name: set.name, tabs: set.tabs },
    ]));
    entries["savePinnedTabs:sync"] = {
      version: 2,
      sets: { [currentSet.id]: currentSet },
      autoload: { scope: "first-window", setIds: [] },
      deletedSetIds: [],
    };
    await browser.storage.sync.set(entries);
    await browser.storage.sync.remove(["savePinnedTabs:index", ...(index?.chunks ?? [])]);
    done(new TextEncoder().encode(JSON.stringify(entries)).byteLength);
  }, legacySets, versionTwoSet);
  assert.ok(seededBytes > 8_192);

  await restartFirefox();
  await openExtensionPage("popup/popup.html");
  for (const set of legacySets) {
    const row = await driver.wait(
      until.elementLocated(By.css(`.load-row[data-name="${set.name}"]`)),
      10_000,
    );
    await row.findElement(By.css(".set-load")).click();
    await waitForStatus("popup-status", "Tab set loaded.");
    await waitForPinnedUrls(set.tabs.map((url) => new URL(url).href));
  }
  const versionTwoRow = await driver.wait(
    until.elementLocated(By.css('.load-row[data-name="Version two"]')),
    10_000,
  );
  await versionTwoRow.findElement(By.css(".set-load")).click();
  await waitForPinnedUrls(versionTwoSet.tabs);

  const storageShape = await driver.executeAsyncScript((sets, done) => {
    browser.storage.sync.get(null).then((sync) => {
      const index = sync["savePinnedTabs:index"];
      done({
        chunkCount: index.chunks.length,
        chunkBytes: index.chunks.map((key) => new TextEncoder()
          .encode(JSON.stringify(sync[key])).byteLength),
        migrationSourcesRemoved: !("savePinnedTabs:sync" in sync)
          && sets.every((set) => !(set.key in sync)),
      });
    });
  }, legacySets);
  assert.ok(storageShape.chunkCount > 1);
  assert.ok(storageShape.chunkBytes.every((bytes) => bytes <= 6 * 1_024));
  assert.equal(storageShape.migrationSourcesRemoved, true);
});
