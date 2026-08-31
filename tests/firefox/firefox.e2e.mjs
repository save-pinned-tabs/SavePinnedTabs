import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
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
let driver;
let temporaryDirectory;
let extensionOrigin;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-firefox-"));
  const addonPath = path.join(temporaryDirectory, "save-pinned-tabs.xpi");
  await copyFile(buildPath, addonPath);

  const options = new firefox.Options().addArguments("-headless");
  const service = new firefox.ServiceBuilder().addArguments("--allow-system-access");
  driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();
  await driver.installAddon(addonPath, true);

  await driver.setContext(firefox.Context.CHROME);
  const extensionUuids = await driver.executeScript(
    'return Services.prefs.getStringPref("extensions.webextensions.uuids");',
  );
  const extensionUuid = JSON.parse(extensionUuids)[extensionId];
  assert.ok(extensionUuid, `Firefox did not register ${extensionId}`);
  extensionOrigin = `moz-extension://${extensionUuid}`;
  await driver.setContext(firefox.Context.CONTENT);
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
  await driver.executeScript("arguments[0].click()", await driver.findElement(By.id("save-button")));
  await driver.wait(until.elementLocated(By.css('.load-row[data-name="Firefox"]')), 10_000);

  const unwantedUrl = `${extensionOrigin}/options.html?firefox-unwanted`;
  await driver.executeAsyncScript((url, done) => {
    browser.tabs.create({ url, pinned: true, active: false }).then(() => done());
  }, unwantedUrl);

  await driver.executeScript(
    "arguments[0].click()",
    await driver.findElement(By.css('.load-row[data-name="Firefox"] .set-load')),
  );
  await driver.wait(async () => {
    try {
      return await driver.executeAsyncScript((expected, unwanted, done) => {
        browser.tabs.query({ pinned: true, currentWindow: true }).then((tabs) => {
          const urls = tabs.map((tab) => tab.url);
          done(urls.includes(expected) && !urls.includes(unwanted));
        });
      }, savedUrl, unwantedUrl);
    } catch (error) {
      if (error.message.includes("Document was unloaded")) return false;
      throw error;
    }
  }, 10_000);
});
