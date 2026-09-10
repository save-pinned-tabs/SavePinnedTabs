export function registerCommands(browser, controller) {
  const listener = async (command) => {
    const result = await controller.runShortcut(command);
    if (result.status === 'error') console.error(result.error);
    return result;
  };
  browser.commands.onCommand.addListener(listener);
  return listener;
}
