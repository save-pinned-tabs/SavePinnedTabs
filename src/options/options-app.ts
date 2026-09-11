/** Coordinates the options controller and view for tab-set management. */

import type {
  CommandResult,
  ExportDocument,
  OptionsState,
  TabSetId,
} from '../domain.js';

/** Identifies the visual state of an operation status message. */
type StatusKind = 'loading' | 'error' | 'success';

/** Defines the tab-set operations available to the options application. */
interface OptionsController {
  /** Assigns a browser command to a tab set and returns the updated state. */
  assignShortcut(
    command: string,
    setId: TabSetId,
  ): Promise<CommandResult<{ state: OptionsState }>>;

  /** Creates a portable document containing the saved tab sets. */
  exportSets(): Promise<CommandResult<ExportDocument>>;

  /** Imports tab sets from parsed external data and returns the updated state. */
  importSets(document: unknown): Promise<CommandResult<{
    importedCount: number;
    state: OptionsState;
  }>>;

  /** Loads the current options state. */
  getOptionsState(): Promise<CommandResult<{ state: OptionsState }>>;
}

/** Defines user actions exposed to the options view. */
interface OptionsActions {
  /** Saves a command assignment for a tab set. */
  assignShortcut(command: string, setId: TabSetId): Promise<void>;

  /** Exports the current tab sets as a downloadable document. */
  export(): Promise<void>;

  /** Reads and imports tab sets from a selected file. */
  import(file: File): Promise<void>;
}

/** Defines rendering and file operations supplied by the options UI. */
interface OptionsView {
  /** Connects application actions to UI event handlers. */
  bind(actions: OptionsActions): void;

  /** Displays the current options state. */
  render(state: OptionsState): void;

  /** Displays operation progress or outcome feedback. */
  showStatus(message: string, status: StatusKind): void;

  /** Enables or disables controls while an operation is active. */
  setPending(isPending: boolean): void;

  /** Starts a download for an exported tab-set document. */
  downloadExport(document: ExportDocument): void;

  /** Reads and parses an import file into untrusted input. */
  readImportDocument(file: File): Promise<unknown>;

  /** Clears the selected import file and related UI state. */
  clearImport(): void;
}

/** Describes a controller operation and its UI lifecycle callbacks. */
interface ControllerCommand<Value> {
  loadingMessage: string;
  command(): Promise<CommandResult<Value>>;
  successMessage: string | ((value: Value) => string);
  state?(value: Value): OptionsState | undefined;
  onSuccess?(value: Value): Promise<void>;
  onError?(): void;
}

/** Converts an unknown failure into a user-facing fallback message. */
function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The operation failed. Please try again.';
}

/** Binds the options UI, loads its initial state, and coordinates later actions. */
export async function startOptionsApp(
  controller: OptionsController,
  view: OptionsView,
): Promise<void> {
  let isPending = false;
  let currentState: OptionsState | undefined;

  /** Stores and renders the latest confirmed options state. */
  function render(state: OptionsState): void {
    currentState = state;
    view.render(state);
  }

  /** Runs one controller operation at a time and reports its UI lifecycle. */
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
    /** Saves a shortcut assignment and renders the resulting state. */
    assignShortcut(command, setId) {
      return runControllerCommand({
        loadingMessage: 'Saving shortcut assignment…',
        command: () => controller.assignShortcut(command, setId),
        successMessage: 'Shortcut assignment saved.',
        state: (value) => value.state,
      });
    },

    /** Exports tab sets and starts their download after creation. */
    export() {
      return runControllerCommand({
        loadingMessage: 'Preparing tab-set export…',
        command: () => controller.exportSets(),
        successMessage: 'Tab sets exported.',
        onSuccess: async (document) => view.downloadExport(document),
      });
    },

    /** Imports a selected file and clears the selection after either outcome. */
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
        onSuccess: async () => view.clearImport(),
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
