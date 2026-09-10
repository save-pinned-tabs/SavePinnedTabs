export async function startOptionsApp(controller, view) {
  let isPending = false;
  let currentState;

  function render(state) {
    currentState = state;
    view.render(state);
  }

  function showError(error) {
    view.showStatus(error?.message || 'The operation failed. Please try again.', 'error');
  }

  async function runControllerCommand({ loadingMessage, command, successMessage, onSuccess, onError }) {
    if (isPending) return;
    isPending = true;
    view.showStatus(loadingMessage, 'loading');
    view.setPending(true);

    try {
      const result = await command();
      if (result.status === 'error') {
        if (currentState) render(currentState);
        onError?.();
        showError(result.error);
        return;
      }

      if (result.value?.state) render(result.value.state);
      await onSuccess?.(result.value);
      view.showStatus(
        typeof successMessage === 'function' ? successMessage(result.value) : successMessage,
        'success',
      );
    } catch (error) {
      if (currentState) render(currentState);
      onError?.();
      showError(error);
    } finally {
      isPending = false;
      view.setPending(false);
    }
  }

  const actions = {
    assignShortcut(command, setId) {
      return runControllerCommand({
        loadingMessage: 'Saving shortcut assignment…',
        command: () => controller.assignShortcut(command, setId),
        successMessage: 'Shortcut assignment saved.',
      });
    },
    export() {
      return runControllerCommand({
        loadingMessage: 'Preparing tab-set export…',
        command: () => controller.exportSets(),
        successMessage: 'Tab sets exported.',
        onSuccess: (document) => view.downloadExport(document),
      });
    },
    import(file) {
      return runControllerCommand({
        loadingMessage: 'Importing tab sets…',
        command: async () => controller.importSets(await view.readImportDocument(file)),
        successMessage: ({ importedCount }) => (
          `Successfully imported ${importedCount} tab ${importedCount === 1 ? 'set' : 'sets'}.`
        ),
        onSuccess: () => view.clearImport(),
        onError: () => view.clearImport(),
      });
    },
  };

  view.bind(actions);
  await runControllerCommand({
    loadingMessage: 'Loading options…',
    command: () => controller.getOptionsState(),
    successMessage: '',
  });
}
