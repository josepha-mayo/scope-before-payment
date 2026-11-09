'use strict';
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: '.', testMatch: '*.spec.js', timeout: 60000,
  fullyParallel: false, workers: 1, retries: 0,
  projects: [
    { name: 'local', testIgnore: ['hosted-workspaces.spec.js','**/portable/**'] },
    { name: 'hosted', testMatch: 'hosted-workspaces.spec.js' },
  ],
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, trace: 'off', video: 'off', screenshot: 'only-on-failure' },
});
