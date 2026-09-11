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
    if (installAddon) await nextDriver.installAddon(addonPath, false);
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

async function createPinnedTabs(urls) {
  const error = await driver.executeAsyncScript(async (tabUrls, done) => {
    try {
      for (const url of tabUrls) {
        await browser.tabs.create({ url, pinned: true, active: false });
      }
      done(null);
    } catch (cause) {
      done(cause.message);
    }
  }, urls);
  if (error) throw new Error(`Failed to create pinned tabs: ${error}`);
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


async function saveSet(name) {
  await driver.findElement(By.id("save-name")).sendKeys(name);
  await driver.findElement(By.id("save-button")).click();
  await waitForStatus("popup-status", "Tab set saved.");
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
  ({ driver, extensionOrigin } = await launchFirefox());
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
  await createPinnedTabs([`${extensionOrigin}/options/options.html?save`]);
  const pageLoadTime = await driver.executeScript("return performance.timeOrigin");
  await saveSet("Work");
  assert.equal(await driver.executeScript("return performance.timeOrigin"), pageLoadTime);
});

test("a user can update a pinned tab set without reloading", async () => {
  await openExtensionPage("popup/popup.html");
  await createPinnedTabs([`${extensionOrigin}/options/options.html?first`]);
  await saveSet("Work");
  const secondUrl = `${extensionOrigin}/options/options.html?second`;
  await createPinnedTabs([secondUrl]);
  const pageLoadTime = await driver.executeScript("return performance.timeOrigin");
  await driver.findElement(By.css('.load-row[data-name="Work"] .set-save')).click();
  await waitForStatus("popup-status", "Tab set saved.");
  assert.ok((await pinnedUrls()).includes(secondUrl));
  assert.equal(await driver.executeScript("return performance.timeOrigin"), pageLoadTime);
});

test("a user can load a pinned tab set without reloading", async () => {
  await openExtensionPage("popup/popup.html");
  const savedUrl = `${extensionOrigin}/options/options.html?saved`;
  await createPinnedTabs([savedUrl]);
  await saveSet("Work");
  await createPinnedTabs([`${extensionOrigin}/options/options.html?unwanted`]);
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
  await createPinnedTabs(savedUrls);
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
  await createPinnedTabs([originalUrl]);

  await driver.findElement(By.css('.load-row[data-name="Failing"] .set-load')).click();

  await driver.wait(async () => (
    (await driver.findElement(By.id("popup-status")).getText()).includes(failedUrl)
  ), 10_000, "actionable failed URL");
  assert.deepEqual(await pinnedUrls(), [originalUrl]);
});

test("a user can cancel deletion with Escape", async () => {
  await openExtensionPage("popup/popup.html");
  await createPinnedTabs([`${extensionOrigin}/options/options.html?cancel-delete`]);
  await saveSet("Work");
  await driver.findElement(By.css('.load-row[data-name="Work"] .set-delete')).click();
  const dialog = await driver.findElement(By.id("delete-dialog"));
  await driver.wait(until.elementIsVisible(dialog), 10_000);
  await driver.actions().sendKeys(Key.ESCAPE).perform();
  await driver.wait(until.elementIsNotVisible(dialog), 10_000);
  assert.ok(await driver.findElement(By.css('.load-row[data-name="Work"]')));
});

test("a user can delete a pinned tab set without reloading", async () => {
  await openExtensionPage("popup/popup.html");
  await createPinnedTabs([`${extensionOrigin}/options/options.html?delete`]);
  await saveSet("Work");
  const pageLoadTime = await driver.executeScript("return performance.timeOrigin");
  const row = await driver.findElement(By.css('.load-row[data-name="Work"]'));
  await row.findElement(By.css(".set-delete")).click();
  await driver.findElement(By.css("#delete-dialog button[value=delete]")).click();
  await waitForStatus("popup-status", "Tab set deleted.");
  await driver.wait(until.stalenessOf(row), 10_000);
  assert.equal(await driver.executeScript("return performance.timeOrigin"), pageLoadTime);
});


async function createShortcutFixture() {
  await openExtensionPage("popup/popup.html");
  const assignedUrl = `${extensionOrigin}/options/options.html?shortcut`;
  await createPinnedTabs([assignedUrl]);
  await saveSet("Shortcut target");
  await openExtensionPage("options/options.html");
  const shortcut = await driver.findElement(By.css('[data-shortcut-command="load-set-1"]'));
  await shortcut.findElement(By.xpath('./option[normalize-space(.)="Shortcut target"]')).click();
  await waitForStatus("options-status", "Shortcut assignment saved.");
  return { assignedUrl, shortcut };
}

test("a shortcut assignment persists", async () => {
  const { shortcut } = await createShortcutFixture();
  const assignedValue = await shortcut.getAttribute("value");
  await driver.navigate().refresh();
  await driver.wait(async () => (
    await driver.findElement(By.css('[data-shortcut-command="load-set-1"]'))
      .getAttribute("value")
  ) === assignedValue, 10_000, "persisted shortcut assignment");
});

test("an assigned command dispatches through the registered listener", async () => {
  const { assignedUrl } = await createShortcutFixture();
  await createPinnedTabs([`${extensionOrigin}/options/options.html?shortcut-unwanted`]);
  const result = await driver.executeAsyncScript((done) => {
    browser.runtime.getBackgroundPage()
      .then((page) => page.savePinnedTabsCommandListener("load-set-1"))
      .then((value) => done(value), (error) => done({ error: error.message }));
  });
  assert.deepEqual(result, { status: "success", value: { executed: true } });
  assert.deepEqual(await pinnedUrls(), [assignedUrl]);
});

test("an unassigned command is a no-op", async () => {
  await openExtensionPage("popup/popup.html");
  const before = await pinnedUrls();
  const result = await driver.executeAsyncScript((done) => {
    browser.runtime.getBackgroundPage()
      .then((page) => page.savePinnedTabsCommandListener("load-set-4"))
      .then((value) => done(value), (error) => done({ error: error.message }));
  });
  assert.deepEqual(result, { status: "success", value: { executed: false } });
  assert.deepEqual(await pinnedUrls(), before);
});


test("a pending failure blocks duplicate commands and recovers in place", async () => {
  await openExtensionPage("popup/popup.html");
  const existingUrl = `${extensionOrigin}/options/options.html?existing`;
  await createPinnedTabs([existingUrl]);
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
    Promise.all([
      browser.storage.sync.set({
        [setKey]: {
          autoload: 1,
          set_name: "Legacy Work",
          tabs: ["https://example.com/legacy"],
        },
      }),
      browser.storage.local.set({
        activeTabs: { 1: setKey },
        shortcutSets: { "load-set-1": setKey },
      }),
    ]).then(() => browser.storage.sync.get(null))
      .then((sync) => done("savePinnedTabs:sync" in sync));
  }, legacyKey);
  assert.equal(schemaExists, false);
  await restartFirefox();
  await openExtensionPage("popup/popup.html");
  await driver.wait(until.elementLocated(By.css('.load-row[data-name="Legacy Work"]')), 10_000);
  const migrated = await driver.executeAsyncScript((setKey, done) => {
    Promise.all([browser.storage.sync.get(null), browser.storage.local.get(null)])
      .then(([sync, local]) => {
        const setId = Object.keys(sync["savePinnedTabs:sync"].sets)[0];
        done({
          legacyRemoved: !(setKey in sync),
          set: sync["savePinnedTabs:sync"].sets[setId],
          autoloadSetIds: sync["savePinnedTabs:sync"].autoload.setIds,
          shortcutSetId: local["savePinnedTabs:local"].shortcutAssignments["load-set-1"],
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
  assert.equal(migrated.shortcutSetId, migrated.set.id);
  await driver.executeAsyncScript((setKey, done) => {
    browser.storage.sync.set({
      [setKey]: { autoload: 0, set_name: "Late Legacy", tabs: ["https://example.com/late"] },
    }).then(() => done());
  }, lateLegacyKey);
  await restartFirefox();
  await openExtensionPage("popup/popup.html");
  assert.equal((await driver.findElements(By.css('.load-row[data-name="Late Legacy"]'))).length, 0);
});

test("saved-set titles can exceed 30 characters and wrap", async () => {
  await openExtensionPage("popup/popup.html");
  const longName = "A very long saved tab set title that remains readable instead of being truncated";
  await createPinnedTabs([`${extensionOrigin}/options/options.html?long-title`]);
  await saveSet(longName);
  const title = await driver.findElement(By.css(`.load-row[data-name="${longName}"] span`));
  assert.equal(await title.getText(), longName);
  assert.equal(await driver.executeScript((element) => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    return element.scrollHeight > lineHeight * 1.5;
  }, title), true);
});

test("a user can export and import tab sets", async () => {
  await openExtensionPage("popup/popup.html");
  await createPinnedTabs([`${extensionOrigin}/options/options.html?exported`]);
  await saveSet("Backup");
  await openExtensionPage("options/options.html");
  await driver.findElement(By.id("export-button")).click();
  await waitForStatus("options-status", "Tab sets exported.");
  let exportName;
  await driver.wait(async () => {
    exportName = (await readdir(temporaryDirectory))
      .find((name) => /^SavePinnedTabs_export_.*\.json$/.test(name));
    return Boolean(exportName);
  }, 10_000);
  await openExtensionPage("popup/popup.html");
  const row = await driver.findElement(By.css('.load-row[data-name="Backup"]'));
  await row.findElement(By.css(".set-delete")).click();
  await driver.findElement(By.css("#delete-dialog button[value=delete]")).click();
  await waitForStatus("popup-status", "Tab set deleted.");
  await openExtensionPage("options/options.html");
  await driver.findElement(By.id("import-input"))
    .sendKeys(path.join(temporaryDirectory, exportName));
  await driver.findElement(By.id("import-button")).click();
  await waitForStatus("options-status", "Successfully imported 1 tab set.");
  await openExtensionPage("popup/popup.html");
  assert.ok(await driver.findElement(By.css('.load-row[data-name="Backup"]')));
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
  await createPinnedTabs([url]);
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
  await createPinnedTabs([url]);
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
  await createPinnedTabs([url]);
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
  await createPinnedTabs([url]);
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
  await createPinnedTabs([autoloadUrl]);
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
  await createPinnedTabs([url]);
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
  await createPinnedTabs([url]);
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
  await createPinnedTabs([url]);
  await saveSet("Deleted");
  await selectAutoloadSet("Deleted");
  await deleteSet("Deleted");
  await removePinnedTabs();

  await restartFirefox();
  await openExtensionPage("popup/popup.html");

  assert.equal((await pinnedUrls()).includes(url), false);
});
