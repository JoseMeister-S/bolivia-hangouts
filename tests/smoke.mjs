// Browser smoke test of a deployed site (headless Edge/Chrome through
// playwright-core, which is not a dependency: `npm i --no-save playwright-core`).
//
//   node tests/smoke.mjs https://your.site                -> gate + login screens
//   INVITE_CODE=xxx READ_ONLY=1 node tests/smoke.mjs <url> -> also load the timetable
//   INVITE_CODE=xxx node tests/smoke.mjs <url>             -> also send one proposal
//
// Without READ_ONLY it sends one proposal titled "[TEST] smoke". Reject it in admin.html.
import { chromium } from 'playwright-core';

const base = (process.argv[2] || 'http://localhost:5500').replace(/\/$/, '');
const code = process.env.INVITE_CODE;
const shots = process.env.SHOTS_DIR;
let failed = 0;
const check = (ok, name) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });

async function open(path, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + path);
  return { page, errors };
}

{
  const { page, errors } = await open('/');
  await page.waitForSelector('#gate:not([hidden])');
  check(await page.isHidden('#calendar'), 'no code: only the "ask Jose" message');
  check(errors.length === 0, 'no code: no script errors ' + errors.join(' | '));
}
{
  const { page, errors } = await open('/?c=definitely-wrong');
  await page.waitForSelector('#gate:not([hidden])', { timeout: 20000 });
  check(await page.isHidden('#calendar'), 'wrong code: only the "ask Jose" message');
  check(errors.length === 0, 'wrong code: no script errors ' + errors.join(' | '));
}
{
  const { page, errors } = await open('/admin.html');
  await page.waitForSelector('#login:not([hidden])', { timeout: 20000 });
  check(await page.isHidden('#panel'), 'admin: login screen, no panel');
  check(errors.length === 0, 'admin: no script errors ' + errors.join(' | '));
}

if (code) {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await open('/?c=' + encodeURIComponent(code), { colorScheme });
    await page.waitForSelector('.tt-row[id^="d-"]', { timeout: 20000 });
    check(await page.locator('.tt-row[id^="d-"]').count() === 20, `${colorScheme}: timetable has 20 days`);
    check((await page.locator('#d-2026-12-14 .tt-cell').first().innerText()) === 'Llegando a Cochabamba (21:55)', `${colorScheme}: 14 Dec is blocked with its label`);
    check(await page.evaluate(() => document.fonts.check('16px "Bricolage Grotesque"')), `${colorScheme}: the typeface loaded`);
    if (shots) await page.screenshot({ path: `${shots}/live-${colorScheme}.png` });

    if (colorScheme === 'light' && !process.env.READ_ONLY) {
      await page.locator('#d-2026-12-18 .tt-cell.is-free').first().click();
      await page.fill('.propose input[name=name]', 'Prueba');
      await page.fill('.propose input[name=title]', '[TEST] smoke');
      await page.click('.propose button[type=submit]');
      await page.waitForSelector('.tt-cell.is-wait', { timeout: 20000 });
      check((await page.locator('#toast').innerText()).startsWith('¡Enviado!'), 'proposal sent, confirmation shown');
      await page.reload();
      await page.waitForSelector('.tt-row[id^="d-"]');
      check(await page.locator('.tt-cell.is-plan', { hasText: '[TEST] smoke' }).count() === 0, 'pending proposal is not shown as a plan');
    }
    check(errors.length === 0, `${colorScheme}: no script errors ` + errors.join(' | '));
  }
}

await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
