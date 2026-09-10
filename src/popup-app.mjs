export async function startPopupApp(controller, view) {
  let isPending = false;
  let currentState;

  function render(state) {
    currentState = state;
    view.render(state);
  }

  async function runCommand({ loadingMessage, command, successMessage, onSuccess }) {
    if (isPending) return;
    isPending = true;
    view.showStatus(loadingMessage, 'loading');
    view.setPending(true);

    try {
      const result = await command();
      if (result.status === 'error') {
        if (currentState) render(currentState);
        view.showStatus(result.error.message, 'error');
        return;
      }

      if (result.value?.state) render(result.value.state);
      onSuccess?.();
      view.showStatus(successMessage, 'success');
    } finally {
      isPending = false;
      view.setPending(false);
    }
  }

  const actions = {
    save(name, setId) {
      return runCommand({
        loadingMessage: 'Saving tab set…',
        command: () => controller.saveSet(name, setId),
        successMessage: 'Tab set saved.',
        onSuccess: setId ? undefined : () => view.clearSaveName(),
      });
    },
    load(setId) {
      return runCommand({
        loadingMessage: 'Loading tab set…',
        command: () => controller.loadSet(setId),
        successMessage: 'Tab set loaded.',
      });
    },
    setAutoload(setId, enabled) {
      return runCommand({
        loadingMessage: 'Updating autoload selection…',
        command: () => controller.setAutoload(setId, enabled),
        successMessage: 'Autoload selection updated.',
      });
    },
    async delete(setId) {
      if (isPending) return;
      isPending = true;
      view.setPending(true);
      let confirmed = false;
      try {
        confirmed = await view.confirmDelete();
        if (!confirmed) view.showStatus('Deletion canceled.', 'success');
      } catch (error) {
        view.showStatus(error.message, 'error');
      } finally {
        isPending = false;
        if (!confirmed) view.setPending(false);
      }
      if (!confirmed) return;

      return runCommand({
        loadingMessage: 'Deleting tab set…',
        command: () => controller.deleteSet(setId),
        successMessage: 'Tab set deleted.',
      });
    },
  };

  view.bind(actions);
  await runCommand({
    loadingMessage: 'Loading saved tab sets…',
    command: () => controller.getPopupState(),
    successMessage: '',
  });
  view.focusSaveName();
}
