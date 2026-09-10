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

async function saveSet(page, name) {
  await page.getByPlaceholder("Enter a name for set...").fill(name);
  await Promise.all([
    page.waitForNavigation(),
    page.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(page.locator(".load-row", { hasText: name })).toBeVisible();
}

async function selectAutoloadSet(page, name) {
  await Promise.all([
    page.waitForNavigation(),
    page
      .locator(".load-row", { hasText: name })
      .locator("input[name=autoload]")
      .check(),
  ]);
}

async function deleteSet(page, name) {
  const row = page.locator(".load-row", { hasText: name });
  await row.getByRole("button", { name: "Del" }).click();
  await expect(page.locator("#delete-dialog")).toBeVisible();
  await Promise.all([
    page.waitForNavigation(),
    page.getByRole("button", { name: "Delete", exact: true }).click(),
  ]);
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
  await popup
    .locator(".load-row", { hasText: "Work" })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(popup.locator(".load-row", { hasText: "Work" })).toBeVisible();

  await createPinnedTabs(popup, [unwantedUrl]);
  await popup
    .locator(".load-row", { hasText: "Work" })
    .getByRole("button", { name: "Load", exact: true })
    .click();

  await expectOpenTabs(context, [firstUrl, secondUrl], [unwantedUrl]);
  const workRow = popup.locator(".load-row", { hasText: "Work" });
  await workRow.getByRole("button", { name: "Del" }).click();
  await expect(popup.locator("#delete-dialog")).toBeVisible();
  await popup.keyboard.press("Escape");
  await expect(popup.locator("#delete-dialog")).toBeHidden();
  await expect(workRow).toBeVisible();
  await deleteSet(popup, "Work");
});

test("a user can unload every tab in a saved group", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const firstUrl = `chrome-extension://${extensionId}/options.html?unload-first`;
  const secondUrl = `chrome-extension://${extensionId}/options.html?unload-second`;
  const unrelatedUrl = `chrome-extension://${extensionId}/options.html?keep-open`;

  await createPinnedTabs(popup, [firstUrl, secondUrl]);
  await saveSet(popup, "Unload me");
  await createPinnedTabs(popup, [unrelatedUrl]);
  await Promise.all([
    popup.waitForNavigation(),
    popup
      .locator(".load-row", { hasText: "Unload me" })
      .getByRole("button", { name: "Unload" })
      .click(),
  ]);

  await expectOpenTabs(context, [unrelatedUrl], [firstUrl, secondUrl]);
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
    options.getByText("Successfully Imported 1 Tab Sets", { exact: true }),
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
    options.getByText("Successfully Imported 1 Tab Sets", { exact: true }),
  ).toBeVisible();

  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const row = popup.locator('.load-row[data-id="markup"]');
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
    options.getByText("Failed to import tab sets. Please try again.", { exact: true }),
  ).toBeVisible();

  const popup = await openExtensionPage(context, extensionId, "popup.html");
  await expect(popup.locator(".load-row", { hasText: "Invalid" })).toHaveCount(0);
});

test("autoload logic restores the configured pinned tabs", async ({ extension }) => {
  const { context, extensionId } = extension;
  const popup = await openExtensionPage(context, extensionId, "popup.html");
  const autoloadUrl = `chrome-extension://${extensionId}/options.html?manual-autoload`;

  await createPinnedTabs(popup, [autoloadUrl]);
  await saveSet(popup, "Manual startup");
  await selectAutoloadSet(popup, "Manual startup");
  await removePinnedTabs(popup);

  await popup.evaluate(async () => {
    const { Autoload } = await import(chrome.runtime.getURL("functions.js"));
    await Autoload.manual();
  });

  await expectOpenTabs(context, [autoloadUrl]);
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

{
  let randomState = 0x23c0ffee;
  const random = () => {
    randomState = (1664525 * randomState + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
  const startupScenarios = Array.from({ length: 2 }, () => ({
    savedTabCount: 1 + Math.floor(random() * 2),
    startsMatching: random() < 0.5,
  }));

  for (const [scenario, { savedTabCount, startsMatching }] of startupScenarios.entries()) {
    test(`randomized Chromium startup restores tab state ${scenario}`, async () => {
      test.slow();
      const userDataDir = await mkdtemp(path.join(os.tmpdir(), "save-pinned-tabs-fuzz-"));
      let firstLaunch;
      let secondLaunch;

      try {
        firstLaunch = await launchExtension(userDataDir);
        const popup = await openExtensionPage(
          firstLaunch.context,
          firstLaunch.extensionId,
          "popup.html",
        );
        const savedUrls = Array.from(
          { length: savedTabCount },
          (_, index) => (
            `chrome-extension://${firstLaunch.extensionId}/tests/e2e/tab.html?fuzz=${scenario}-${index}`
          ),
        );
        const currentUrls = startsMatching
          ? savedUrls
          : [`chrome-extension://${firstLaunch.extensionId}/tests/e2e/tab.html?old=${scenario}`];

        await popup.evaluate(async ({ savedUrls, currentUrls }) => {
          await chrome.storage.sync.set({
            fuzz: { set_name: "Fuzz", autoload: 1, tabs: savedUrls },
          });
          for (const url of currentUrls) {
            await chrome.tabs.create({ url, pinned: true, active: false });
          }
        }, { savedUrls, currentUrls });
        await firstLaunch.context.close();
        firstLaunch = undefined;

        secondLaunch = await launchExtension(userDataDir);
        const reopenedPopup = await openExtensionPage(
          secondLaunch.context,
          secondLaunch.extensionId,
          "popup.html",
        );
        await reopenedPopup.evaluate(async () => {
          const { handleStartup } = await import(chrome.runtime.getURL("service_worker.js"));
          await handleStartup();
        });

        await expect.poll(
          () => reopenedPopup.evaluate(async () => {
            const tabs = await chrome.tabs.query({ pinned: true, currentWindow: true });
            return tabs.map((tab) => tab.pendingUrl || tab.url);
          }),
          { message: `seed 0x23c0ffee scenario ${scenario}` },
        ).toEqual(savedUrls);
      } finally {
        await firstLaunch?.context.close();
        await secondLaunch?.context.close();
        await rm(userDataDir, { recursive: true, force: true });
      }
    });
  }
}
