import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
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

function isPageUnloading(error) {
  return /Document was unloaded|browser is not defined|can't access dead object/.test(error.message);
}

async function launchFirefox({ installAddon = false } = {}) {
  const options = new firefox.Options()
    .addArguments("-headless", "-profile", profileDirectory)
    .setPreference("xpinstall.signatures.required", false);
  if (firefoxBinary) options.setBinary(firefoxBinary);
  const service = new firefox.ServiceBuilder().addArguments("--allow-system-access");
  const nextDriver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();
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
}

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-firefox-"));
  addonPath = path.join(temporaryDirectory, "save-pinned-tabs.xpi");
  profileDirectory = path.join(temporaryDirectory, "profile");
  await mkdir(profileDirectory);
  await copyFile(buildPath, addonPath);

  ({ driver, extensionOrigin } = await launchFirefox({ installAddon: true }));
});

after(async () => {
  await driver?.quit();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("Firefox runs the background fallback and saves and loads pinned tabs", async () => {
  await driver.get(`${extensionOrigin}/popup.html`);
  await driver.wait(
    () => driver.executeScript('return document.activeElement?.id === "save-name";'),
    5_000,
  );


  const hasBackgroundPage = await driver.executeAsyncScript((done) => {
    browser.runtime.getBackgroundPage().then(
      (page) => done(Boolean(page)),
      () => done(false),
    );
  });
  assert.equal(hasBackgroundPage, true, "Firefox did not start the background script fallback");
  await driver.executeAsyncScript((done) => {
    browser.windows.getCurrent().then(() => setTimeout(done, 100));
  });


  const savedUrl = `${extensionOrigin}/options.html?firefox-saved`;
  await driver.executeAsyncScript((url, done) => {
    browser.tabs.create({ url, pinned: true, active: false }).then(() => done());
  }, savedUrl);

  await driver.findElement(By.id("save-name")).sendKeys("Firefox");
  const savePageLoadTime = await driver.executeScript("return performance.timeOrigin");
  await driver.findElement(By.id("save-button")).click();
  await driver.wait(async () => {
    try {
      return await driver.executeScript(
        "return performance.timeOrigin !== arguments[0]",
        savePageLoadTime,
      );
    } catch (error) {
      if (isPageUnloading(error)) return false;
      throw error;
    }
  }, 10_000);
  await driver.wait(until.elementLocated(By.css('.load-row[data-name="Firefox"]')), 10_000);

  const unwantedUrl = `${extensionOrigin}/options.html?firefox-unwanted`;
  await driver.executeAsyncScript((url, done) => {
    browser.tabs.create({ url, pinned: true, active: false }).then(() => done());
  }, unwantedUrl);

  const pageLoadTime = await driver.executeScript("return performance.timeOrigin");
  await driver.executeScript(
    "arguments[0].click()",
    await driver.findElement(By.css('.load-row[data-name="Firefox"] .set-load')),
  );
  await driver.wait(async () => {
    try {
      return await driver.executeScript(
        "return performance.timeOrigin !== arguments[0]",
        pageLoadTime,
      );
    } catch (error) {
      if (isPageUnloading(error)) return false;
      throw error;
    }
  }, 10_000);
  await driver.wait(async () => {
    try {
      return await driver.executeAsyncScript((expected, unwanted, done) => {
        browser.tabs.query({ pinned: true, currentWindow: true }).then((tabs) => {
          const urls = tabs.map((tab) => tab.url);
          done(urls.includes(expected) && !urls.includes(unwanted));
        });
      }, savedUrl, unwantedUrl);
    } catch (error) {
      if (/Document was unloaded|browser is not defined|can't access dead object/.test(error.message)) {
        return false;
      }
      throw error;
    }
  }, 10_000);
});

test("Firefox restores Autoload after a browser restart", async () => {
  const autoloadUrl = `${extensionOrigin}/options.html?firefox-restart`;
  await driver.get(`${extensionOrigin}/options.html`);
  const setupError = await driver.executeAsyncScript((url, done) => {
    browser.storage.sync.set({
      firefoxRestart: {
        autoload: 1,
        set_name: "Firefox restart",
        tabs: [url],
      },
    })
      .then(() => browser.tabs.query({ pinned: true, currentWindow: true }))
      .then((tabs) => browser.tabs.remove(tabs.map((tab) => tab.id)))
      .then(() => done(null), (error) => done(error.message));
  }, autoloadUrl);
  assert.equal(setupError, null);

  await driver.quit();
  driver = undefined;
  ({ driver, extensionOrigin } = await launchFirefox());
  await driver.get(`${extensionOrigin}/options.html`);

  await driver.wait(async () => driver.executeAsyncScript((url, done) => {
    browser.tabs.query({ pinned: true, currentWindow: true }).then(
      (tabs) => done(tabs.some((tab) => tab.url === url)),
      () => done(false),
    );
  }, autoloadUrl), 10_000);
});
