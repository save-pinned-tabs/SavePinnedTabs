/** Builds and manages the options page UI for imports and exports. */

import type { ExportDocument, OptionsState } from '../domain.js';
import { requireElement } from '../dom.js';


/** Defines operations triggered by user interactions in the options view. */
interface OptionsActions {
  export(): void;
  import(file: File): void;
}

/** Defines the UI contract used to display and collect options data. */
interface OptionsView {
  bind(actions: OptionsActions): void;
  render(state: OptionsState): void;
  setPending(pending: boolean): void;
  showStatus(message: string, kind: string): void;
  readImportDocument(file: File): Promise<unknown>;
  downloadExport(exportedDocument: ExportDocument): void;
  clearImport(): void;
}

/** Creates a filesystem-safe export filename containing the supplied timestamp. */
function exportFileName(now: Date): string {
  return `SavePinnedTabs_export_${now.toISOString().replaceAll(/[.:]/g, '-')}.json`;
}



/** Downloads a blob through the global FileSaver API or throws when unavailable. */
function saveBlob(blob: Blob, filename: string): void {
  const saveAs: unknown = Reflect.get(globalThis, 'saveAs');
  if (typeof saveAs !== 'function') {
    throw new TypeError('globalThis.saveAs is not a function.');
  }
  saveAs(blob, filename);
}

/** Creates an options view bound to required controls in the supplied document. */
export function createOptionsUi(document: Document): OptionsView {
  const importInput = requireElement(document, 'import-input', HTMLInputElement);
  const status = requireElement(document, 'options-status', HTMLElement);
  let actions: OptionsActions | undefined;
  let isPending = false;

  /** Returns the bound actions or throws when the view has not been initialized. */
  function currentActions(): OptionsActions {
    if (actions === undefined) {
      throw new Error('Options actions have not been bound.');
    }
    return actions;
  }

  /** Reflects pending state in accessibility metadata and interactive controls. */
  function syncPendingControls(): void {
    document.body.setAttribute('aria-busy', String(isPending));

    for (const control of document.querySelectorAll('button, input, select')) {
      if (
        control instanceof HTMLButtonElement ||
        control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement
      ) {
        control.disabled = isPending;
      }
    }
  }

  const view: OptionsView = {
    /** Binds action handlers and installs DOM event listeners. */
    bind(nextActions): void {
      actions = nextActions;

      requireElement(document, 'export-button', HTMLButtonElement).addEventListener('click', () => {
        currentActions().export();
      });

      requireElement(document, 'import-button', HTMLButtonElement).addEventListener('click', () => {
        const files = importInput.files;
        if (files === null) {
          throw new Error('Import input does not expose a file list.');
        }

        const file = files[0];
        if (!file) {
          this.showStatus('Select a file to import.', 'error');
          return;
        }

        currentActions().import(file);
      });
    },

    /** Updates controls from the current options state. */
    render(): void {
      syncPendingControls();
    },

    /** Sets the busy state and enables or disables interactive controls. */
    setPending(pending): void {
      isPending = pending;
      syncPendingControls();
    },

    /** Displays a status message and exposes its presentation category. */
    showStatus(message, kind): void {
      status.textContent = message;
      status.dataset.kind = kind;
    },

    /** Parses a selected import file as JSON and rejects malformed content. */
    async readImportDocument(file): Promise<unknown> {
      const parsed: unknown = JSON.parse(await file.text());
      return parsed;
    },

    /** Serializes and downloads an export document as timestamped JSON. */
    downloadExport(exportedDocument): void {
      const text = JSON.stringify(exportedDocument);
      const blob = new Blob([text ?? 'undefined'], {
        type: 'application/json;charset=utf-8',
      });
      saveBlob(blob, exportFileName(new Date()));
    },

    /** Clears the selected import file. */
    clearImport(): void {
      importInput.value = '';
    },
  };

  return view;
}