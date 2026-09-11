import type { ExportDocument } from '../domain.js';

interface ShortcutCommand {
  readonly name: string;
  readonly shortcut?: string;
}

interface SetSummary {
  readonly id: string;
  readonly name: string;
}

interface OptionsState {
  readonly commands: readonly ShortcutCommand[];
  readonly sets: readonly SetSummary[];
  readonly assignments: Readonly<Record<string, string | undefined>>;
}

interface OptionsActions {
  assignShortcut(command: string, setId: string): void;
  export(): void;
  import(file: File): void;
}

interface OptionsView {
  bind(actions: OptionsActions): void;
  render(state: OptionsState): void;
  setPending(pending: boolean): void;
  showStatus(message: string, kind: string): void;
  readImportDocument(file: File): Promise<unknown>;
  downloadExport(exportedDocument: ExportDocument): void;
  clearImport(): void;
}

function exportFileName(now: Date): string {
  return `SavePinnedTabs_export_${now.toISOString().replaceAll(/[.:]/g, '-')}.json`;
}

function requiredElement(document: Document, id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Required element #${id} was not found.`);
  }
  return element;
}

function requiredInput(document: Document, id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Required input #${id} was not found.`);
  }
  return element;
}

function requiredButton(document: Document, id: string): HTMLButtonElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Required button #${id} was not found.`);
  }
  return element;
}

function requiredSelector(document: Document, selector: string): Element {
  const element = document.querySelector(selector);
  if (element === null) {
    throw new Error(`Required element matching ${selector} was not found.`);
  }
  return element;
}

function shortcutCommandFor(select: HTMLSelectElement): string {
  const command = select.dataset.shortcutCommand;
  if (command === undefined) {
    throw new Error('Shortcut select is missing data-shortcut-command.');
  }
  return command;
}

function saveBlob(blob: Blob, filename: string): void {
  const saveAs: unknown = Reflect.get(globalThis, 'saveAs');
  if (typeof saveAs !== 'function') {
    throw new TypeError('globalThis.saveAs is not a function.');
  }
  saveAs(blob, filename);
}

export function createOptionsUi(document: Document): OptionsView {
  const importInput = requiredInput(document, 'import-input');
  const status = requiredElement(document, 'options-status');
  let actions: OptionsActions | undefined;
  let isPending = false;

  function currentActions(): OptionsActions {
    if (actions === undefined) {
      throw new Error('Options actions have not been bound.');
    }
    return actions;
  }

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
    bind(nextActions): void {
      actions = nextActions;

      for (const element of document.querySelectorAll('[data-shortcut-command]')) {
        if (!(element instanceof HTMLSelectElement)) {
          throw new Error('Shortcut command control must be a select element.');
        }

        element.addEventListener('change', () => {
          currentActions().assignShortcut(shortcutCommandFor(element), element.value);
        });
      }

      requiredButton(document, 'export-button').addEventListener('click', () => {
        currentActions().export();
      });

      requiredButton(document, 'import-button').addEventListener('click', () => {
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

    render(state): void {
      const shortcuts = new Map(
        state.commands.map((command) => [command.name, command.shortcut]),
      );

      for (const element of document.querySelectorAll('[data-shortcut-command]')) {
        if (!(element instanceof HTMLSelectElement)) {
          throw new Error('Shortcut command control must be a select element.');
        }

        const command = shortcutCommandFor(element);
        const options = [new Option('Not assigned', '')];

        for (const set of state.sets) {
          options.push(new Option(set.name, set.id));
        }

        element.replaceChildren(...options);
        element.value = state.assignments[command] ?? '';

        requiredSelector(
          document,
          `[data-shortcut-label="${command}"]`,
        ).textContent = shortcuts.get(command) || 'Not assigned in browser';
      }

      syncPendingControls();
    },

    setPending(pending): void {
      isPending = pending;
      syncPendingControls();
    },

    showStatus(message, kind): void {
      status.textContent = message;
      status.dataset.kind = kind;
    },

    async readImportDocument(file): Promise<unknown> {
      const parsed: unknown = JSON.parse(await file.text());
      return parsed;
    },

    downloadExport(exportedDocument): void {
      const text = JSON.stringify(exportedDocument);
      const blob = new Blob([text ?? 'undefined'], {
        type: 'application/json;charset=utf-8',
      });
      saveBlob(blob, exportFileName(new Date()));
    },

    clearImport(): void {
      importInput.value = '';
    },
  };

  return view;
}