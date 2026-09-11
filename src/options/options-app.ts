import type {
  CommandResult,
  ExportDocument,
  OptionsState,
  TabSetId,
} from '../domain.js';

type MaybePromise<T> = T | PromiseLike<T>;
type StatusKind = 'loading' | 'error' | 'success';

interface OptionsController {
  assignShortcut(
    command: string,
    setId: TabSetId,
  ): MaybePromise<CommandResult<{ state: OptionsState }>>;
  exportSets(): MaybePromise<CommandResult<ExportDocument>>;
  importSets(document: unknown): MaybePromise<CommandResult<{
    importedCount: number;
    state: OptionsState;
  }>>;
  getOptionsState(): MaybePromise<CommandResult<{ state: OptionsState }>>;
}

interface OptionsActions {
  assignShortcut(command: string, setId: TabSetId): Promise<void>;
  export(): Promise<void>;
  import(file: File): Promise<void>;
}

interface OptionsView {
  bind(actions: OptionsActions): void;
  render(state: OptionsState): void;
  showStatus(message: string, status: StatusKind): void;
  setPending(isPending: boolean): void;
  downloadExport(document: ExportDocument): MaybePromise<void>;
  readImportDocument(file: File): MaybePromise<unknown>;
  clearImport(): void;
}

interface ControllerCommand<Value> {
  loadingMessage: string;
  command(): MaybePromise<CommandResult<Value>>;
  successMessage: string | ((value: Value) => string);
  state?(value: Value): OptionsState | undefined;
  onSuccess?(value: Value): MaybePromise<void>;
  onError?(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The operation failed. Please try again.';
}

export async function startOptionsApp(
  controller: OptionsController,
  view: OptionsView,
): Promise<void> {
  let isPending = false;
  let currentState: OptionsState | undefined;

  function render(state: OptionsState): void {
    currentState = state;
    view.render(state);
  }

  async function runControllerCommand<Value>({
    loadingMessage,
    command,
    successMessage,
    state,
    onSuccess,
    onError,
  }: ControllerCommand<Value>): Promise<void> {
    if (isPending) return;
    isPending = true;
    view.showStatus(loadingMessage, 'loading');
    view.setPending(true);

    try {
      const result = await command();
      if (result.status === 'error') {
        if (currentState) render(currentState);
        onError?.();
        view.showStatus(result.error.message, 'error');
        return;
      }

      const nextState = state?.(result.value);
      if (nextState) render(nextState);
      await onSuccess?.(result.value);
      view.showStatus(
        typeof successMessage === 'function'
          ? successMessage(result.value)
          : successMessage,
        'success',
      );
    } catch (error: unknown) {
      if (currentState) render(currentState);
      onError?.();
      view.showStatus(errorMessage(error), 'error');
    } finally {
      isPending = false;
      view.setPending(false);
    }
  }

  const actions: OptionsActions = {
    assignShortcut(command, setId) {
      return runControllerCommand({
        loadingMessage: 'Saving shortcut assignment…',
        command: () => controller.assignShortcut(command, setId),
        successMessage: 'Shortcut assignment saved.',
        state: (value) => value.state,
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
        command: async () => controller.importSets(
          await view.readImportDocument(file),
        ),
        successMessage: ({ importedCount }) =>
          `Successfully imported ${importedCount} tab ${
            importedCount === 1 ? 'set' : 'sets'
          }.`,
        state: (value) => value.state,
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
    state: (value) => value.state,
  });
}
