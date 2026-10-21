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
import { launch, PHONE, FRESH, checks, shownText } from './browser.mjs';

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
async function open(url, options = {}) {
  const context = await browser.newContext({ ...PHONE, acceptDownloads: true, reducedMotion: 'reduce', ...options });
  await context.clock.setFixedTime(TODAY);
  // Map tiles are not part of the test: answer them empty.
  await context.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }));
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
  // The pages ask in their own dialogs; a browser pop-up is a bug.
  page.on('dialog', (dialog) => { errors.push(`${url}: browser pop-up "${dialog.message()}"`); dialog.dismiss(); });
  await page.goto(base + url);
  return page;
}
const shot = (page, name, fullPage = false) => shots && page.screenshot({ path: path.join(shots, name + '.png'), fullPage });
const cell = (page, date, index = 0) => page.locator(`#d-${date} .tt-cell`).nth(index);
const cellText = (page, date, index = 0) => shownText(cell(page, date, index));
const cellHas = (page, date, index, className) =>
  cell(page, date, index).evaluate((node, name) => node.classList.contains(name), className);
// Waits until a cell has (or, with not = true, lacks) a class: the page re-rendered after a write.
const cellBecomes = (page, date, index, className, not = false) => page.waitForFunction(
  ([d, i, name, negate]) => document.querySelectorAll(`#d-${d} .tt-cell`)[i]?.classList.contains(name) !== negate,
  [date, index, className, not]);
// Answers the page's own question (ask()): types into its field when given text, then confirms.
async function answer(page, text) {
  await page.waitForSelector('dialog.ask[open]');
  if (text != null) await page.fill('dialog.ask input[name=answer]', text);
  await page.click('dialog.ask button[value=yes]');
  await page.waitForSelector('dialog.ask', { state: 'detached' });
}
// After sending, leaving or withdrawing, the sheet shows what happened: close it.
const done = async (page) => { await page.click('.notice button:has-text("Listo")'); await page.waitForSelector('#sheet:not([open])', { state: 'attached' }); };
// The page as if the friend switched to another app for a minute and came back.
const comeBack = (page) => page.evaluate(() => {
  const now = performance.now.bind(performance);
  const hide = (hidden) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  hide(true);
  performance.now = () => now() + 60_000;
  hide(false);
});
// axe-core, the usual accessibility checker, on what the page shows now.
const AXE = fs.readFileSync(path.join(root, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
async function accessible(page, label) {
  await page.addScriptTag({ content: AXE });
  const { violations } = await page.evaluate(() => window.axe.run(document, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
  }));
  const found = violations.map((v) => `${v.id} x${v.nodes.length} [${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' ; ')}]`);
  check(found.length === 0, `accessible: ${label}` + (found.length ? ' -- ' + found.join(' | ') : ''));
}
const reloaded = async (page, selector = FRESH) => { await page.reload(); await page.waitForSelector(selector, { state: 'attached' }); };
// Everything a friend's page holds, visible or not, and what it saved for the next visit.
const pageText = (page) => page.evaluate(() => document.body.textContent);
const savedCopy = (page) => page.evaluate(() => localStorage.getItem('bh_cache') || '');
const toastIs = (page, start) => page.waitForFunction((text) => document.getElementById('toast')?.textContent.startsWith(text), start);
// Every icon the page links to answers 200 (from wherever the page sits).
async function iconsLoad(page) {
  const links = await page.evaluate(() => [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map((l) => l.href));
  const statuses = await Promise.all(links.map((href) => fetch(href).then((r) => r.status)));
  return links.length === 3 && statuses.every((status) => status === 200);
}
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
  check(await iconsLoad(caro), 'the page icons load');
  check((await caro.getAttribute('meta[property="og:image"]', 'content')).endsWith('/images/social-card.png')
    && fs.existsSync(path.join(root, 'images', 'social-card.png')), 'the link preview points at the card image');
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
  await caro.waitForSelector('.notice');
  const nudge = await caro.locator('.notice').getByRole('link', { name: 'Avisar a Jose por WhatsApp' }).getAttribute('href');
  check(nudge.startsWith('https://wa.me/?text=') && decodeURIComponent(nudge).includes('«Salteñas y café», viernes'),
    'after proposing, a ready WhatsApp message to Jose');
  await done(caro);
  await caro.waitForSelector('.tt-cell.is-wait');
  check(await caro.locator('.tt-cell.is-plan').count() === 0, 'proposal is pending, not shown as a plan');
  check((await caro.innerText('#toast')).startsWith('¡Enviado!'), 'confirmation message shown');
  check((await caro.innerText('#mine-list')).includes('Salteñas y café') && (await caro.innerText('#mine-list')).includes('Por confirmar'),
    '"Tus planes" lists the proposal');
  await accessible(caro, "friends' page, light");
  // Large text (as with the phone's text size at 200%): each day becomes a list.
  await caro.addStyleTag({ content: 'html { font-size: 200% }' });
  const row = await caro.locator('#d-2026-12-18 .tt-cell').first().boundingBox();
  check(await caro.locator('#d-2026-12-18 .tt-when').first().isVisible() && row.width > 300,
    'with large text the timetable becomes a list, one full line per slot');
  await accessible(caro, "friends' page with large text");
  await caro.reload();
  await caro.waitForSelector(FRESH);

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
  check((await shownText(luisCell)) === 'Ocupado', 'another friend sees only "Ocupado" in that slot');
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
  await done(caro);
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
  await inSheet(admin, 'Añadir persona').click();
  await answer(admin, 'Ana');
  await admin.waitForSelector('#sheet-body .chips li:has-text("Ana")');
  check(true, 'the host adds a participant');
  await admin.locator('#sheet-body').getByRole('button', { name: 'Quitar a Ana' }).click();
  await answer(admin);
  await admin.waitForFunction(() => !document.querySelector('#sheet-body .chips').textContent.includes('Ana'));
  check(true, 'the host removes a participant');
  const tell = await admin.locator('#sheet-body').getByRole('link', { name: 'Avisar por WhatsApp' }).getAttribute('href');
  check(decodeURIComponent(tell).includes('¡Confirmado! «Fútbol y asado»'), 'the host can tell people about a plan on WhatsApp');
  await accessible(admin, 'admin sheet with a plan');
  await inSheet(admin, 'Borrar plan').click();
  await answer(admin);
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
  await done(luis);
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
  check(decodeURIComponent(await admin.locator('#rejected').getByRole('link', { name: 'Avisar a Luis' }).getAttribute('href'))
    .includes('esta vez no puedo con «Cine»'), 'the host can tell the proposer about a rejection');
  await admin.locator('#rejected').getByRole('button', { name: 'Borrar' }).click();
  await answer(admin);
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
  await caro.getByRole('button', { name: 'Cambiar nombre' }).click();
  await accessible(caro, 'the name question');
  await answer(caro, 'Luis');
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
  await answer(admin);
  await admin.waitForFunction(() => !document.querySelector('#tt .tt-cell.is-own'));
  await reloaded(caro);
  check(await cellHas(caro, '2026-12-15', 0, 'is-free') && await cellHas(caro, '2026-12-24', 2, 'is-free'),
    'friends see removed reservations as free');

  // ---- A plan with a limit and a place: inviting while it has room, "Ocupado" once full
  const G = '2026-12-23'; // a Wednesday; the gym mornings are gone by now
  await caro.getByRole('button', { name: 'Cambiar nombre' }).click();
  await answer(caro, 'Caro');
  await caro.waitForFunction(() => document.getElementById('hello').textContent.includes('Caro'));
  await caro.getByRole('button', { name: '21 al 27 dic' }).click();
  await cell(caro, G, 3).click();
  await caro.waitForSelector('#sheet[open] .propose');
  await caro.fill('.propose input[name=title]', 'Juegos de mesa');
  await caro.fill('.propose input[name=capacity]', '3'); // Jose, Caro and one more
  await caro.fill('.propose input[name=map_url]',
    'https://www.google.com/maps/place/Ludoteca/@-17.38,-66.15,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d-17.3934!4d-66.1571');
  await caro.waitForFunction(() => document.querySelector('.propose .place-picker .hint').textContent.startsWith('Pin puesto'));
  // The pin is drawn once the map has loaded, a moment after the link is read.
  await caro.waitForSelector('.propose .leaflet-marker-icon');
  check(await caro.locator('.propose .leaflet-marker-icon').count() === 1, 'a pasted Google Maps link drops the pin on the map');
  await accessible(caro, 'the proposal form with a map');
  await caro.click('.propose button[type=submit]');
  await done(caro);
  await cellBecomes(caro, G, 3, 'is-wait');

  await reloaded(admin, '#pending .entry');
  const proposal = admin.locator('#pending .entry', { hasText: 'Juegos de mesa' });
  check((await proposal.innerText()).includes('Hasta 3 personas') && await proposal.locator('.place .map').count() === 1,
    'the host sees the limit and the place of a proposal');
  await proposal.locator('input[type=checkbox]').check();
  await proposal.getByRole('button', { name: 'Aprobar' }).click();
  await cellBecomes(admin, G, 3, 'is-plan');

  await reloaded(luis);
  await luis.getByRole('button', { name: '21 al 27 dic' }).click();
  check(await cellHas(luis, G, 3, 'is-joinable'), 'an open plan with room looks joinable');
  check(!(await cellHas(luis, '2026-12-18', 0, 'is-joinable')), 'a plan the friend is already in does not');
  await cell(luis, G, 3).click();
  await luis.waitForSelector('#sheet[open] .join');
  check((await luis.innerText('#sheet-body')).includes('Queda 1 plaza') && await luis.locator('#sheet-body .place').count() === 0,
    'before joining: one place left, and no map');
  await luis.getByRole('button', { name: 'Me apunto' }).click();
  await luis.waitForSelector('#sheet-body .done');
  await luis.waitForSelector('#sheet-body .place .leaflet-marker-icon');
  const google = await luis.locator('#sheet-body').getByRole('link', { name: 'Abrir en Google Maps' }).getAttribute('href');
  const apple = await luis.locator('#sheet-body').getByRole('link', { name: 'Abrir en Apple Maps' }).getAttribute('href');
  check(google.includes('query=-17.3934%2C-66.1571') && apple.startsWith('https://maps.apple.com/?ll=-17.3934%2C-66.1571'),
    'once in, the friend sees the map and can open it in Google Maps or Apple Maps');
  await shot(luis, 'friend-place');
  await accessible(luis, 'a joined plan with its map, dark');
  await luis.click('#sheet-close');
  check((await cellText(luis, G, 3)).startsWith('Juegos de mesa') && !(await cellHas(luis, G, 3, 'is-joinable')),
    'the joiner still sees the full plan');

  const ana = await open(friendUrl);
  await ana.waitForSelector(FRESH);
  check((await cellText(ana, G, 3)) === 'Ocupado' && !(await cellHas(ana, G, 3, 'is-joinable')), 'a full plan is "Ocupado" for the rest');
  check(!(await pageText(ana)).includes('Juegos de mesa') && !(await savedCopy(ana)).includes('Juegos de mesa'),
    'a friend who is not in it holds nothing of the full plan');
  await ana.getByRole('button', { name: '21 al 27 dic' }).click();
  await cell(ana, G, 3).click();
  await ana.waitForSelector('#sheet[open]');
  check(await ana.locator('#sheet-body form').count() === 0, 'a full plan offers no form');
  await shot(ana, 'friend-full-plan');

  await reloaded(caro);
  await caro.getByRole('button', { name: '21 al 27 dic' }).click();
  check((await cellText(caro, G, 3)) === 'Juegos de mesa Completo', 'the proposer still sees the full plan');
  await cell(caro, G, 3).click();
  await caro.waitForSelector('#sheet-body .place .leaflet-marker-icon');
  check(true, 'and its place');
  await caro.click('#sheet-close');

  await reloaded(admin, '#panel:not([hidden])');
  await admin.getByRole('button', { name: '21 al 27 dic' }).click();
  await cell(admin, G, 3).click();
  await admin.waitForSelector('#sheet[open] .entry.is-plan');
  check((await admin.innerText('#sheet-body')).includes('Completo: 3 personas'), 'the host sees that the plan is full');

  // ---- The host makes a plan from a short link (no coordinates): tap the map
  await admin.click('#sheet-close');
  await cell(admin, G, 2).click();
  await admin.waitForSelector('#sheet[open] .reserve');
  await admin.fill('.reserve input[name=label]', 'Pádel');
  await admin.selectOption('.reserve select[name=who]', 'join');
  await admin.fill('.reserve input[name=capacity]', '4');
  await admin.fill('.reserve input[name=map_url]', 'https://maps.app.goo.gl/AbCd123');
  await admin.waitForSelector('.reserve .map.leaflet-container');
  check((await admin.innerText('.reserve .place-picker .hint')).startsWith('Este enlace no trae coordenadas'),
    'a short link asks for a tap on the map');
  await admin.locator('.reserve .map').click();
  await admin.waitForFunction(() => document.querySelector('.reserve .place-picker .hint').textContent.startsWith('Pin puesto'));
  await shot(admin, 'admin-place-picker');
  await admin.locator('.reserve button[type=submit]').click();
  await cellBecomes(admin, G, 2, 'is-plan');
  const places = (await rest('hangout_places')).documents || [];
  check(places.some((d) => d.fields.map_url?.stringValue === 'https://maps.app.goo.gl/AbCd123' && 'doubleValue' in (d.fields.lat || {})),
    'the plan keeps the short link and the tapped pin');

  // ---- Jose's number, leaving a plan, a page that refreshes itself, focus
  await reloaded(admin, '#panel:not([hidden])');
  await accessible(admin, 'admin panel');
  await admin.fill('#phone-form input[name=phone]', '+591 7000 0000');
  await admin.click('#phone-form button[type=submit]');
  await toastIs(admin, 'Número guardado.');

  await ana.click('#sheet-close');
  await ana.waitForFunction((d) => document.activeElement?.dataset?.date === d, G);
  check(true, 'closing the sheet puts the focus back on its slot');
  await reloaded(luis);
  await luis.getByRole('button', { name: '21 al 27 dic' }).click();
  await cell(luis, G, 3).click();
  await luis.locator('#sheet-body').getByRole('button', { name: 'Ya no puedo ir' }).click();
  await answer(luis);
  await luis.waitForSelector('.notice');
  check((await luis.locator('.notice').getByRole('link', { name: 'Avisar a Jose por WhatsApp' }).getAttribute('href'))
    .startsWith('https://wa.me/59170000000?text='), "leaving offers a message straight to Jose's number");
  await done(luis);
  check(await cellHas(luis, G, 3, 'is-joinable'), 'after leaving, the plan is open to join again');

  check((await cellText(ana, G, 3)) === 'Ocupado', 'a page left open still shows the old state');
  await comeBack(ana);
  await cellBecomes(ana, G, 3, 'is-joinable');
  check((await cellText(ana, G, 3)).includes('Queda 1'), 'coming back to the page refreshes it: the place is free again');

  // ---- "Tus planes" and adding a plan to one's own calendar
  const mineList = await luis.innerText('#mine-list');
  check(mineList.includes('Fiesta de fin de año') && mineList.includes('Te apuntaste') && !mineList.includes('Juegos de mesa'),
    '"Tus planes" lists the plans the friend is in');
  await luis.locator('#mine-list').getByRole('button', { name: /Fiesta de fin de año/ }).click();
  await luis.waitForSelector('#sheet[open] .entry.is-plan');
  check((await luis.innerText('#sheet-title')).includes('30 de diciembre'), 'a plan in the list opens its slot');
  const gcal = new URL(await luis.locator('#sheet-body').getByRole('link', { name: 'Añadir a Google Calendar' }).getAttribute('href'));
  check(gcal.searchParams.get('dates') === '20261230T200000/20261230T233000' && gcal.searchParams.get('text') === 'Fiesta de fin de año',
    'Google Calendar gets the plan with its times');
  const [planFile] = await Promise.all([luis.waitForEvent('download'), luis.locator('#sheet-body').getByRole('button', { name: 'Descargar para otro calendario' }).click()]);
  const planIcs = fs.readFileSync(await planFile.path(), 'utf8');
  check(planIcs.includes('SUMMARY:Fiesta de fin de año') && (planIcs.match(/BEGIN:VEVENT/g) || []).length === 1,
    'the .ics for other calendars holds that one plan');
  await luis.click('#sheet-close');

  // ---- Withdrawing a proposal
  const W = '2026-12-26';
  await reloaded(ana);
  await ana.getByRole('button', { name: '21 al 27 dic' }).click();
  await cell(ana, W, 2).click();
  await ana.fill('.propose input[name=name]', 'Ana');
  await ana.fill('.propose input[name=title]', 'Cena');
  await ana.click('.propose button[type=submit]');
  await done(ana);
  await cellBecomes(ana, W, 2, 'is-wait');
  await cell(ana, W, 2).click();
  await ana.locator('#sheet-body').getByRole('button', { name: 'Retirar propuesta' }).click();
  await answer(ana);
  await ana.waitForSelector('.notice:has-text("Propuesta retirada")');
  await done(ana);
  check(await cellHas(ana, W, 2, 'is-free'), 'a withdrawn proposal leaves the slot free');
  await reloaded(admin, '#panel:not([hidden])');
  check(!(await admin.innerText('#pending')).includes('Cena'), 'and Jose no longer has it to confirm');

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
  check(settingsDoc.fields?.schema?.integerValue === '4', 'upgrade: the schema is now 4');
  check(legacyDoc.fields?.going?.integerValue === '0' && legacyDoc.fields?.full?.booleanValue === false
    && 'nullValue' in (legacyDoc.fields?.capacity || {}), 'upgrade: an old plan gets its count, no limit, not full');
  check(legacyDoc.fields && !('note' in legacyDoc.fields), 'upgrade: the note left the hangout friends may read');
  check(legacyPrivate.fields?.note?.stringValue === 'Nota antigua', 'upgrade: the note is kept on the private side');
  check(legacyMarker.fields?.kind?.stringValue === 'busy', 'upgrade: an old private marker loses its telling kind');
  await reloaded(luis);
  check((await savedCopy(luis)).includes('Plan antiguo') && !(await savedCopy(luis)).includes('Nota antigua'),
    'upgrade: friends get the old open plan without its note');

  // ---- Rotating the code locks friends out
  await admin.click('#rotate');
  await answer(admin);
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
  check(await iconsLoad(lost), 'the 404 page icons load at any depth');
  check(await lost.getAttribute('#go', 'href') === `${base}/?emulator&c=${code}`, 'the 404 link leads to the calendar and keeps the invite code');
  await lost.clock.runFor(10_000);
  await lost.waitForURL(`${base}/?emulator&c=${code}`, { waitUntil: 'commit' });
  check(true, 'after 10 seconds the 404 page goes to the calendar');
  await accessible(lost, 'the 404 page');
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
