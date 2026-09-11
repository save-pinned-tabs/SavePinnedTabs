import type { PopupState } from '../domain.js';

type StatusType = 'loading' | 'error' | 'success';

interface CommandError {
  message: string;
}

interface CommandValue {
  state?: PopupState | null;
}

type CommandResult =
  | {
      status: 'error';
      error: CommandError;
    }
  | {
      status: 'success';
      value?: CommandValue | null;
    };

interface Controller {
  saveSet(name: string, setId?: string): Promise<CommandResult>;
  loadSet(setId: string): Promise<CommandResult>;
  appendSet(setId: string): Promise<CommandResult>;
  unloadSet(setId: string): Promise<CommandResult>;
  setAutoload(setId: string, enabled: boolean): Promise<CommandResult>;
  deleteSet(setId: string): Promise<CommandResult>;
  getPopupState(): Promise<CommandResult>;
}

interface Actions {
  save(name: string, setId?: string): Promise<void>;
  load(setId: string): Promise<void>;
  append(setId: string): Promise<void>;
  unload(setId: string): Promise<void>;
  setAutoload(setId: string, enabled: boolean): Promise<void>;
  delete(setId: string): Promise<void>;
}

interface View {
  render(state: PopupState): void;
  showStatus(message: string, status: StatusType): void;
  setPending(pending: boolean): void;
  clearSaveName(): void;
  confirmDelete(): boolean | Promise<boolean>;
  bind(actions: Actions): void;
  focusSaveName(): void;
}

interface RunCommandOptions {
  loadingMessage: string;
  command: () => Promise<CommandResult>;
  successMessage: string;
  onSuccess?: (() => void) | undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }

  return String(error);
}

export async function startPopupApp(
  controller: Controller,
  view: View,
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

      if (result.value?.state) render(result.value.state);
      onSuccess?.();
      view.showStatus(successMessage, 'success');
    } finally {
      isPending = false;
      view.setPending(false);
    }
  }

  const actions: Actions = {
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
        view.showStatus(getErrorMessage(error), 'error');
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