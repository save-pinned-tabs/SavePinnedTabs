export function createPopupUi(document) {
  const saveForm = document.getElementById('save-form');
  const saveName = document.getElementById('save-name');
  const loadArea = document.getElementById('load-area');
  const status = document.getElementById('popup-status');
  const deleteDialog = document.getElementById('delete-dialog');
  let actions;
  let isPending = false;

  function button(label, className, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.classList.add(className);
    element.textContent = label;
    element.addEventListener('click', action);
    return element;
  }

  function renderSet(set, state) {
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
    autoload.addEventListener('change', () => actions.setAutoload(set.id, autoload.checked));
    autoloadLabel.append(autoload, document.createTextNode(' Autoload'));
    row.append(autoloadLabel);

    if (state.activeSetId === set.id) {
      row.append(button('Save', 'set-save', () => actions.save(set.name, set.id)));
    }
    row.append(button('Load', 'set-load', () => actions.load(set.id)));
    row.append(button('Del', 'set-delete', () => actions.delete(set.id)));
    return row;
  }

  function syncPendingControls() {
    document.body.setAttribute('aria-busy', String(isPending));
    for (const control of document.querySelectorAll('button, input')) {
      if (!deleteDialog.contains(control)) control.disabled = isPending;
    }
  }

  return {
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
      return new Promise((resolve) => {
        deleteDialog.addEventListener('close', () => {
          resolve(deleteDialog.returnValue === 'delete');
        }, { once: true });
      });
    },
  };
}
