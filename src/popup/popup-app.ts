/** Coordinates popup commands, view bindings, status updates, and rendered state. */

import type {
  CommandResult,
  PopupState,
  TabSetId,
} from '../domain.js';
import { errorMessage } from '../validation.js';

/** Identifies the visual state of a popup status message. */
type StatusKind = 'loading' | 'error' | 'success' | 'warning';

/** Carries the latest popup state returned by a command. */
interface PopupCommandValue {
  state: PopupState;
}

const LOCAL_ONLY_MESSAGE =
  'Tab sets are available locally, but synchronization is suspended because this extension’s Chrome sync storage is full. Export or delete saved data to reduce its size.';

/** Provides commands that read or mutate saved tab sets. */
interface PopupController {
  saveSet(
    name: string,
    setId?: TabSetId,
  ): Promise<CommandResult<PopupCommandValue>>;
  loadSet(setId: TabSetId): Promise<CommandResult<PopupCommandValue>>;
  setAutoload(
    setId: TabSetId,
    enabled: boolean,
  ): Promise<CommandResult<PopupCommandValue>>;
  deleteSet(setId: TabSetId): Promise<CommandResult<PopupCommandValue>>;
  getPopupState(): Promise<CommandResult<PopupCommandValue>>;
}

/** Exposes user-triggered operations to the popup view. */
interface PopupActions {
  save(name: string, setId?: TabSetId): Promise<void>;
  load(setId: TabSetId): Promise<void>;
  setAutoload(setId: TabSetId, enabled: boolean): Promise<void>;
  delete(setId: TabSetId): Promise<void>;
}

/** Defines rendering, feedback, confirmation, and event-binding behavior. */
interface PopupView {
  render(state: PopupState): void;
  showStatus(message: string, status: StatusKind): void;
  setPending(pending: boolean): void;
  clearSaveName(): void;
  confirmDelete(): boolean | Promise<boolean>;
  bind(actions: PopupActions): void;
  focusSaveName(): void;
}

/** Configures status messages and callbacks for a serialized command. */
interface RunCommandOptions {
  loadingMessage: string;
  command(): Promise<CommandResult<PopupCommandValue>>;
  onSuccess?: (() => void) | undefined;
  successMessage: string;
}

/** Binds popup actions, loads initial state, and focuses the save-name input. */
export async function startPopupApp(
  controller: PopupController,
  view: PopupView,
): Promise<void> {
  let isPending = false;
  let currentState: PopupState | undefined;

  /** Caches the latest state before rendering it. */
  function render(state: PopupState): void {
    currentState = state;
    view.render(state);
  }

  /** Runs one command at a time and synchronizes status, pending, and rendered state. */
  async function runCommand({
    loadingMessage,
    command,
    successMessage,
    onSuccess,
  }: RunCommandOptions): Promise<void> {
    if (isPending) return;
    isPending = true;
    view.showStatus(loadingMessage, 'loading');
    view.setPending(true);

    try {
      const result = await command();
      if (result.status === 'error') {
        if (currentState) render(currentState);
        const isLocalOnly = currentState?.synchronization === 'local-only';
        view.showStatus(
          isLocalOnly
            ? `${result.error.message} ${LOCAL_ONLY_MESSAGE}`
            : result.error.message,
          isLocalOnly ? 'warning' : 'error',
        );
        return;
      }

      render(result.value.state);
      onSuccess?.();
      view.showStatus(
        result.value.state.synchronization === 'local-only'
          ? LOCAL_ONLY_MESSAGE
          : successMessage,
        result.value.state.synchronization === 'local-only'
          ? 'warning'
          : 'success',
      );
    } finally {
      isPending = false;
      view.setPending(false);
    }
  }

  const actions: PopupActions = {
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
        if (!confirmed) {
          const isLocalOnly = currentState?.synchronization === 'local-only';
          view.showStatus(
            isLocalOnly ? LOCAL_ONLY_MESSAGE : 'Deletion canceled.',
            isLocalOnly ? 'warning' : 'success',
          );
        }
      } catch (error: unknown) {
        const isLocalOnly = currentState?.synchronization === 'local-only';
        view.showStatus(
          isLocalOnly
            ? `${errorMessage(error)} ${LOCAL_ONLY_MESSAGE}`
            : errorMessage(error),
          isLocalOnly ? 'warning' : 'error',
        );
      } finally {
        isPending = false;
        if (!confirmed) view.setPending(false);
      }
      if (!confirmed) return;

      await runCommand({
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