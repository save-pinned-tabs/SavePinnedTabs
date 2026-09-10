export const AUTOLOAD_SCOPE_FIRST_WINDOW = 'first-window';
export const AUTOLOAD_SCOPE_EVERY_WINDOW = 'every-window';

const AUTOLOAD_SCOPE_KEY = 'autoloadScope';

export async function getAutoloadScope(browser) {
  const settings = await browser.storage.local.get(AUTOLOAD_SCOPE_KEY);
  return settings[AUTOLOAD_SCOPE_KEY] ?? AUTOLOAD_SCOPE_FIRST_WINDOW;
}

export function setAutoloadScope(browser, scope) {
  return browser.storage.local.set({ [AUTOLOAD_SCOPE_KEY]: scope });
}
