export type TabSetId = string;
export type WindowId = number;

export interface TabSet {
  id: TabSetId;
  name: string;
  tabs: string[];
}

export interface TabSetDraft {
  id?: TabSetId;
  name: string;
  tabs: string[];
}

export type AutoloadScope = "first-window" | "every-window";
export interface AutoloadConfiguration {
  scope: AutoloadScope;
  setIds: TabSetId[];
}

export interface ExportDocument {
  version: number;
  sets: TabSet[];
  autoload: AutoloadConfiguration;
}

export type Result<T> = CommandResult<T>;

export interface ActiveWindowSession {
  windowId: WindowId;
  activeSetId: TabSetId;
}

export interface BrowserCommand {
  name: string;
  shortcut?: string;
  description?: string;
}

export interface PopupState {
  sets: TabSet[];
  activeSetId: TabSetId | null;
  autoloadSetIds: TabSetId[];
}

export interface OptionsState {
  sets: TabSet[];
  assignments: Record<string, TabSetId>;
  commands: BrowserCommand[];
}

export type CommandResult<T> =
  | { status: "success"; value: T }
  | { status: "error"; error: Error };
