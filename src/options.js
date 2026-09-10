import { Sets } from "./functions.js";
import { assignShortcut } from "./shortcuts.mjs";

var importInput = document.getElementById("import-input");
var browser = globalThis.browser ?? globalThis.chrome;

async function initializeShortcuts() {
  const [sets, { shortcutSets = {} }, commands] = await Promise.all([
    browser.storage.sync.get(null),
    browser.storage.local.get("shortcutSets"),
    browser.commands.getAll(),
  ]);
  const shortcuts = new Map(commands.map((command) => [command.name, command.shortcut]));
  for (const select of document.querySelectorAll("[data-shortcut-command]")) {
    select.append(new Option("Not assigned", ""));
    for (const [setId, set] of Object.entries(sets)) {
      select.append(new Option(set.set_name, setId));
    }
    select.value = shortcutSets[select.dataset.shortcutCommand] ?? "";
    select.dataset.savedValue = select.value;
    const shortcut = shortcuts.get(select.dataset.shortcutCommand);
    document.querySelector(
      `[data-shortcut-label="${select.dataset.shortcutCommand}"]`,
    ).textContent = shortcut || "Not assigned in browser";
    select.addEventListener("change", async function () {
      const previousValue = this.dataset.savedValue;
      try {
        await assignShortcut(browser, this.dataset.shortcutCommand, this.value);
        this.dataset.savedValue = this.value;
        document.getElementById("shortcut-status").textContent = "";
      } catch {
        this.value = previousValue;
        document.getElementById("shortcut-status").textContent =
          "Could not save the shortcut assignment. Please try again.";
      }
    });
  }
}


function showNotification(message) {
  var dialog = document.getElementById("notification-dialog");
  document.getElementById("notification-message").textContent = message;
  dialog.showModal();
}

function notifyImportError() {
  showNotification("Failed to import tab sets. Please try again.");

  importInput.value = "";
}

function handleImport() {
  if (!importInput.files[0]) {
    showNotification("Please select a file to import");

    return;
  }

  var reader = new FileReader();

  reader.onload = function () {
    var importData = JSON.parse(reader.result);
    Sets.import(importData)
      .then(function () {
        var importedCount = Object.keys(importData).length;

        showNotification("Successfully Imported " + importedCount + " Tab Sets");

        importInput.value = "";
      })
      .catch(notifyImportError);
  };

  reader.onerror = notifyImportError;

  reader.readAsText(importInput.files[0]);
}

function handleExport() {
  Sets.export();
}

document
  .getElementById("import-button")
  .addEventListener("click", handleImport);

document
  .getElementById("export-button")
  .addEventListener("click", handleExport);

initializeShortcuts().catch(() => {
  document.getElementById("shortcut-status").textContent =
    "Could not load shortcut assignments. Please try again.";
});
