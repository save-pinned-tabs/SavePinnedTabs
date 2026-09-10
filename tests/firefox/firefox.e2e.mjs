import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Builder, By, until } from "selenium-webdriver";
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

async function waitForStatus(id, text) {
  const element = await driver.findElement(By.id(id));
  await driver.wait(until.elementTextIs(element, text), 10_000, `status "${text}"`);
}

async function pinnedUrls() {
  return driver.executeAsyncScript((done) => {
    browser.tabs.query({ pinned: true, currentWindow: true }).then(
      (tabs) => done(tabs.map((tab) => tab.url)),
      (error) => done({ error: error.message }),
    );
  });
}

async function createPinnedTab(url) {
  await driver.executeAsyncScript((tabUrl, done) => {
    browser.tabs.create({ url: tabUrl, pinned: true, active: false }).then(() => done());
  }, url);
}

async function removePinnedTabs() {
  await driver.executeAsyncScript((done) => {
    browser.tabs.query({ pinned: true, currentWindow: true })
      .then((tabs) => browser.tabs.remove(tabs.map((tab) => tab.id)))
      .then(() => done());
  });
}

async function waitForPopupReady() {
  await driver.wait(
    () => driver.executeScript('return document.getElementById("save-button")?.disabled === false;'),
    30_000,
    "popup controls to become ready",
  );
}

test("Firefox popup supports CRUD, Append, and Unload without navigation", async () => {
  await driver.get(`${extensionOrigin}/popup.html`);
  await waitForPopupReady();
  const hasBackgroundPage = await driver.executeAsyncScript((done) => {
    browser.runtime.getBackgroundPage().then(
      (page) => done(Boolean(page)),
      () => done(false),
    );
  });
  assert.equal(hasBackgroundPage, true, "Firefox did not start the background script fallback");

  const firstUrl = `${extensionOrigin}/options.html?firefox-first`;
  const secondUrl = `${extensionOrigin}/options.html?firefox-second`;
  const unrelatedUrl = `${extensionOrigin}/options.html?firefox-unrelated`;
  await createPinnedTab(firstUrl);
  await driver.findElement(By.id("save-name")).sendKeys("Firefox");
  const pageLoadTime = await driver.executeScript("return performance.timeOrigin");
  await driver.findElement(By.id("save-button")).click();
  await waitForStatus("popup-status", "Tab set saved.");

  await createPinnedTab(secondUrl);
  await driver.findElement(By.css('.load-row[data-name="Firefox"] .set-save')).click();
  await waitForStatus("popup-status", "Tab set saved.");

  await removePinnedTabs();
  await createPinnedTab(unrelatedUrl);
  await driver.findElement(By.css('.load-row[data-name="Firefox"] .set-append')).click();
  await waitForStatus("popup-status", "Tab set appended.");
  assert.deepEqual(await pinnedUrls(), [unrelatedUrl, firstUrl, secondUrl]);

  await driver.findElement(By.css('.load-row[data-name="Firefox"] .set-unload')).click();
  await waitForStatus("popup-status", "Tab set unloaded.");
  assert.deepEqual(await pinnedUrls(), [unrelatedUrl]);

  await driver.findElement(By.css('.load-row[data-name="Firefox"] .set-load')).click();
  await waitForStatus("popup-status", "Tab set loaded.");
  assert.deepEqual(await pinnedUrls(), [firstUrl, secondUrl]);
  assert.equal(
    await driver.executeScript("return performance.timeOrigin"),
    pageLoadTime,
    "popup mutation unexpectedly reloaded the page",
  );

  await driver.findElement(By.css('.load-row[data-name="Firefox"] .set-delete')).click();
  await driver.findElement(By.css("#delete-dialog button[value=cancel]")).click();
  await waitForStatus("popup-status", "Deletion canceled.");
  const deletedRow = await driver.findElement(By.css('.load-row[data-name="Firefox"]'));
  await deletedRow.findElement(By.css(".set-delete")).click();
  await driver.findElement(By.css("#delete-dialog button[value=delete]")).click();
  await waitForStatus("popup-status", "Tab set deleted.");
  await driver.wait(until.stalenessOf(deletedRow), 10_000);
});

test("Firefox options imports, exports, and persists shortcut assignments", async () => {
  const importPath = path.join(temporaryDirectory, "firefox-import.json");
  await writeFile(importPath, JSON.stringify({
    imported: {
      autoload: 0,
      set_name: "Imported Firefox",
      tabs: [`${extensionOrigin}/options.html?firefox-imported`],
    },
  }));
  await driver.get(`${extensionOrigin}/options.html`);
  await driver.wait(
    () => driver.executeScript('return document.body.getAttribute("aria-busy") === "false";'),
    10_000,
  );
  await driver.findElement(By.id("import-input")).sendKeys(importPath);
  await driver.findElement(By.id("import-button")).click();
  await waitForStatus("options-status", "Successfully imported 1 tab set.");

  const shortcut = await driver.findElement(
    By.css('[data-shortcut-command="load-set-1"]'),
  );
  await shortcut.findElement(By.xpath('./option[normalize-space(.)="Imported Firefox"]')).click();
  await waitForStatus("options-status", "Shortcut assignment saved.");
  const assignedValue = await shortcut.getAttribute("value");
  await driver.navigate().refresh();
  await driver.wait(
    () => driver.executeScript('return document.body.getAttribute("aria-busy") === "false";'),
    10_000,
  );
  assert.equal(
    await driver.findElement(By.css('[data-shortcut-command="load-set-1"]'))
      .getAttribute("value"),
    assignedValue,
  );

  await driver.findElement(By.id("export-button")).click();
  await waitForStatus("options-status", "Tab sets exported.");
  await driver.wait(async () => (
    await readdir(temporaryDirectory)
  ).some((name) => /^SavePinnedTabs_export_.*\.json$/.test(name)), 10_000);
});

test("Firefox restores multiple Autoload sets after a real browser restart", async () => {
  const firstUrl = `${extensionOrigin}/options.html?firefox-restart-first`;
  const secondUrl = `${extensionOrigin}/options.html?firefox-restart-second`;
  await driver.get(`${extensionOrigin}/popup.html`);
  await waitForPopupReady();

  await createPinnedTab(firstUrl);
  await driver.findElement(By.id("save-name")).sendKeys("Restart first");
  await driver.findElement(By.id("save-button")).click();
  await waitForStatus("popup-status", "Tab set saved.");
  await removePinnedTabs();

  await createPinnedTab(secondUrl);
  await driver.findElement(By.id("save-name")).sendKeys("Restart second");
  await driver.findElement(By.id("save-button")).click();
  await waitForStatus("popup-status", "Tab set saved.");
  await driver.findElement(
    By.css('.load-row[data-name="Restart first"] input[name=autoload]'),
  ).click();
  await waitForStatus("popup-status", "Autoload selection updated.");
  await driver.findElement(
    By.css('.load-row[data-name="Restart second"] input[name=autoload]'),
  ).click();
  await waitForStatus("popup-status", "Autoload selection updated.");
  await removePinnedTabs();

  await driver.quit();
  driver = undefined;
  ({ driver, extensionOrigin } = await launchFirefox());
  await driver.get(`${extensionOrigin}/options.html`);
  await driver.wait(async () => {
    const urls = await pinnedUrls();
    return urls.includes(firstUrl) && urls.includes(secondUrl);
  }, 10_000);
});
