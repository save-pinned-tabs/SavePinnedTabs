/** Defines the shared domain models for tab sets, browser state, configuration, and command results. */

export type TabSetId = string;

/** Identifies a browser window. */
export type WindowId = number;

/** Represents a persisted collection of tabs. */
export interface TabSet {
  id: TabSetId;
  name: string;
  /** Stores the URLs contained in the set. */
  tabs: string[];
}

/** Describes editable tab set metadata, with an optional ID for new sets. */
export interface TabSetDetails {
  id?: TabSetId | undefined;
  name: string;
}

/** Represents an unsaved or editable tab set. */
export interface TabSetDraft extends TabSetDetails {
  /** Stores the URLs to include in the set. */
  tabs: string[];
}

/** Controls whether sets load in the first window or every window. */
export type AutoloadScope = "first-window" | "every-window";

/** Configures which tab sets load automatically and when. */
export interface AutoloadConfiguration {
  scope: AutoloadScope;
  setIds: TabSetId[];
}

/** Defines the versioned document used to export application data. */
export interface ExportDocument {
  /** Identifies the export schema version. */
  version: number;
  sets: TabSet[];
  autoload: AutoloadConfiguration;
}


/** Tracks the active tab set for an open browser window. */
export interface ActiveWindowSession {
  windowId: WindowId;
  activeSetId: TabSetId;
}


/** Captures the data required to render the popup. */
export interface PopupState {
  sets: TabSet[];
  activeSetId: TabSetId | null;
  autoloadSetIds: TabSetId[];
}

/** Captures the data required to render extension options. */
export interface OptionsState {
  sets: TabSet[];
}

/** Represents either a successful value or a handled error. */
export type CommandResult<T> =
  | { status: "success"; value: T }
  | { status: "error"; error: Error };
