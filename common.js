// Shared by index.html and admin.html: Firebase setup, slot definitions and
// small DOM/date helpers. All dates are plain 'YYYY-MM-DD' strings in Bolivia
// time; nothing here depends on the visitor's time zone.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { firebaseConfig } from './config.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Default times are Bolivia time (America/La_Paz, UTC-4, no DST).
export const SLOTS = [
  { id: 'manana', label: 'Mañana', start: '10:00', end: '12:30' },
  { id: 'almuerzo', label: 'Almuerzo', start: '12:30', end: '15:00' },
  { id: 'tarde', label: 'Tarde', start: '15:30', end: '19:00' },
  { id: 'noche', label: 'Noche', start: '20:00', end: '23:30' },
];
export const slotById = Object.fromEntries(SLOTS.map((s) => [s.id, s]));
export const slotIndex = (id) => SLOTS.findIndex((s) => s.id === id);

export const LIMITS = { title: 80, place: 80, name: 40, note: 280 };

// Every 'YYYY-MM-DD' from start to end, inclusive.
export function tripDays(start, end) {
  const days = [];
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

const dayFormat = new Intl.DateTimeFormat('es-BO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortFormat = new Intl.DateTimeFormat('es-BO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const formatDay = (iso) => dayFormat.format(new Date(iso + 'T00:00:00Z'));
export const formatDayShort = (iso) => shortFormat.format(new Date(iso + 'T00:00:00Z'));

// Today's date in Bolivia, whatever the visitor's own time zone is.
export function todayInBolivia() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz' }).format(new Date());
}

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

// Trim, collapse inner whitespace and cut to the maximum length.
export function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

// Names double as document ids (lower-cased), so they cannot contain '/'.
export function cleanName(value) {
  return clean(String(value ?? '').replace(/\//g, ' '), LIMITS.name);
}

export const nameKey = (name) => name.toLowerCase();

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

export function whatsappUrl(text) {
  return 'https://wa.me/?text=' + encodeURIComponent(text);
}

let toastTimer;
export function toast(message) {
  let node = document.getElementById('toast');
  if (!node) {
    node = el('div', { id: 'toast', role: 'status' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3500);
}
