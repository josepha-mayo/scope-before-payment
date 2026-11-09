'use strict';
const {defineConfig}=require('@playwright/test');
const path=require('node:path');
module.exports=defineConfig({
  testDir:'.',testMatch:'runtime.spec.js',timeout:60000,workers:1,retries:0,fullyParallel:false,
  reporter:[['list']],
  use:{browserName:'chromium',baseURL:'https://127.0.0.1:4188',ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},trace:'off',video:'off',screenshot:'only-on-failure'},
  // Trusting this disposable loopback test certificate never changes the user's
  // browser trust store or production certificate validation.
  webServer:{cwd:path.resolve(__dirname,'..'),command:'node ../../apps/scope-web/portable/tests/browser-server.mjs',url:'https://127.0.0.1:4188/healthz',ignoreHTTPSErrors:true,reuseExistingServer:false,timeout:90000},
});
