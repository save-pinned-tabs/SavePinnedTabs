export function registerCommands(browser, controller) {
  browser.commands.onCommand.addListener(async (command) => {
    const result = await controller.runShortcut(command);
    if (result.status === 'error') console.error(result.error);
  });
}
