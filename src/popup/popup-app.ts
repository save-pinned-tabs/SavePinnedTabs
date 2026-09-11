import type {
  CommandResult,
  PopupState,
  TabSetId,
} from '../domain.js';
import { errorMessage } from '../validation.js';

type StatusKind = 'loading' | 'error' | 'success';

interface PopupCommandValue {
  state: PopupState;
}

interface PopupController {
  saveSet(
    name: string,
    setId?: TabSetId,
  ): Promise<CommandResult<PopupCommandValue>>;
  loadSet(setId: TabSetId): Promise<CommandResult<PopupCommandValue>>;
  appendSet(setId: TabSetId): Promise<CommandResult<PopupCommandValue>>;
  unloadSet(setId: TabSetId): Promise<CommandResult<PopupCommandValue>>;
  setAutoload(
    setId: TabSetId,
    enabled: boolean,
  ): Promise<CommandResult<PopupCommandValue>>;
  deleteSet(setId: TabSetId): Promise<CommandResult<PopupCommandValue>>;
  getPopupState(): Promise<CommandResult<PopupCommandValue>>;
}

interface PopupActions {
  save(name: string, setId?: TabSetId): Promise<void>;
  load(setId: TabSetId): Promise<void>;
  append(setId: TabSetId): Promise<void>;
  unload(setId: TabSetId): Promise<void>;
  setAutoload(setId: TabSetId, enabled: boolean): Promise<void>;
  delete(setId: TabSetId): Promise<void>;
}

interface PopupView {
  render(state: PopupState): void;
  showStatus(message: string, status: StatusKind): void;
  setPending(pending: boolean): void;
  clearSaveName(): void;
  confirmDelete(): boolean | Promise<boolean>;
  bind(actions: PopupActions): void;
  focusSaveName(): void;
}

interface RunCommandOptions {
  loadingMessage: string;
  command(): Promise<CommandResult<PopupCommandValue>>;
  onSuccess?: (() => void) | undefined;
  successMessage: string;
}

export async function startPopupApp(
  controller: PopupController,
  view: PopupView,
): Promise<void> {
  let isPending = false;
  let currentState: PopupState | undefined;

  function render(state: PopupState): void {
    currentState = state;
    view.render(state);
  }

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
        view.showStatus(result.error.message, 'error');
        return;
      }

      render(result.value.state);
      onSuccess?.();
      view.showStatus(successMessage, 'success');
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
    append(setId) {
      return runCommand({
        loadingMessage: 'Appending tab set…',
        command: () => controller.appendSet(setId),
        successMessage: 'Tab set appended.',
      });
    },
    unload(setId) {
      return runCommand({
        loadingMessage: 'Unloading tab set…',
        command: () => controller.unloadSet(setId),
        successMessage: 'Tab set unloaded.',
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
      } catch (error: unknown) {
        view.showStatus(errorMessage(error), 'error');
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