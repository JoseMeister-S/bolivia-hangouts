// End-to-end browser test of both pages against the Firebase emulators:
// admin setup -> friend proposes -> admin approves (private) -> admin opens it
// -> second friend joins -> admin reserves gym time (private, then open) ->
// .ics export -> edits that the proposer follows -> reject, reconsider and
// delete -> participants -> honeypot -> name clash -> removing reservations
// -> invite-code rotation.
//
//   npm i --no-save playwright-core
//   npm run test:e2e          (Java 21+)   or   npm run test:e2e:java17
//
// The pages run on a fixed date (TODAY) before the trip, so the result does
// not depend on the day the test runs. Set SHOTS_DIR to also save screenshots.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, PHONE, FRESH, checks } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.SHOTS_DIR;
const PROJECT = 'demo-bolivia-hangouts';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
// Before the trip, and before the real date: Auth tokens issued now must not
// look expired to the page.
const TODAY = new Date('2026-10-01T12:00:00-04:00');

// Minimal static server for the repository root.
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(root, name === '/' ? 'index.html' : name);
  if (!file.startsWith(root)) return res.writeHead(404).end();
  // Like GitHub Pages: a missing file gets 404.html, with status 404.
  const found = fs.existsSync(file) && fs.statSync(file).isFile();
  const served = found ? file : path.join(root, '404.html');
  const type = TYPES[path.extname(served)] || 'application/octet-stream';
  res.writeHead(found ? 200 : 404, { 'content-type': type.startsWith('font') ? type : type + '; charset=utf-8' });
  fs.createReadStream(served).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const { check, fail, finish } = checks();
const errors = [];

const browser = await launch();
// page.answer(text) queues the reply to the next prompt(); confirm() is accepted.
async function open(url, options = {}) {
  const context = await browser.newContext({ ...PHONE, acceptDownloads: true, reducedMotion: 'reduce', ...options });
  await context.clock.setFixedTime(TODAY);
  const page = await context.newPage();
  const answers = [];
  page.answer = (text) => answers.push(text);
  page.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  page.on('dialog', (dialog) => dialog.accept(dialog.type() === 'prompt' ? answers.shift() ?? '' : undefined));
  await page.goto(base + url);
  return page;
}
const shot = (page, name, fullPage = false) => shots && page.screenshot({ path: path.join(shots, name + '.png'), fullPage });
const cell = (page, date, index = 0) => page.locator(`#d-${date} .tt-cell`).nth(index);
const cellText = async (page, date, index = 0) => (await cell(page, date, index).innerText()).replace(/\s+/g, ' ');
const cellHas = (page, date, index, className) =>
  cell(page, date, index).evaluate((node, name) => node.classList.contains(name), className);
// Waits until a cell has (or, with not = true, lacks) a class: the page re-rendered after a write.
const cellBecomes = (page, date, index, className, not = false) => page.waitForFunction(
  ([d, i, name, negate]) => document.querySelectorAll(`#d-${d} .tt-cell`)[i]?.classList.contains(name) !== negate,
  [date, index, className, not]);
const reloaded = async (page, selector = FRESH) => { await page.reload(); await page.waitForSelector(selector, { state: 'attached' }); };
// Everything a friend's page holds, visible or not, and what it saved for the next visit.
const pageText = (page) => page.evaluate(() => document.body.textContent);
const savedCopy = (page) => page.evaluate(() => localStorage.getItem('bh_cache') || '');
const toastIs = (page, start) => page.waitForFunction((text) => document.getElementById('toast')?.textContent.startsWith(text), start);
const inSheet = (page, name) => page.locator('#sheet-body').getByRole('button', { name, exact: true });
// The emulator's REST API with owner access (no rules): reads, or writes when given fields.
const rest = async (docPath, method = 'GET', fields) => (await fetch(
  `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents/${docPath}`,
  { method, headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: fields && JSON.stringify({ fields }) },
)).json();

try {
  // ---- Admin: sign in (fake Google account in the Auth emulator), become admin, set up
  const admin = await open('/admin.html?emulator');
  await admin.waitForSelector('#login:not([hidden])');
  const uid = await admin.evaluate(async () => {
    const { auth } = await import(location.origin + '/common.js');
    const m = await import('firebase/auth');
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
  check(await admin.locator('#reservations .groups > li').count() === 5, 'seed blocks are grouped by label');

  // ---- Friend 1 proposes
  const friendUrl = `/?emulator&c=${code}`;
  const caro = await open(friendUrl);
  check(await caro.locator('#status .critter').count() === 1, 'one loader animal shows while the page loads');
  await caro.waitForSelector(FRESH);
  check(await caro.locator('.tt-row[id^="d-"]').count() === 20, 'friend timetable has 20 days');
  check(await caro.locator('#d-2026-12-14 .tt-cell').count() === 1
    && (await cellText(caro, '2026-12-14')) === 'Llegando a Cochabamba (21:55)', '14 Dec is one all-day block with its label (set up in the same batch)');
  check((await caro.innerText('#lede')).includes('Faltan 74 días'), 'the countdown runs on the fixed test date');
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
  check((await cellText(caro, '2026-12-18')) === 'Salteñas y café Confirmado', 'the proposer sees their own plan as confirmed');
  check((await caro.innerText('#summary')).includes('Tienes 1 plan con Jose'), 'the proposer\'s summary counts it');

  // ---- Admin opens the plan; now others see it and can join
  await cell(admin, '2026-12-18').click();
  await admin.waitForSelector('#sheet[open] .entry.is-plan');
  await shot(admin, 'admin-plan-private');
  await inSheet(admin, 'Hacer abierto').click();
  await admin.waitForSelector('#tt .tt-cell.is-plan.is-open');
  await admin.click('#sheet-close');

  await reloaded(luis);
  check((await cellText(luis, '2026-12-18')).includes('Caro'), 'once open, the plan is visible with who comes');
  await cell(luis, '2026-12-18').click();
  await luis.fill('.join input[name=name]', 'Luis');
  await luis.getByRole('button', { name: 'Me apunto' }).click();
  await luis.waitForSelector('.done');
  check((await luis.innerText('#sheet-body')).includes('Vienen: Caro, Luis'), 'second friend joined');
  await luis.click('#sheet-close');
  await reloaded(caro);
  check(await caro.locator('.tt-cell', { hasText: 'Salteñas y café' }).count() === 1, 'the proposer sees the opened plan once, not twice');

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
  check((await cellText(caro, '2026-12-15')) === 'Ocupado', 'friends see the private gym time as "Ocupado"');
  check(!(await pageText(caro)).includes('Gimnasio'), 'the friend\'s page does not hold the word "Gimnasio"');
  const markers = JSON.parse(await savedCopy(caro)).blocked.map(([, marker]) => marker);
  check(markers.length > 0 && markers.every((m) => m.label || m.kind === 'busy'),
    'private markers carry only the neutral kind "busy" (no hint of what they are)');
  await cell(caro, '2026-12-15').click();
  await caro.waitForSelector('#sheet[open]');
  check(await caro.locator('#sheet-body form').count() === 0, 'reserved slot offers no form');
  await caro.click('#sheet-close');
  await shot(caro, 'friend-top');
  await shot(caro, 'friend-full', true);

  // ---- Admin makes the gym time open: now friends see the label
  await admin.locator('#reservations li', { hasText: 'Gimnasio' }).getByRole('button', { name: 'Hacer abierto' }).click();
  await admin.waitForSelector('#tt .tt-cell.is-own.is-open');
  await reloaded(caro);
  check((await cellText(caro, '2026-12-15')) === 'Gimnasio', 'once open, friends see "Gimnasio"');

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

  // ---- The host edits a proposal before and after approving it; the proposer follows
  const D = '2026-12-20'; // a Sunday: no gym, four free slots
  await admin.getByRole('button', { name: '14 al 20 dic' }).click();
  await caro.getByRole('button', { name: '14 al 20 dic' }).click();
  await cell(caro, D, 2).click();
  await caro.waitForSelector('#sheet[open] .propose');
  await caro.fill('.propose input[name=title]', 'Fútbol');
  await caro.fill('.propose textarea[name=note]', 'Nota secreta para Jose');
  await caro.click('.propose button[type=submit]');
  await cellBecomes(caro, D, 2, 'is-wait');

  await reloaded(admin, '#pending .entry');
  await admin.locator('#pending .entry', { hasText: 'Fútbol' }).getByRole('button', { name: 'Editar' }).click();
  await admin.waitForSelector('#edit-dialog[open]');
  await admin.selectOption('#edit-form select[name=slot]', 'noche');
  await admin.click('#edit-form button[type=submit]');
  await cellBecomes(admin, D, 3, 'is-wait');
  await reloaded(caro);
  check(await cellHas(caro, D, 3, 'is-wait') && await cellHas(caro, D, 2, 'is-free'), 'the proposer sees their proposal where the host moved it');

  await admin.locator('#pending .entry', { hasText: 'Fútbol' }).getByRole('button', { name: 'Aprobar' }).click();
  await cellBecomes(admin, D, 3, 'is-plan');
  await cell(admin, D, 3).click();
  await admin.waitForSelector('#sheet[open] .entry.is-plan');
  check((await admin.innerText('#sheet-body')).includes('«Nota secreta para Jose»'), 'the host still reads the note');
  await inSheet(admin, 'Editar').click();
  await admin.waitForSelector('#edit-dialog[open]');
  await admin.selectOption('#edit-form select[name=slot]', 'tarde');
  await admin.fill('#edit-form input[name=title]', 'Fútbol y asado');
  await admin.click('#edit-form button[type=submit]');
  await cellBecomes(admin, D, 2, 'is-plan');
  await reloaded(caro);
  check((await cellText(caro, D, 2)) === 'Fútbol y asado Confirmado' && await cellHas(caro, D, 3, 'is-free'),
    'after an edit the proposer sees the new title in the new slot');

  await inSheet(admin, 'Hacer abierto').click();
  await cellBecomes(admin, D, 2, 'is-open');
  await reloaded(luis);
  check((await cellText(luis, D, 2)).startsWith('Fútbol y asado'), 'the opened plan is visible to other friends');
  check(!(await savedCopy(luis)).includes('Nota secreta') && !(await pageText(luis)).includes('Nota secreta'),
    'the note to the host never reaches other friends, not even in the saved copy');

  await inSheet(admin, 'Hacer privado').click();
  await cellBecomes(admin, D, 2, 'is-open', true);
  await reloaded(caro);
  check((await cellText(caro, D, 2)) === 'Fútbol y asado Confirmado', 'opened and made private again: the proposer still sees it');
  await reloaded(luis);
  check((await cellText(luis, D, 2)) === 'Ocupado', 'made private again: other friends see "Ocupado"');

  // ---- Participants, then removing the plan
  admin.answer('Ana');
  await inSheet(admin, 'Añadir persona').click();
  await admin.waitForSelector('#sheet-body .chips li:has-text("Ana")');
  check(true, 'the host adds a participant');
  await admin.locator('#sheet-body').getByRole('button', { name: 'Quitar a Ana' }).click();
  await admin.waitForFunction(() => !document.querySelector('#sheet-body .chips').textContent.includes('Ana'));
  check(true, 'the host removes a participant');
  await inSheet(admin, 'Borrar plan').click();
  await cellBecomes(admin, D, 2, 'is-free');
  await admin.click('#sheet-close');
  await reloaded(caro);
  check(await cellHas(caro, D, 2, 'is-free'), 'a removed plan disappears for the proposer too');

  // ---- Reject, reconsider, reject again, delete
  const T = '2026-12-22'; // Tuesday: the gym takes the morning only
  await luis.getByRole('button', { name: '21 al 27 dic' }).click();
  await cell(luis, T, 3).click();
  await luis.waitForSelector('#sheet[open] .propose');
  await luis.fill('.propose input[name=title]', 'Cine');
  await luis.click('.propose button[type=submit]');
  await cellBecomes(luis, T, 3, 'is-wait');
  await reloaded(admin, '#pending .entry');
  await admin.locator('#pending .entry', { hasText: 'Cine' }).getByRole('button', { name: 'Rechazar' }).click();
  await admin.waitForFunction(() => document.getElementById('rejected-count').textContent === '1');
  await admin.click('summary:has-text("Propuestas rechazadas")');
  await admin.locator('#rejected').getByRole('button', { name: 'Volver a considerar' }).click();
  await admin.waitForSelector('#pending .entry:has-text("Cine")');
  check(await admin.innerText('#rejected-count') === '0', 'a rejected proposal can be reconsidered');
  await reloaded(luis);
  check(await cellHas(luis, T, 3, 'is-wait'), 'the proposer sees a reconsidered proposal as pending');
  await admin.locator('#pending .entry', { hasText: 'Cine' }).getByRole('button', { name: 'Rechazar' }).click();
  await admin.waitForFunction(() => document.getElementById('rejected-count').textContent === '1');
  await admin.locator('#rejected').getByRole('button', { name: 'Borrar' }).click();
  await admin.waitForFunction(() => document.getElementById('rejected-count').textContent === '0');
  check(true, 'a rejected proposal can be deleted');
  await reloaded(luis);
  check(await cellHas(luis, T, 3, 'is-free'), 'the proposer no longer sees a rejected proposal');

  // ---- Honeypot: a bot that fills the hidden field gets a thank-you and sends nothing
  await caro.getByRole('button', { name: '21 al 27 dic' }).click();
  await cell(caro, T, 2).click();
  await caro.waitForSelector('#sheet[open] .propose');
  await caro.fill('.propose input[name=title]', 'Spam');
  await caro.$eval('.propose input[name=website]', (input) => { input.value = 'http://spam.example'; });
  await caro.click('.propose button[type=submit]');
  await toastIs(caro, '¡Enviado!');
  await reloaded(admin, '#panel:not([hidden])');
  check(await admin.locator('#pending .entry').count() === 0 && await cellHas(caro, T, 2, 'is-free'), 'the honeypot sends nothing');

  // ---- Changing the name to one already taken in a plan
  caro.answer('Luis');
  await caro.getByRole('button', { name: 'Cambiar nombre' }).click();
  await caro.waitForFunction(() => document.getElementById('hello').textContent.includes('Luis'));
  await caro.getByRole('button', { name: '28 dic al 2 ene' }).click();
  await cell(caro, '2026-12-30', 3).click();
  await caro.waitForSelector('#sheet[open] .entry.is-plan');
  check(await caro.locator('#sheet-body .done').count() === 1, 'a friend with the same name counts as already joined (names are self-declared)');
  await caro.click('#sheet-close');

  // ---- Removing reservations: one slot from the sheet, a whole group from the list
  await admin.getByRole('button', { name: '21 al 27 dic' }).click();
  await cell(admin, '2026-12-24', 2).click(); // Nochebuena: afternoon and night drawn as one
  await admin.waitForSelector('#sheet[open] .entry.is-off');
  await inSheet(admin, 'Quitar reserva').click();
  await admin.waitForFunction(() => document.querySelectorAll('#d-2026-12-24 .tt-cell').length === 4);
  await admin.click('#sheet-close');
  check(await cellHas(admin, '2026-12-24', 2, 'is-free'), 'one reserved slot is removed from the sheet');
  await admin.locator('#reservations li', { hasText: 'Gimnasio' }).getByRole('button', { name: 'Quitar todo' }).click();
  await admin.waitForFunction(() => !document.querySelector('#tt .tt-cell.is-own'));
  await reloaded(caro);
  check(await cellHas(caro, '2026-12-15', 0, 'is-free') && await cellHas(caro, '2026-12-24', 2, 'is-free'),
    'friends see removed reservations as free');

  // ---- Data from the previous version is upgraded when the admin page opens
  // (written with the emulator's owner access, as the live data looks today).
  await rest('settings/main?updateMask.fieldPaths=schema', 'PATCH', { schema: { integerValue: '2' } });
  await rest('hangouts/legacy', 'PATCH', {
    date: { stringValue: '2026-12-29' }, slot: { stringValue: 'noche' }, title: { stringValue: 'Plan antiguo' },
    place: { stringValue: '' }, proposer_name: { stringValue: 'Eva' }, note: { stringValue: 'Nota antigua' }, open: { booleanValue: true },
  });
  await rest('reservations/2026-12-28_noche', 'PATCH', {
    date: { stringValue: '2026-12-28' }, slot: { stringValue: 'noche' }, label: { stringValue: 'Secreto' },
    kind: { stringValue: 'personal' }, open: { booleanValue: false },
  });
  await rest('blocked_slots/2026-12-28_noche', 'PATCH', {
    date: { stringValue: '2026-12-28' }, slot: { stringValue: 'noche' }, label: { stringValue: '' }, kind: { stringValue: 'personal' },
  });
  await reloaded(admin, '#panel:not([hidden])');
  const [settingsDoc, legacyDoc, legacyPrivate, legacyMarker] = await Promise.all(
    ['settings/main', 'hangouts/legacy', 'hangout_private/legacy', 'blocked_slots/2026-12-28_noche'].map((p) => rest(p)));
  check(settingsDoc.fields?.schema?.integerValue === '3', 'upgrade: the schema is now 3');
  check(legacyDoc.fields && !('note' in legacyDoc.fields), 'upgrade: the note left the hangout friends may read');
  check(legacyPrivate.fields?.note?.stringValue === 'Nota antigua', 'upgrade: the note is kept on the private side');
  check(legacyMarker.fields?.kind?.stringValue === 'busy', 'upgrade: an old private marker loses its telling kind');
  await reloaded(luis);
  check((await savedCopy(luis)).includes('Plan antiguo') && !(await savedCopy(luis)).includes('Nota antigua'),
    'upgrade: friends get the old open plan without its note');

  // ---- Rotating the code locks friends out
  await admin.click('#rotate');
  await admin.waitForFunction((old) => document.getElementById('link').textContent !== old, link);
  await caro.reload();
  await caro.waitForSelector('#gate:not([hidden])');
  check(await caro.isHidden('#calendar'), 'old link shows only "Pídele el enlace a Jose" after rotation');

  // ---- A wrong address: the 404 page sends people on, invite code included
  const lostContext = await browser.newContext({ ...PHONE, reducedMotion: 'reduce' });
  await lostContext.clock.install({ time: TODAY });
  const lost = await lostContext.newPage();
  lost.on('pageerror', (e) => errors.push(`404: ${e.message}`));
  const response = await lost.goto(`${base}/a/wrong/path?emulator&c=${code}`);
  check(response.status() === 404 && (await lost.innerText('h1')) === 'Página no encontrada', 'a wrong address answers 404 with the 404 page');
  check(await lost.locator('.lost .critter').count() === 1
    && await lost.evaluate(() => getComputedStyle(document.body).fontFamily.includes('Bricolage')), "the 404 page has its animal and the site's styles, at any depth");
  check(await lost.getAttribute('#go', 'href') === `${base}/?emulator&c=${code}`, 'the 404 link leads to the calendar and keeps the invite code');
  await lost.clock.runFor(10_000);
  await lost.waitForURL(`${base}/?emulator&c=${code}`, { waitUntil: 'commit' });
  check(true, 'after 10 seconds the 404 page goes to the calendar');
  await lost.goto(`${base}/admin`);
  check(await lost.getAttribute('#go', 'href') === `${base}/admin.html` && (await lost.innerText('#go')) === 'Ir al panel',
    'an address that mentions admin leads to the panel');
  await lost.click('#stay');
  await lost.clock.runFor(15_000);
  check(new URL(lost.url()).pathname === '/admin', '"Quedarme aquí" stops the redirect');
  await lostContext.close();

  check(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (error) {
  fail('test aborted: ' + error.message.split('\n')[0]);
  if (errors.length) console.log('      page errors: ' + errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
finish();
