// Shared by index.html and admin.html: Firebase setup and the DOM helpers.
// The pure helpers (slots, dates, text) live in lib.js and are re-exported
// here, so a page imports everything it needs from one place.
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, serverTimestamp } from 'firebase/firestore/lite';
import { firebaseConfig } from './config.js';
import { SLOTS, formatDay, dayParts, weekday } from './lib.js';

export * from './lib.js';

// Local development only: http://localhost:5500/?emulator talks to the Firebase
// emulators (npm run test:e2e) instead of the live project.
const useEmulator = ['localhost', '127.0.0.1'].includes(location.hostname)
  && new URLSearchParams(location.search).has('emulator');

// Firestore Lite is used on purpose: the pages only read and write on demand,
// and Lite does that over plain HTTPS without opening a streaming channel,
// which made the first load several seconds slower.
export const app = initializeApp(useEmulator ? { ...firebaseConfig, projectId: 'demo-bolivia-hangouts' } : firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
if (useEmulator) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

// A participant document; its id is the lower-cased name (see firestore.rules).
export const participantDoc = (name) => ({ name, created_at: serverTimestamp() });

// ---- DOM ----

export const $ = (id) => document.getElementById(id);

// Tiny element builder. Text always goes through textContent/text nodes, so
// user-provided strings are never parsed as HTML.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

export function friendLink(code) {
  const url = new URL('index.html', location.href);
  url.search = '?c=' + encodeURIComponent(code);
  return url.href.replace('/index.html?', '/?');
}

export function shareOnWhatsApp(text) {
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
}

let toastTimer;
export function toast(message) {
  let node = $('toast');
  if (!node) {
    node = el('div', { id: 'toast', role: 'status' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3500);
}

// The slot sheet: its close button and a click on the backdrop (outside the
// sheet's box) close it.
export function wireSheet() {
  const sheet = $('sheet');
  $('sheet-close').addEventListener('click', () => sheet.close());
  sheet.addEventListener('click', (event) => { if (event.target === sheet) sheet.close(); });
}

// ---- Timetable ----

// The trip as a timetable, one week (at most 7 days) on screen at a time:
// a row per day, a column per slot, every cell filled with what is in it.
// Weeks sit side by side; swipe sideways or use the week buttons.
//
// cellFor(date, slotId) returns { status, title, sub, more, alert, open, merge }:
//   status  'free' | 'gone' | 'plan' | 'wait' | 'own' | 'off'
//   merge   neighbouring cells with the same merge key are drawn as one
//           (an all-day "Navidad en familia" reads once, not four times)
let shownWeek = null; // survives re-renders, so the view does not jump back

export function renderTimetable({ days, today, cellFor, onPick }) {
  // Weeks run Monday to Sunday.
  const weeks = [];
  for (const date of days) {
    if (!weeks.length || weekday(date) === 1) weeks.push([]);
    weeks.at(-1).push(date);
  }
  if (shownWeek === null) shownWeek = Math.max(0, weeks.findIndex((week) => week.includes(today)));
  shownWeek = Math.min(shownWeek, weeks.length - 1);

  const weekLabel = (week) => {
    const first = dayParts(week[0]);
    const last = dayParts(week.at(-1));
    return first.month === last.month
      ? `${first.day} al ${last.day} ${last.month}`
      : `${first.day} ${first.month} al ${last.day} ${last.month}`;
  };

  const row = (date) => {
    const parts = dayParts(date);
    const cells = [];
    for (const slot of SLOTS) {
      const cell = { slot, span: 1, ...cellFor(date, slot.id) };
      const last = cells.at(-1);
      if (last && cell.merge && last.merge === cell.merge) last.span += 1;
      else cells.push(cell);
    }
    return el('div', {
      class: 'tt-row' + (date === today ? ' is-today' : '') + (date < today ? ' is-past' : ''),
      id: 'd-' + date,
    },
      el('span', { class: 'tt-day' }, el('small', {}, parts.weekday), parts.day),
      cells.map((cell) => el('button', {
        type: 'button',
        class: `tt-cell is-${cell.status}` + (cell.alert ? ' is-alert' : '') + (cell.open ? ' is-open' : ''),
        style: cell.span > 1 ? `grid-column: span ${cell.span}` : null,
        disabled: cell.status === 'gone',
        'aria-label': `${formatDay(date)}, ${cell.span === SLOTS.length ? 'todo el día' : cell.slot.label}: ${cell.title || 'libre'}`,
        onclick: () => onPick(date, cell.slot.id),
      },
        cell.status === 'free' ? el('span', { class: 'tt-plus', 'aria-hidden': 'true' }, '+') : null,
        cell.title ? el('span', { class: 'tt-t' }, cell.title) : null,
        cell.sub ? el('span', { class: 'tt-s' }, cell.sub) : null,
        cell.more ? el('span', { class: 'tt-more' }, `+${cell.more}`) : null,
      )),
    );
  };

  const scroller = el('div', { class: 'tt-scroll' }, weeks.map((week) =>
    el('div', { class: 'tt-week' },
      el('div', { class: 'tt-row tt-head', 'aria-hidden': 'true' },
        el('span'),
        SLOTS.map((slot) => el('span', { class: 'tt-col' }, slot.label, el('small', {}, slot.start)))),
      week.map(row))));

  const tabs = weeks.map((week, index) => el('button', {
    type: 'button',
    class: 'tt-tab',
    'aria-pressed': String(index === shownWeek),
    onclick: () => scroller.scrollTo({ left: index * scroller.clientWidth, behavior: 'smooth' }),
  }, weekLabel(week)));

  // Keep the buttons in step with the swipe position.
  scroller.addEventListener('scroll', () => {
    const index = Math.round(scroller.scrollLeft / Math.max(1, scroller.clientWidth));
    if (index === shownWeek) return;
    shownWeek = index;
    tabs.forEach((tab, i) => tab.setAttribute('aria-pressed', String(i === index)));
  }, { passive: true });
  // The element is not in the page yet; restore the position once it is.
  requestAnimationFrame(() => scroller.scrollTo({ left: shownWeek * scroller.clientWidth, behavior: 'instant' }));

  return el('div', { class: 'tt' },
    el('div', { class: 'tt-tabs', role: 'group', 'aria-label': 'Semana' }, tabs),
    scroller);
}

export function legend(items) {
  return el('ul', { class: 'legend' }, items.map(([status, label]) =>
    el('li', {}, el('i', { class: 'swatch is-' + status }), label)));
}
