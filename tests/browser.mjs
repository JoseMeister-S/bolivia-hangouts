// Shared by the browser tests (e2e, smoke, timing): playwright-core with the
// Edge or Chrome already on this machine (`npm i --no-save playwright-core`;
// BROWSER_CHANNEL=chrome to use Chrome), and PASS/FAIL reporting.
import { chromium } from 'playwright-core';

export const launch = () => chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });

export const PHONE = { viewport: { width: 390, height: 844 } };

// The friends' page first shows its saved copy; this marks the fresh data.
export const FRESH = '#calendar[aria-busy="false"]';

export function checks() {
  let failed = 0;
  return {
    check(ok, name) {
      if (!ok) failed += 1;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    },
    fail(name) {
      failed += 1;
      console.log('FAIL  ' + name);
    },
    finish() {
      console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
      process.exit(failed ? 1 : 0);
    },
  };
}
