// End-to-end browser test of both pages against the Firebase emulators:
// admin setup -> friend proposes -> admin approves -> second friend joins ->
// admin reserves gym time -> .ics export.
//
//   npm i --no-save playwright-core
//   npm run test:e2e          (Java 21+)   or   npm run test:e2e:java17
//
// Set SHOTS_DIR to also save screenshots.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.SHOTS_DIR;
const PROJECT = 'demo-bolivia-hangouts';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// Minimal static server for the repository root.
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(root, name === '/' ? 'index.html' : name);
  if (!file.startsWith(root) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const check = (ok, name) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
const errors = [];

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
async function open(url, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, ...options });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(base + url);
  return page;
}
const shot = (page, name, fullPage = true) => shots && page.screenshot({ path: path.join(shots, name + '.png'), fullPage });

try {
  // ---- Admin: sign in (fake Google account in the Auth emulator), become admin, set up
  const admin = await open('/admin.html?emulator');
  await admin.waitForSelector('#login:not([hidden])');
  const uid = await admin.evaluate(async () => {
    const { auth } = await import(location.origin + '/common.js');
    const m = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js');
    const token = JSON.stringify({ sub: 'jose-1', email: 'jose@example.com', email_verified: true });
    return (await m.signInWithCredential(auth, m.GoogleAuthProvider.credential(token))).user.uid;
  });
  await admin.waitForSelector('#not-admin:not([hidden])');
  check((await admin.innerText('#uid')) === uid, 'signed-in non-admin sees their uid and no panel');

  // The `admins` document cannot be written by any client: use the emulator's owner access.
  const put = await fetch(`http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents/admins/${uid}`, {
    method: 'PATCH', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: '{"fields":{}}',
  });
  check(put.ok, 'admins document created with owner access');
  await admin.reload();
  await admin.waitForSelector('#setup:not([hidden])');
  await admin.click('#setup-btn');
  await admin.waitForSelector('#panel:not([hidden])');
  const link = await admin.innerText('#link');
  const code = new URL(link).searchParams.get('c');
  check(/^[A-Za-z0-9]{20}$/.test(code), 'setup created a 20-character invite code');
  check(await admin.locator('.cal-day').count() === 20, 'admin calendar has 20 days');
  check(await admin.locator('#blocked .groups > li').count() >= 4, 'seed blocks are listed');

  // ---- Friend 1 proposes
  const friendUrl = `/?emulator&c=${code}`;
  const caro = await open(friendUrl);
  await caro.waitForSelector('#name-dialog[open]');
  await caro.fill('#name-form input[name=name]', 'Caro');
  await caro.click('#name-form button[type=submit]');
  check(await caro.locator('.day').count() === 20, 'friend sees 20 day cards');
  check(await caro.locator('.cal-day').count() === 20, 'friend calendar has 20 days');
  check((await caro.locator('p.blocked').first().innerText()) === 'Llegando a Cochabamba (21:55)', '14 Dec is blocked with its label');
  await caro.locator('.cal-day').nth(4).click();
  await caro.locator('#day-2026-12-18').getByRole('button', { name: 'Proponer plan' }).first().click();
  await caro.fill('#propose-form input[name=title]', 'Salteñas y café');
  await caro.fill('#propose-form input[name=place]', 'Zona norte');
  await caro.click('#propose-send');
  await caro.waitForSelector('p.pending');
  check(await caro.locator('div.hangout').count() === 0, 'proposal is pending, not shown as a plan');
  check(await caro.locator('.cal .bar.pending').count() === 1, 'friend calendar marks their pending proposal');

  // Another friend must not see it at all.
  const luis = await open(friendUrl, { colorScheme: 'dark' });
  await luis.waitForSelector('#name-dialog[open]');
  await luis.fill('#name-form input[name=name]', 'Luis');
  await luis.click('#name-form button[type=submit]');
  check(await luis.locator('div.hangout, p.pending').count() === 0, 'other friends see nothing before approval');

  // ---- Admin approves
  await admin.reload();
  await admin.waitForSelector('#panel:not([hidden])');
  check((await admin.innerText('#pending-count')) === '1', 'admin sees 1 pending');
  check(await admin.locator('.cal-badge').count() === 1, 'admin calendar shows a pending badge');
  await shot(admin, 'admin-pending');
  await admin.locator('#pending').getByRole('button', { name: 'Aprobar' }).click();
  await admin.waitForSelector('#approved .item');
  check((await admin.innerText('#pending-count')) === '0', 'pending list is empty after approval');

  // ---- Friend 2 sees it and joins
  await luis.reload();
  await luis.waitForSelector('div.hangout');
  check((await luis.locator('.hangout-people').innerText()).includes('Caro'), 'approved plan is visible with the proposer');
  await luis.getByRole('button', { name: 'Me apunto' }).click();
  await luis.waitForSelector('.joined');
  check((await luis.locator('.hangout-people').innerText()) === 'Vienen: Caro, Luis', 'second friend joined');
  await luis.getByRole('button', { name: 'Mis planes' }).click();
  check(await luis.locator('.day').count() === 1, '"Mis planes" filter shows only that day');
  await luis.getByRole('button', { name: 'Todos los días' }).click();

  // ---- Admin: people summary, reserve gym on weekday mornings, day view, export
  await admin.reload();
  await admin.waitForSelector('#panel:not([hidden])');
  check(await admin.locator('.people > li').count() === 2, 'people summary lists both friends');
  check((await admin.locator('.person-count').first().innerText()).startsWith('1 vez'), 'people summary counts hangouts');

  await admin.click('#reserve-open');
  await admin.getByRole('button', { name: 'Gimnasio' }).click();
  await admin.selectOption('#reserve-form select[name=slot]', 'manana');
  await admin.getByRole('button', { name: 'Lun–Vie' }).click();
  await shot(admin, 'admin-reserve', false);
  await admin.locator('#reserve-form button[type=submit]').click();
  await admin.waitForSelector('#blocked .tag.personal');
  const toast = await admin.innerText('#toast');
  check(/Reservado: 12 · 3 ya ocupados · ojo: 1 con planes/.test(toast), `gym reserved on free weekday mornings ("${toast}")`);
  check(await admin.locator('.cal .bar.conflict').count() === 1, 'reservation over a confirmed plan shows as a conflict');
  check(await admin.locator('#approved .item.conflict').count() === 1, 'the confirmed plan is flagged');
  await shot(admin, 'admin-panel');

  await admin.locator('.cal-day').nth(1).click();
  await admin.waitForSelector('#day-dialog[open]');
  check((await admin.locator('#day-body .personal').innerText()).includes('Gimnasio'), 'day view shows the reservation');
  await shot(admin, 'admin-day', false);
  await admin.click('#day-close');

  const [download] = await Promise.all([admin.waitForEvent('download'), admin.click('#export')]);
  const ics = fs.readFileSync(await download.path(), 'utf8');
  check(ics.includes('BEGIN:VTIMEZONE') && ics.includes('TZID:America/La_Paz'), '.ics has the La Paz time zone');
  check(ics.includes('DTSTART;TZID=America/La_Paz:20261218T100000') && ics.includes('DTEND;TZID=America/La_Paz:20261218T123000'), '.ics uses the slot times');
  check(ics.includes('SUMMARY:Salteñas y café') && ics.replace(/\r\n /g, '').includes('Vienen: Caro\\, Luis'), '.ics has the plan and its participants');
  check((ics.match(/SUMMARY:Gimnasio/g) || []).length === 12, '.ics has the 12 gym sessions');
  check(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75), '.ics lines are folded to 75 octets');

  // ---- Friends see the reservation and cannot propose there
  await caro.reload();
  await caro.waitForSelector('p.personal');
  const tuesday = caro.locator('#day-2026-12-15 .slot').first();
  check((await tuesday.locator('.personal').innerText()).includes('Gimnasio'), 'friend sees "Jose · Gimnasio"');
  check(await tuesday.locator('button').count() === 0, 'reserved slot has no "Proponer" button');
  check((await caro.locator('.stat strong').nth(2).innerText()) === '1', 'friend stat: 1 plan with them');
  await shot(caro, 'friend-light', false);
  await caro.locator('#day-2026-12-18').scrollIntoViewIfNeeded();
  await caro.evaluate(() => document.getElementById('day-2026-12-17').scrollIntoView());
  await shot(caro, 'friend-days', false);
  await luis.reload();
  await luis.waitForSelector('p.personal');
  await shot(luis, 'friend-dark', false);

  // ---- Rotating the code locks friends out
  await admin.click('#rotate');
  await admin.waitForFunction((old) => document.getElementById('link').textContent !== old, link);
  await caro.reload();
  await caro.waitForSelector('#gate:not([hidden])');
  check(await caro.isHidden('#calendar'), 'old link shows only "Pídele el enlace a Jose" after rotation');

  check(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (error) {
  failed++;
  console.log('FAIL  test aborted: ' + error.message.split('\n')[0]);
  if (errors.length) console.log('      page errors: ' + errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);
