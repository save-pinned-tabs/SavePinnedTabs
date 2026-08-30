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

async function saveSet(page, name) {
  await page.getByPlaceholder("Enter a name for set...").fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".load-row", { hasText: name })).toBeVisible();
}

async function deleteSet(page, name) {
  const row = page.locator(".load-row", { hasText: name });
  await row.getByRole("button", { name: "Del" }).click();
  await page.locator(".swal-button--confirm").click();
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
  const tabFixture = `chrome-extension://${extensionId}/tests/e2e/tab.html`;
  const firstUrl = `${tabFixture}?first`;
  const secondUrl = `${tabFixture}?second`;
  const unwantedUrl = `${tabFixture}?unwanted`;

  await createPinnedTabs(popup, [firstUrl]);
  await saveSet(popup, "Work");

  await createPinnedTabs(popup, [secondUrl]);
  await popup
    .locator(".load-row", { hasText: "Work" })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(popup.locator(".load-row", { hasText: "Work" })).toBeVisible();

  await createPinnedTabs(popup, [unwantedUrl]);
  await popup
    .locator(".load-row", { hasText: "Work" })
    .getByRole("button", { name: "Load" })
    .click();

  await expectOpenTabs(context, [firstUrl, secondUrl], [unwantedUrl]);
  await deleteSet(popup, "Work");
});

test("a user can export and import tab sets", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup.html");

  await createPinnedTabs(popup, [
    `chrome-extension://${extensionId}/tests/e2e/tab.html?exported`,
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
  await expect(options.locator(".swal-text")).toHaveText(
    "Successfully Imported 1 Tab Sets",
  );

  await popup.reload();
  await expect(popup.locator(".load-row", { hasText: "Backup" })).toBeVisible();
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

  await expect(options.locator(".swal-text")).toHaveText(
    "Failed to import tab sets. Please try again.",
  );

  const popup = await openExtensionPage(context, extensionId, "popup.html");
  await expect(popup.locator(".load-row", { hasText: "Invalid" })).toHaveCount(0);
});

test("autoload logic restores the configured pinned tabs", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const autoloadUrl = `chrome-extension://${extensionId}/tests/e2e/tab.html?manual-autoload`;

  await createPinnedTabs(popup, [autoloadUrl]);
  await saveSet(popup, "Manual startup");
  await popup
    .locator(".load-row", { hasText: "Manual startup" })
    .locator("input[name=autoload]")
    .check();
  await expect(popup.locator(".load-row", { hasText: "Manual startup" })).toBeVisible();
  await removePinnedTabs(popup);

  await popup.evaluate(async () => {
    const { Autoload } = await import(chrome.runtime.getURL("functions.js"));
    await Autoload.manual();
  });

  await expectOpenTabs(context, [autoloadUrl]);
});

test("the startup handler restores the configured pinned tabs", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const autoloadUrl = `chrome-extension://${extensionId}/tests/e2e/tab.html?startup-handler`;

  await createPinnedTabs(popup, [autoloadUrl]);
  await saveSet(popup, "Startup handler");
  await popup
    .locator(".load-row", { hasText: "Startup handler" })
    .locator("input[name=autoload]")
    .check();
  await expect(popup.locator(".load-row", { hasText: "Startup handler" })).toBeVisible();
  await removePinnedTabs(popup);

  await popup.evaluate(async () => {
    const { handleStartup } = await import(chrome.runtime.getURL("service_worker.js"));
    await handleStartup();
  });

  await expectOpenTabs(context, [autoloadUrl]);
});

test("an autoload selection persists across browser restart", async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-restart-"));
  let firstLaunch;
  let secondLaunch;

  try {
    firstLaunch = await launchExtension(userDataDir);
    const popup = await openExtensionPage(
      firstLaunch.context,
      firstLaunch.extensionId,
      "popup.html",
    );
    const autoloadUrl = `chrome-extension://${firstLaunch.extensionId}/tests/e2e/tab.html?autoloaded`;

    await createPinnedTabs(popup, [autoloadUrl]);
    await saveSet(popup, "Startup");
    await popup
      .locator(".load-row", { hasText: "Startup" })
      .locator("input[name=autoload]")
      .check();
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
  } finally {
    await firstLaunch?.context.close();
    await secondLaunch?.context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
