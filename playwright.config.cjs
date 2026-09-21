const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  grep: process.env.ENVIRONMENT_E2E ? /environment:/ : undefined,
  grepInvert: process.env.ENVIRONMENT_E2E ? undefined : /environment:/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
  },
});
