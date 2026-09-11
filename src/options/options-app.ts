import type {
  ExportDocument,
  Result,
} from '../domain.js';

type Awaitable<T> = T | Promise<T>;
type StatusKind = 'loading' | 'error' | 'success';

interface ImportResult {
  readonly importedCount: number;
}

interface Controller<Command extends string, SetId> {
  assignShortcut(
    command: Command,
    setId: SetId,
  ): Awaitable<Result<unknown>>;
  exportSets(): Awaitable<Result<ExportDocument>>;
  importSets(
    document: unknown,
  ): Awaitable<Result<ImportResult>>;
  getOptionsState(): Awaitable<Result<unknown>>;
}

interface Actions<Command extends string, SetId> {
  assignShortcut(command: Command, setId: SetId): Promise<void>;
  export(): Promise<void>;
  import(file: File): Promise<void>;
}

interface View<Command extends string, SetId> {
  bind(actions: Actions<Command, SetId>): void;
  render(state: unknown): void;
  showStatus(message: string, status: StatusKind): void;
  setPending(isPending: boolean): void;
  downloadExport(document: ExportDocument): Awaitable<void>;
  readImportDocument(file: File): Awaitable<unknown>;
  clearImport(): void;
}

interface ControllerCommand<Value> {
  readonly loadingMessage: string;
  readonly command: () => Awaitable<Result<Value>>;
  readonly successMessage:
    | string
    | ((value: Value) => string);
  readonly onSuccess?: (value: Value) => Awaitable<void>;
  readonly onError?: () => void;
}

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null)
    || typeof value === 'function'
  );
}

function getErrorMessage(error: unknown): string {
  if (
    isObjectLike(error)
    && 'message' in error
    && typeof error.message === 'string'
    && error.message
  ) {
    return error.message;
  }

  return 'The operation failed. Please try again.';
}

export async function startOptionsApp<
  Command extends string,
  SetId,
>(
  controller: Controller<Command, SetId>,
  view: View<Command, SetId>,
): Promise<void> {
  let isPending = false;
  let currentState: unknown;

  function render(state: unknown): void {
    currentState = state;
    view.render(state);
  }

  function renderResultState(value: unknown): void {
    if (
      isObjectLike(value)
      && 'state' in value
      && value.state
    ) {
      render(value.state);
    }
  }

  function showError(error: unknown): void {
    view.showStatus(getErrorMessage(error), 'error');
  }

  async function runControllerCommand<Value>({
    loadingMessage,
    command,
    successMessage,
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
        showError(result.error);
        return;
      }

      renderResultState(result.value);
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
      showError(error);
    } finally {
      isPending = false;
      view.setPending(false);
    }
  }

  const actions: Actions<Command, SetId> = {
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
        command: async () => controller.importSets(
          await view.readImportDocument(file),
        ),
        successMessage: ({ importedCount }) => (
          `Successfully imported ${importedCount} tab ${
            importedCount === 1 ? 'set' : 'sets'
          }.`
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