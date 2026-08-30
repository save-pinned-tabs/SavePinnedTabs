const { test: base, chromium } = require("@playwright/test");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const extensionPath = path.resolve(__dirname, "../..");

async function launchExtension(userDataDir) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker");
  }

  return {
    context,
    extensionId: new URL(serviceWorker.url()).host,
  };
}

async function openExtensionPage(context, extensionId, pageName) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${pageName}`);
  return page;
}

const test = base.extend({
  extension: async ({}, use) => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-"));
    const extension = await launchExtension(userDataDir);

    await use({ ...extension, userDataDir });

    await extension.context.close();
    await rm(userDataDir, { recursive: true, force: true });
  },
});

module.exports = {
  expect: test.expect,
  extensionPath,
  launchExtension,
  openExtensionPage,
  test,
};
