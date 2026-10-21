// Shared by index.html and admin.html: Firebase setup and the DOM helpers.
// The pure helpers (slots, dates, text) live in lib.js and are re-exported
// here, so a page imports everything it needs from one place.
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, serverTimestamp } from 'firebase/firestore/lite';
import { firebaseConfig } from './config.js';
import {
  SLOTS, HOME, CAPACITY, formatDay, dayParts, weekday, parseLocation, cleanPlace, cleanMapUrl, hasPlace, mapLinks,
  whatsappUrl, googleCalendarUrl, buildIcs,
} from './lib.js';

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

// Opens WhatsApp with a message ready: to `phone` when given, otherwise
// WhatsApp asks whom to send it to.
export function shareOnWhatsApp(text, phone = '') {
  window.open(whatsappUrl(text, phone), '_blank', 'noopener');
}

// A link-styled button that opens WhatsApp with a message (for the tests and
// for people, the href is the message).
export const whatsappButton = (label, text, phone = '', extra = '') =>
  el('a', { class: 'btn small' + extra, href: whatsappUrl(text, phone), target: '_blank', rel: 'noopener' }, label);

// Saves text as a file (the .ics exports).
export function download(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "Add to my calendar" for one plan: Google Calendar, or an .ics file that
// iPhone, Outlook and the rest open. plan: { id, date, slot, title, place,
// proposer_name, location }.
export function calendarButtons(plan, participants = new Map()) {
  const pin = plan.location?.lat != null ? `${plan.location.lat},${plan.location.lng}` : '';
  const google = googleCalendarUrl({
    date: plan.date, slot: plan.slot, title: plan.title, place: plan.place || pin, details: 'Plan con Jose en Cochabamba.',
  });
  const ics = () => download(buildIcs({ hangouts: [plan], reservations: [], participants }), 'plan.ics', 'text/calendar;charset=utf-8');
  return el('div', { class: 'actions calendar' },
    el('a', { class: 'btn small', href: google, target: '_blank', rel: 'noopener' }, 'Añadir a Google Calendar'),
    el('button', { type: 'button', class: 'btn small', onclick: ics }, 'Descargar para otro calendario'));
}

// ---- Dialogs ----

// An in-page question instead of confirm() and prompt(). Resolves to true or
// false; with `input` ({ label, value, maxLength }) to the typed text, or null
// when cancelled.
export function ask({ title, text = '', confirm = 'Aceptar', cancel = 'Cancelar', input = null }) {
  return new Promise((resolve) => {
    const field = input
      ? el('input', { name: 'answer', value: input.value ?? '', maxLength: input.maxLength, required: true, autocomplete: 'off' })
      : null;
    const dialog = el('dialog', { class: 'sheet ask', 'aria-labelledby': 'ask-title' },
      el('form', { method: 'dialog' },
        el('h2', { id: 'ask-title' }, title),
        text ? el('p', {}, text) : null,
        field ? el('label', {}, input.label, field) : null,
        el('div', { class: 'actions' },
          el('button', { type: 'submit', class: 'btn primary', value: 'yes' }, confirm),
          el('button', { type: 'button', class: 'btn text', onclick: () => dialog.close('no') }, cancel))));
    dialog.addEventListener('close', () => {
      dialog.remove();
      const yes = dialog.returnValue === 'yes';
      resolve(field ? (yes ? field.value : null) : yes);
    });
    document.body.append(dialog);
    dialog.showModal();
    field?.select();
  });
}

// ---- Keeping the page current ----

// Calls fn when the page comes back into view after `away` ms or more (a
// friend returns to the WhatsApp browser), unless a dialog is open: a reload
// must not wipe what someone is typing.
export function onReturn(fn, away = 30_000) {
  let hiddenAt = null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = performance.now();
    } else if (hiddenAt != null && performance.now() - hiddenAt >= away && !document.querySelector('dialog[open]')) {
      hiddenAt = null;
      fn();
    }
  });
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
// sheet's box) close it. Closing puts the focus back on the slot's cell (the
// timetable may have been redrawn meanwhile); opened() is the open slot.
export function wireSheet(opened) {
  const sheet = $('sheet');
  $('sheet-close').addEventListener('click', () => sheet.close());
  sheet.addEventListener('click', (event) => { if (event.target === sheet) sheet.close(); });
  sheet.addEventListener('close', () => {
    const slot = opened();
    if (!slot) return;
    requestAnimationFrame(() => {
      document.querySelector(`.tt-cell[data-date="${slot.date}"][data-slot="${slot.slotId}"]`)?.focus();
    });
  });
}

// ---- How many people ----

// "How many people at most": empty means no limit.
export const capacityInput = () => el('input', {
  name: 'capacity', type: 'number', min: CAPACITY.min, max: CAPACITY.max, step: 1, inputMode: 'numeric', placeholder: 'Sin límite',
});
export const CAPACITY_ERROR = `El máximo tiene que ser un número entre ${CAPACITY.min} y ${CAPACITY.max}.`;

// ---- Maps ----

// Leaflet loads from the CDN the first time a map is shown; the tiles come
// from OpenStreetMap.
const LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
let leaflet = null;
function loadLeaflet() {
  leaflet ??= new Promise((resolve, reject) => {
    document.head.append(el('link', { rel: 'stylesheet', href: LEAFLET + 'leaflet.css' }));
    document.head.append(el('script', {
      src: LEAFLET + 'leaflet.js',
      onload: () => resolve(window.L),
      onerror: () => { leaflet = null; reject(new Error('Leaflet did not load')); },
    }));
  });
  return leaflet;
}

// Runs fn once the element is in the page and has a size: Leaflet needs both.
function whenShown(node, fn) {
  const observer = new ResizeObserver(([entry]) => {
    if (!entry.contentRect.width) return;
    observer.disconnect();
    fn();
  });
  observer.observe(node);
}

async function drawMap(box, { lat, lng, zoom }) {
  const L = await loadLeaflet();
  const map = L.map(box, { scrollWheelZoom: false }).setView([lat, lng], zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  new ResizeObserver(() => map.invalidateSize()).observe(box);
  return { L, map };
}

const pinIcon = (L) => L.divIcon({ className: 'pin', html: '<span></span>', iconSize: [28, 36], iconAnchor: [14, 34] });
const PIN_ZOOM = 16;

// Where a plan happens: paste a map link (or "lat, lng"), or tap the map, and
// drag the pin to adjust it. initial and value() are { map_url, lat, lng }.
export function placePicker(initial = {}) {
  let pin = initial.lat != null ? { lat: initial.lat, lng: initial.lng } : null;
  let L = null;
  let map = null;
  let marker = null;
  const link = el('input', {
    name: 'map_url', type: 'url', inputMode: 'url', autocomplete: 'off', value: initial.map_url || '',
    placeholder: 'Pega un enlace de Google Maps o toca el mapa',
  });
  const hint = el('span', { class: 'hint' });
  const box = el('div', {
    class: 'map', role: 'region', 'aria-label': 'Mapa: toca para poner el pin, o pega arriba un enlace con coordenadas',
  });

  const showHint = () => {
    hint.textContent = pin ? 'Pin puesto. Puedes arrastrarlo para ajustarlo.'
      : link.value.trim() ? 'Este enlace no trae coordenadas. Toca el mapa para poner el pin.'
      : 'Opcional. Solo lo ven Jose y quienes se apunten.';
  };
  const setPin = (point, center = true) => {
    pin = point;
    marker?.remove();
    marker = null;
    if (map && pin) {
      marker = L.marker([pin.lat, pin.lng], { icon: pinIcon(L), draggable: true, keyboard: false }).addTo(map);
      marker.on('dragend', () => { pin = cleanPlace(marker.getLatLng()); });
      if (center) map.setView([pin.lat, pin.lng], Math.max(map.getZoom(), PIN_ZOOM));
    }
    showHint();
  };

  link.addEventListener('input', () => {
    const point = parseLocation(link.value);
    if (point) setPin(point);
    else showHint();
  });
  whenShown(box, async () => {
    try {
      ({ L, map } = await drawMap(box, pin ? { ...pin, zoom: PIN_ZOOM } : HOME));
      map.on('click', (event) => setPin(cleanPlace(event.latlng), false));
      setPin(pin, false);
    } catch {
      box.classList.add('is-error');
      box.textContent = 'No se pudo cargar el mapa. Pega un enlace con coordenadas.';
    }
  });
  showHint();

  return {
    node: el('div', { class: 'place-picker' },
      el('label', {}, 'Ubicación (opcional)', link, hint),
      box,
      el('button', { type: 'button', class: 'btn text small', onclick: () => { link.value = ''; setPin(null); } }, 'Quitar ubicación')),
    value: () => cleanPlace({ url: link.value, lat: pin?.lat, lng: pin?.lng }),
  };
}

// A plan's place for those who may see it: a small map with the pin and links
// to open it in Google Maps or Apple Maps. A link without a pin is just a link.
export function placeView(place, label = '') {
  if (!hasPlace(place)) return null;
  const open = (href, text, extra = '') => el('a', { class: 'btn small' + extra, href, target: '_blank', rel: 'noopener' }, text);
  const links = [];
  let box = null;
  if (place.lat != null) {
    const { google, apple } = mapLinks(place, label);
    links.push(open(google, 'Abrir en Google Maps'), open(apple, 'Abrir en Apple Maps'));
    box = el('div', { class: 'map is-small', role: 'region', 'aria-label': `Mapa: dónde es ${label || 'el plan'}` });
    whenShown(box, async () => {
      try {
        const { L, map } = await drawMap(box, { ...place, zoom: PIN_ZOOM });
        L.marker([place.lat, place.lng], { icon: pinIcon(L), keyboard: false }).addTo(map);
      } catch {
        box.remove();
      }
    });
  }
  const url = cleanMapUrl(place.map_url);
  if (url) links.push(open(url, place.lat != null ? 'Enlace original' : 'Abrir el enlace del mapa', place.lat != null ? ' text' : ''));
  return el('div', { class: 'place' }, box, el('div', { class: 'actions' }, links));
}

// ---- Timetable ----

// The trip as a timetable, one week (at most 7 days) on screen at a time:
// a row per day, a column per slot, every cell filled with what is in it.
// Weeks sit side by side; swipe sideways or use the week buttons.
//
// cellFor(date, slotId) returns { status, title, sub, more, alert, open, joinable, merge }:
//   status    'free' | 'gone' | 'plan' | 'wait' | 'own' | 'off'
//   joinable  an open plan with room that the visitor is not in yet
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
        class: `tt-cell is-${cell.status}` + (cell.alert ? ' is-alert' : '') + (cell.open ? ' is-open' : '')
          + (cell.joinable ? ' is-joinable' : ''),
        style: cell.span > 1 ? `grid-column: span ${cell.span}` : null,
        disabled: cell.status === 'gone',
        dataset: { date, slot: cell.slot.id },
        onclick: () => onPick(date, cell.slot.id),
      },
        // The name is the day and slot (heard, not seen) and then what the
        // cell shows, all of it even when a long title is cut on screen.
        el('span', { class: 'sr-only' }, `${formatDay(date)}, ${cell.span === SLOTS.length ? 'todo el día' : cell.slot.label}: `),
        cell.status === 'free' ? [el('span', { class: 'tt-plus', 'aria-hidden': 'true' }, '+'), el('span', { class: 'sr-only' }, 'libre')] : null,
        cell.status === 'gone' ? el('span', { class: 'sr-only' }, 'ya pasó') : null,
        // Shown only in the list layout for large text (app.css), where the
        // column headings are gone; screen readers already heard it.
        el('span', { class: 'tt-when', 'aria-hidden': 'true' }, cell.span === SLOTS.length ? 'Todo el día' : cell.slot.label),
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
