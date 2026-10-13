import '../test/helpers/test-setup.js';
import { existsSync } from 'node:fs';

const chrome = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((file) => existsSync(file));
if (!chrome || !existsSync(chrome)) throw new Error('Browser tests require Chrome; set CHROME_PATH to its executable.');
process.env.CHROME_PATH = chrome;
process.env.SP_E2E = '1';
process.env.RESOURCE_E2E = '1';
