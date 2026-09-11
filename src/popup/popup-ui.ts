/**
 * Builds and manages the popup interface for saving and restoring tab sets.
 */

import type { TabSet } from '../domain.js';
import { requireElement } from '../dom.js';

/** Identifies a persisted tab set. */
type SetId = TabSet['id'];

/** Contains the fields needed to display a tab set. */
type SetSummary = Pick<TabSet, 'id' | 'name'>;

/** Describes the data currently presented by the popup. */
interface ViewState {
  /** Lists saved tab sets in display order. */
  readonly sets: readonly SetSummary[];

  /** Distinguishes an active set, no active set, and an unknown active state. */
  readonly activeSetId: SetId | null | undefined;

  /** Identifies sets configured to load automatically. */
  readonly autoloadSetIds: readonly SetId[];
}

/** Defines operations triggered by popup controls. */
interface Actions {
  /** Creates a set or overwrites the identified set. */
  save(name: string, setId?: SetId): void;

  /** Replaces the current tabs with a saved set. */
  load(setId: SetId): void;

  /** Adds a saved set to the current tabs. */
  append(setId: SetId): void;

  /** Removes a saved set's tabs from the current window. */
  unload(setId: SetId): void;

  /** Requests deletion of a saved set. */
  delete(setId: SetId): void;

  /** Enables or disables automatic loading for a set. */
  setAutoload(setId: SetId, enabled: boolean): void;
}

/** Exposes popup rendering and interaction controls. */
interface View {
  /** Connects user interactions to application actions. */
  bind(this: View, actions: Actions): void;

  /** Replaces the displayed set list with the supplied state. */
  render(state: ViewState): void;

  /** Disables or enables controls while preserving dialog interaction. */
  setPending(pending: boolean): void;

  /** Moves keyboard focus to the set-name input. */
  focusSaveName(): void;

  /** Displays a categorized status message. */
  showStatus(message: string, kind: string): void;

  /** Resets the set-name input. */
  clearSaveName(): void;

  /** Opens the deletion dialog and resolves with the user's decision. */
  confirmDelete(): Promise<boolean>;
}


/** Creates a popup view backed by required elements in the given document. */
export function createPopupUi(document: Document): View {
  const saveForm = requireElement(document, 'save-form', HTMLFormElement);
  const saveName = requireElement(document, 'save-name', HTMLInputElement);
  const loadArea = requireElement(document, 'load-area', HTMLElement);
  const status = requireElement(document, 'popup-status', HTMLElement);
  const deleteDialog = requireElement(document, 'delete-dialog', HTMLDialogElement);
  let actions: Actions;
  let isPending = false;

  /** Creates a button that invokes an action when clicked. */
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

  /** Builds an interactive row for a saved set. */
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

  /** Synchronizes busy state and control availability with pending work. */
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
    /** Connects form and row interactions to application actions. */
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

    /** Rebuilds the set list and reapplies pending control state. */
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

    /** Updates whether non-dialog controls accept interaction. */
    setPending(pending) {
      isPending = pending;
      syncPendingControls();
    },

    /** Moves focus to the set-name input. */
    focusSaveName() {
      saveName.focus();
    },

    /** Replaces the visible status and its presentation category. */
    showStatus(message, kind) {
      status.textContent = message;
      status.dataset.kind = kind;
    },

    /** Empties the set-name input. */
    clearSaveName() {
      saveName.value = '';
    },

    /** Shows a modal prompt and resolves only after it closes. */
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