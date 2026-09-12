/** Defines the browser extension API surface used by the application. */


/** Identifies storage entries; null selects all entries in an area. */
export type StorageKeys = string | string[] | Record<string, unknown> | null;

/** Provides asynchronous access to a browser storage area. */
export interface BrowserStorageArea {
  get(keys: StorageKeys): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** Describes the tab properties required by this module. */
export interface BrowserTab {
  id?: number;
  url?: string;
  pendingUrl?: string;
}

/** Describes the window properties required by this module. */
export interface BrowserWindow {
  id?: number;
  type?: string;
}

/** Exposes listener registration for a browser event. */
export interface BrowserEvent<Args extends unknown[]> {
  addListener(listener: (...args: Args) => unknown): void;
}

/** Defines the cross-browser extension APIs consumed by the application. */
export interface BrowserApi {
  tabs: {
    query(query: { pinned: boolean; windowId: number }): Promise<BrowserTab[]>;
    create(properties: {
      windowId: number;
      url: string;
      active: boolean;
    }): Promise<BrowserTab>;
    update(tabId: number, properties: { pinned: boolean }): Promise<BrowserTab>;
    remove(tabIds: number[]): Promise<void>;
  };
  storage: {
    sync: BrowserStorageArea;
    local: BrowserStorageArea;
    session?: BrowserStorageArea;
  };
  runtime: {
    getURL?(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: BrowserEvent<[message: unknown]>;
    onStartup: BrowserEvent<[]>;
  };
  windows: {
    getAll(getInfo: null): Promise<BrowserWindow[]>;
    getCurrent(): Promise<BrowserWindow>;
    onCreated: BrowserEvent<[window: BrowserWindow]>;
    onRemoved: BrowserEvent<[windowId: number]>;
  };
  permissions?: {
    contains(details: { permissions: string[] }): Promise<boolean>;
  };
}

/** Holds the vendor-specific global browser API candidates. */
export interface BrowserGlobals {
  browser: BrowserApi | null | undefined;
  chrome: BrowserApi | null | undefined;
}

/** Selects the available browser API, preferring Firefox and throwing when neither API exists. */
export function selectBrowserApi({ browser, chrome }: BrowserGlobals): BrowserApi {
  const browserApi = browser ?? chrome;
  if (!browserApi) throw new Error("The browser extension API is unavailable");
  return browserApi;
}
