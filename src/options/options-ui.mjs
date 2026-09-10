function exportFileName(now) {
  return `SavePinnedTabs_export_${now.toISOString().replaceAll(/[.:]/g, '-')}.json`;
}

export function createOptionsUi(document) {
  const importInput = document.getElementById('import-input');
  const status = document.getElementById('options-status');
  let actions;
  let isPending = false;

  function syncPendingControls() {
    document.body.setAttribute('aria-busy', String(isPending));
    for (const control of document.querySelectorAll('button, input, select')) {
      control.disabled = isPending;
    }
  }

  return {
    bind(nextActions) {
      actions = nextActions;
      for (const select of document.querySelectorAll('[data-shortcut-command]')) {
        select.addEventListener('change', () => {
          actions.assignShortcut(select.dataset.shortcutCommand, select.value);
        });
      }
      document.getElementById('export-button').addEventListener('click', () => actions.export());
      document.getElementById('import-button').addEventListener('click', () => {
        const file = importInput.files[0];
        if (!file) {
          this.showStatus('Select a file to import.', 'error');
          return;
        }
        actions.import(file);
      });
    },
    render(state) {
      const shortcuts = new Map(state.commands.map((command) => [command.name, command.shortcut]));
      for (const select of document.querySelectorAll('[data-shortcut-command]')) {
        const command = select.dataset.shortcutCommand;
        const options = [new Option('Not assigned', '')];
        for (const set of state.sets) options.push(new Option(set.name, set.id));
        select.replaceChildren(...options);
        select.value = state.assignments[command] ?? '';

        document.querySelector(`[data-shortcut-label="${command}"]`).textContent =
          shortcuts.get(command) || 'Not assigned in browser';
      }
      syncPendingControls();
    },
    setPending(pending) {
      isPending = pending;
      syncPendingControls();
    },
    showStatus(message, kind) {
      status.textContent = message;
      status.dataset.kind = kind;
    },
    async readImportDocument(file) {
      return JSON.parse(await file.text());
    },
    downloadExport(exportedDocument) {
      const text = JSON.stringify(exportedDocument);
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      globalThis.saveAs(blob, exportFileName(new Date()));
    },
    clearImport() {
      importInput.value = '';
    },
  };
}
