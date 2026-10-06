// End-to-end browser test of both pages against the Firebase emulators:
// admin setup -> friend proposes -> admin approves (private) -> admin opens it
// -> second friend joins -> admin reserves gym time (private, then open) ->
// .ics export -> invite-code rotation.
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
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

// Minimal static server for the repository root.
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(root, name === '/' ? 'index.html' : name);
  if (!file.startsWith(root) || !fs.existsSync(file)) return res.writeHead(404).end();
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type.startsWith('font') ? type : type + '; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const check = (ok, name) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };
const errors = [];

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
async function open(url, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(base + url);
  return page;
}
const shot = (page, name, fullPage = false) => shots && page.screenshot({ path: path.join(shots, name + '.png'), fullPage });
const cell = (page, date, index = 0) => page.locator(`#d-${date} .tt-cell`).nth(index);
// The friends' page first shows its saved copy; wait for the fresh data.
const FRESH = '#calendar[aria-busy="false"]';
const reloaded = async (page, selector = FRESH) => { await page.reload(); await page.waitForSelector(selector, { state: 'attached' }); };
// Everything a friend's page holds, visible or not.
const pageText = (page) => page.evaluate(() => document.body.textContent);

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
  check(await admin.locator('.tt-row[id^="d-"]').count() === 20, 'admin timetable has 20 days');
  const weekSizes = await admin.locator('.tt-week').evaluateAll((weeks) => weeks.map((w) => w.querySelectorAll('.tt-row[id]').length));
  check(weekSizes.join() === '7,7,6', `timetable shows at most 7 days at a time (${weekSizes.join('+')})`);
  check(await admin.locator('#blocked .groups > li').count() === 5, 'seed blocks are grouped by label');

  // ---- Friend 1 proposes
  const friendUrl = `/?emulator&c=${code}`;
  const caro = await open(friendUrl);
  check(await caro.locator('#status .critter.on').count() === 1, 'one loader animal shows while the page loads');
  await caro.waitForSelector(FRESH);
  check(await caro.locator('.tt-row[id^="d-"]').count() === 20, 'friend timetable has 20 days');
  check(await caro.locator('#d-2026-12-14 .tt-cell').count() === 1
    && (await cell(caro, '2026-12-14').innerText()) === 'Llegando a Cochabamba (21:55)', '14 Dec is one all-day block with its label');
  await caro.getByRole('button', { name: '28 dic al 2 ene' }).click();
  await caro.waitForFunction(() => document.querySelector('.tt-tab:last-child').getAttribute('aria-pressed') === 'true');
  check(await cell(caro, '2026-12-31').isVisible(), 'the week buttons scroll to another week');
  await caro.getByRole('button', { name: '14 al 20 dic' }).click();

  await cell(caro, '2026-12-18').click();
  await caro.waitForSelector('#sheet[open] .propose');
  await caro.fill('.propose input[name=name]', 'Caro');
  await caro.fill('.propose input[name=title]', 'Salteñas y café');
  await caro.fill('.propose input[name=place]', 'Zona norte');
  await caro.click('.propose button[type=submit]');
  await caro.waitForSelector('.tt-cell.is-wait');
  check(await caro.locator('.tt-cell.is-plan').count() === 0, 'proposal is pending, not shown as a plan');
  check((await caro.innerText('#toast')).startsWith('¡Enviado!'), 'confirmation message shown');

  const luis = await open(friendUrl, { colorScheme: 'dark' });
  await luis.waitForSelector(FRESH);
  check(await luis.locator('.tt-cell.is-plan, .tt-cell.is-wait').count() === 0, 'other friends see nothing before approval');

  // ---- Admin approves: private by default
  await reloaded(admin, '#pending .entry');
  check(await admin.locator('#pending .entry').count() === 1, 'admin sees 1 proposal to confirm');
  await admin.locator('#pending').getByRole('button', { name: 'Aprobar' }).click();
  await admin.waitForSelector('#tt .tt-cell.is-plan');
  check((await admin.innerText('#toast')) === 'Aprobado. Solo Caro y tú lo ven.', 'approval is private by default');

  await reloaded(luis);
  const luisCell = cell(luis, '2026-12-18');
  check((await luisCell.innerText()) === 'Ocupado', 'another friend sees only "Ocupado" in that slot');
  const luisText = await pageText(luis);
  check(!luisText.includes('Salteñas') && !luisText.includes('Caro'), 'the page of another friend holds neither the plan nor the name');
  await luisCell.click();
  await luis.waitForSelector('#sheet[open]');
  check(await luis.locator('#sheet-body form').count() === 0, 'a private slot offers no form: no join, no proposal');
  await shot(luis, 'friend-private-dark');
  await luis.click('#sheet-close');

  await reloaded(caro);
  check((await cell(caro, '2026-12-18').innerText()).replace(/\s+/g, ' ') === 'Salteñas y café Confirmado', 'the proposer sees their own plan as confirmed');
  check((await caro.innerText('#summary')).includes('Tienes 1 plan con Jose'), 'the proposer\'s summary counts it');

  // ---- Admin opens the plan; now others see it and can join
  await cell(admin, '2026-12-18').click();
  await admin.waitForSelector('#sheet[open] .entry.is-plan');
  await shot(admin, 'admin-plan-private');
  await admin.locator('#sheet-body').getByRole('button', { name: 'Hacer abierto' }).click();
  await admin.waitForSelector('#tt .tt-cell.is-plan.is-open');
  await admin.click('#sheet-close');

  await reloaded(luis);
  check((await cell(luis, '2026-12-18').innerText()).includes('Caro'), 'once open, the plan is visible with who comes');
  await cell(luis, '2026-12-18').click();
  await luis.fill('.join input[name=name]', 'Luis');
  await luis.getByRole('button', { name: 'Me apunto' }).click();
  await luis.waitForSelector('.done');
  check((await luis.innerText('#sheet-body')).includes('Vienen: Caro, Luis'), 'second friend joined');
  await luis.click('#sheet-close');

  // ---- Admin: people summary, reserve gym on weekday mornings (private), export
  await reloaded(admin, '.people > li');
  check(await admin.locator('.people > li').count() === 2, 'people summary lists both friends');

  await cell(admin, '2026-12-15').click();
  await admin.waitForSelector('#sheet[open] .reserve');
  await admin.getByRole('button', { name: 'Gimnasio' }).click();
  await admin.selectOption('.reserve select[name=repeat]', 'weekdays');
  await shot(admin, 'admin-reserve');
  await admin.locator('.reserve button[type=submit]').click();
  await admin.waitForSelector('#tt .tt-cell.is-own');
  const toast = await admin.innerText('#toast');
  check(toast === 'Reservado en 12 espacios. 3 ya estaban reservados. 1 choca con un plan confirmado.', `gym reserved on free weekday mornings ("${toast}")`);
  check(await admin.locator('#tt .tt-cell.is-alert').count() === 1, 'reservation over a confirmed plan is flagged as a clash');
  await shot(admin, 'admin-top');
  await shot(admin, 'admin-full', true);

  await reloaded(caro);
  check((await cell(caro, '2026-12-15').innerText()) === 'Ocupado', 'friends see the private gym time as "Ocupado"');
  check(!(await pageText(caro)).includes('Gimnasio'), 'the friend\'s page does not hold the word "Gimnasio"');
  await cell(caro, '2026-12-15').click();
  await caro.waitForSelector('#sheet[open]');
  check(await caro.locator('#sheet-body form').count() === 0, 'reserved slot offers no form');
  await caro.click('#sheet-close');
  await shot(caro, 'friend-top');
  await shot(caro, 'friend-full', true);

  // ---- Admin makes the gym time open: now friends see the label
  await admin.locator('#blocked li', { hasText: 'Gimnasio' }).getByRole('button', { name: 'Hacer abierto' }).click();
  await admin.waitForSelector('#tt .tt-cell.is-own.is-open');
  await reloaded(caro);
  check((await cell(caro, '2026-12-15').innerText()) === 'Gimnasio', 'once open, friends see "Gimnasio"');

  // ---- Admin adds an open event of his own that friends can join
  await admin.getByRole('button', { name: '28 dic al 2 ene' }).click();
  await cell(admin, '2026-12-30', 3).click();
  await admin.waitForSelector('#sheet[open] .reserve');
  await admin.fill('.reserve input[name=label]', 'Fiesta de fin de año');
  await admin.selectOption('.reserve select[name=who]', 'join');
  await admin.locator('.reserve button[type=submit]').click();
  await admin.waitForSelector('#d-2026-12-30 .tt-cell.is-plan.is-open');
  await reloaded(luis);
  await cell(luis, '2026-12-30', 3).click();
  await luis.waitForSelector('#sheet[open] .join');
  await luis.getByRole('button', { name: 'Me apunto' }).click();
  await luis.waitForSelector('.done');
  check((await luis.innerText('#sheet-body')).includes('Fiesta de fin de año') && (await luis.innerText('#sheet-body')).includes('Vienen: Luis'), 'a friend joins Jose\'s open event');
  await shot(luis, 'friend-dark');
  await luis.click('#sheet-close');

  const [download] = await Promise.all([admin.waitForEvent('download'), admin.click('#export')]);
  const ics = fs.readFileSync(await download.path(), 'utf8');
  check(ics.includes('BEGIN:VTIMEZONE') && ics.includes('TZID:America/La_Paz'), '.ics has the La Paz time zone');
  check(ics.includes('DTSTART;TZID=America/La_Paz:20261218T100000') && ics.includes('DTEND;TZID=America/La_Paz:20261218T123000'), '.ics uses the slot times');
  check(ics.includes('SUMMARY:Salteñas y café') && ics.replace(/\r\n /g, '').includes('Vienen: Caro\\, Luis'), '.ics has the plan and its participants');
  check((ics.match(/SUMMARY:Gimnasio/g) || []).length === 12, '.ics has the 12 gym sessions');
  check(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75), '.ics lines are folded to 75 octets');

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
