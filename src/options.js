import { Sets } from "./functions.js";
import { getAutoloadScope, setAutoloadScope } from "./settings.mjs";


var browser = globalThis.browser ?? globalThis.chrome;
var importInput = document.getElementById("import-input");
async function initializeAutoloadScope() {
  const scope = await getAutoloadScope(browser);
  for (const input of document.querySelectorAll('input[name="autoload-scope"]')) {
    input.checked = input.value === scope;
    input.disabled = false;
    input.addEventListener("change", handleAutoloadScopeChange);
  }
}

async function handleAutoloadScopeChange(event) {
  if (!event.target.checked) return;
  await setAutoloadScope(browser, event.target.value);
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

initializeAutoloadScope();
