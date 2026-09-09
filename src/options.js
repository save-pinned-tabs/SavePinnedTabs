import { Sets } from "./functions.js";

var importInput = document.getElementById("import-input");

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
