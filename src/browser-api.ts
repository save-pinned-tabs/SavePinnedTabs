import type { BrowserCommand } from './domain.js';

export type StorageKeys = string | string[] | Record<string, unknown> | null;

export interface BrowserStorageArea {
  get(keys: StorageKeys): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface BrowserTab {
  id?: number;
  url?: string;
  pendingUrl?: string;
}

export interface BrowserWindow {
  id?: number;
  type?: string;
}

export interface BrowserEvent<Args extends unknown[]> {
  addListener(listener: (...args: Args) => unknown): void;
}

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
    getLastFocused(options: {
      windowTypes: ["normal"];
    }): Promise<BrowserWindow>;
    onCreated: BrowserEvent<[window: BrowserWindow]>;
    onRemoved: BrowserEvent<[windowId: number]>;
  };
  commands: {
    getAll(): Promise<BrowserCommand[]>;
    onCommand: BrowserEvent<[command: string]>;
  };
  permissions?: {
    contains(details: { permissions: string[] }): Promise<boolean>;
  };
}

export interface BrowserGlobals {
  browser: BrowserApi | null | undefined;
  chrome: BrowserApi | null | undefined;
}

export function selectBrowserApi({ browser, chrome }: BrowserGlobals): BrowserApi {
  const browserApi = browser ?? chrome;
  if (!browserApi) throw new Error("The browser extension API is unavailable");
  return browserApi;
}
