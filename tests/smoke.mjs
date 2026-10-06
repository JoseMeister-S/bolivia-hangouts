// Browser smoke test of the friends' page (headless Edge/Chrome through
// playwright-core, which is not a dependency: `npm i --no-save playwright-core`).
//
//   node tests/smoke.mjs http://localhost:5500            -> gate + login screens
//   INVITE_CODE=xxx node tests/smoke.mjs <base-url>       -> also the friend flow
//
// With a code it sends one proposal titled "[TEST] smoke". Delete it in admin.html.
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
  return { page, errors, context };
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
  if (shots) await page.screenshot({ path: `${shots}/admin-login.png` });
}

if (code) {
  for (const colorScheme of ['light', 'dark']) {
    const { page, errors } = await open('/?c=' + encodeURIComponent(code), { colorScheme });
    await page.waitForSelector('#name-dialog[open]', { timeout: 20000 });
    await page.fill('#name-form input[name=name]', 'Prueba');
    await page.click('#name-form button[type=submit]');
    check(await page.locator('.day').count() === 20, `${colorScheme}: 20 day cards`);
    check(await page.locator('.blocked').first().innerText() === 'Llegando a Cochabamba (21:55)', `${colorScheme}: 14 Dec is blocked with its label`);
    check(await page.locator('.day').first().locator('button').count() === 0, `${colorScheme}: blocked day has no "Proponer" button`);
    if (shots) await page.screenshot({ path: `${shots}/friends-${colorScheme}.png`, fullPage: false });

    if (colorScheme === 'light') {
      await page.locator('.day').nth(4).getByRole('button', { name: 'Proponer plan' }).first().click();
      await page.fill('#propose-form input[name=title]', '[TEST] smoke');
      await page.fill('#propose-form input[name=place]', 'Café de prueba');
      if (shots) await page.screenshot({ path: `${shots}/propose.png` });
      await page.click('#propose-send');
      await page.waitForSelector('.pending', { timeout: 20000 });
      check((await page.locator('#toast').innerText()).startsWith('¡Enviado!'), 'proposal sent, confirmation shown');
      check(await page.locator('.hangout', { hasText: '[TEST] smoke' }).count() === 0, 'pending proposal is not shown as a hangout');
      await page.reload();
      await page.waitForSelector('.day');
      check(await page.locator('.hangout', { hasText: '[TEST] smoke' }).count() === 0, 'still not visible after reload');
      check(await page.locator('#name-dialog[open]').count() === 0, 'name is remembered');
    }
    check(errors.length === 0, `${colorScheme}: no script errors ` + errors.join(' | '));
  }
}

await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
