export function selectBrowserApi<BrowserApi>(
  browser: BrowserApi | null | undefined,
  chrome: BrowserApi | null | undefined,
): BrowserApi {
  const browserApi = browser ?? chrome;
  if (!browserApi) {
    throw new Error("The browser extension API is unavailable");
  }
  return browserApi;
}
