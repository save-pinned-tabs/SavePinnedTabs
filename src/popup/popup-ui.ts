import type { TabSet } from '../domain.js';

type SetId = TabSet['id'];
type SetSummary = Pick<TabSet, 'id' | 'name'>;
type ElementConstructor<T extends Element> = abstract new () => T;

interface ViewState {
  readonly sets: readonly SetSummary[];
  readonly activeSetId: SetId | null | undefined;
  readonly autoloadSetIds: readonly SetId[];
}

interface Actions {
  save(name: string, setId?: SetId): void;
  load(setId: SetId): void;
  append(setId: SetId): void;
  unload(setId: SetId): void;
  delete(setId: SetId): void;
  setAutoload(setId: SetId, enabled: boolean): void;
}

interface View {
  bind(this: View, actions: Actions): void;
  render(state: ViewState): void;
  setPending(pending: boolean): void;
  focusSaveName(): void;
  showStatus(message: string, kind: string): void;
  clearSaveName(): void;
  confirmDelete(): Promise<boolean>;
}

function requireElement<T extends Element>(
  document: Document,
  id: string,
  constructor: ElementConstructor<T>,
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Required element #${id} is missing or has an unexpected type.`);
  }
  return element;
}

export function createPopupUi(document: Document): View {
  const saveForm = requireElement(document, 'save-form', HTMLFormElement);
  const saveName = requireElement(document, 'save-name', HTMLInputElement);
  const loadArea = requireElement(document, 'load-area', HTMLElement);
  const status = requireElement(document, 'popup-status', HTMLElement);
  const deleteDialog = requireElement(document, 'delete-dialog', HTMLDialogElement);
  let actions: Actions;
  let isPending = false;

  function button(
    label: string,
    className: string,
    action: () => void,
  ): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.classList.add(className);
    element.textContent = label;
    element.addEventListener('click', action);
    return element;
  }

  function renderSet(set: SetSummary, state: ViewState): HTMLDivElement {
    const row = document.createElement('div');
    row.classList.add('load-row');
    if (state.activeSetId === set.id) row.classList.add('active');
    row.dataset.name = set.name;

    const name = document.createElement('span');
    name.textContent = set.name;
    row.append(name);

    const autoloadLabel = document.createElement('label');
    const autoload = document.createElement('input');
    autoload.type = 'checkbox';
    autoload.name = 'autoload';
    autoload.checked = state.autoloadSetIds.includes(set.id);
    autoload.addEventListener('change', () => {
      actions.setAutoload(set.id, autoload.checked);
    });
    autoloadLabel.append(autoload, document.createTextNode(' Autoload'));
    row.append(autoloadLabel);

    if (state.activeSetId === set.id) {
      row.append(button('Save', 'set-save', () => actions.save(set.name, set.id)));
    }
    row.append(button('Load', 'set-load', () => actions.load(set.id)));
    row.append(button('Append', 'set-append', () => actions.append(set.id)));
    row.append(button('Unload', 'set-unload', () => actions.unload(set.id)));
    row.append(button('Del', 'set-delete', () => actions.delete(set.id)));
    return row;
  }

  function syncPendingControls(): void {
    document.body.setAttribute('aria-busy', String(isPending));
    for (const control of document.querySelectorAll('button, input')) {
      if (
        control instanceof HTMLButtonElement
        || control instanceof HTMLInputElement
      ) {
        if (!deleteDialog.contains(control)) control.disabled = isPending;
      }
    }
  }

  const view: View = {
    bind(nextActions) {
      actions = nextActions;
      saveForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = saveName.value.trim();
        if (!name) {
          this.showStatus('Enter a name for the tab set.', 'error');
          return;
        }
        actions.save(name);
      });
    },

    render(state) {
      const rows = state.sets.map((set) => renderSet(set, state));
      if (rows.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.id = 'placeholder';
        placeholder.textContent = 'There are no saved tab sets';
        rows.push(placeholder);
      }
      loadArea.replaceChildren(...rows);
      syncPendingControls();
    },

    setPending(pending) {
      isPending = pending;
      syncPendingControls();
    },

    focusSaveName() {
      saveName.focus();
    },

    showStatus(message, kind) {
      status.textContent = message;
      status.dataset.kind = kind;
    },

    clearSaveName() {
      saveName.value = '';
    },

    confirmDelete() {
      deleteDialog.returnValue = '';
      deleteDialog.showModal();
      return new Promise<boolean>((resolve) => {
        deleteDialog.addEventListener(
          'close',
          () => {
            resolve(deleteDialog.returnValue === 'delete');
          },
          { once: true },
        );
      });
    },
  };

  return view;
}