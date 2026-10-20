// Friends' page: the trip as one timetable. Tap a free slot to propose a
// hangout, tap a confirmed one to join it.
import { signInAnonymously } from 'firebase/auth';
import {
  doc, collection, collectionGroup, getDoc, getDocs, setDoc, writeBatch, query, where, serverTimestamp, increment,
} from 'firebase/firestore/lite';
import {
  auth, db, $, el, store, toast, friendLink, shareOnWhatsApp, wireSheet, renderTimetable, legend, participantDoc,
  placePicker, placeView, capacityInput, CAPACITY_ERROR, SLOTS, slotById, slotKey, LIMITS, tripDays, formatDay,
  todayInBolivia, clean, cleanName, nameKey, countdownText, plural, freeText, reservationStatus, sentStatus,
  cleanCapacity, isFull, spotsLeft,
} from './common.js';

// Everything this page keeps in the browser.
const KEYS = { name: 'bh_name', code: 'bh_code', registered: 'bh_reg', sent: 'bh_sent', cache: 'bh_cache' };
// Bump when the shape of the saved copy changes; an older copy is ignored.
const CACHE_VERSION = 3;

const state = {
  code: null,
  name: cleanName(store.get(KEYS.name)),
  settings: null,
  blocked: new Map(),      // 'date_slot' -> { label, kind }: taken slots; label is '' unless Jose opened it
  hangouts: new Map(),     // 'date_slot' -> [hangout]: open plans with room, and the full ones this device is in
  hangoutIds: new Set(),
  joinedIds: new Set(),    // hangouts this device joined (or proposed and got approved)
  places: new Map(),       // hangout id -> { map_url, lat, lng }, only for those
  participants: new Map(), // hangout id -> [{ name }]
  receipts: new Map(),     // proposal id -> receipt, for proposals sent from this device
  sent: [],                // what to draw of those proposals (sentStatus), set by render()
  open: null,              // { date, slotId, proposing } of the slot shown in the sheet
};

// The invite code arrives as ?c=CODE and is remembered on this device.
const urlCode = new URLSearchParams(location.search).get('c');
if (urlCode) store.set(KEYS.code, urlCode);
state.code = urlCode || store.get(KEYS.code);

function showGate() {
  $('status').hidden = true;
  $('calendar').hidden = true;
  $('gate').hidden = false;
}

// fresh = false while the timetable on screen is the saved copy from the
// last visit and the current data is still on its way.
function showCalendar(fresh) {
  $('status').hidden = true;
  $('gate').hidden = true;
  $('calendar').hidden = false;
  $('calendar').setAttribute('aria-busy', String(!fresh));
  render();
}

// The last timetable this device loaded. It is shown at once on the next
// visit while the fresh data arrives. It holds only what this friend was
// allowed to read.
function saveCache() {
  store.set(KEYS.cache, JSON.stringify({
    version: CACHE_VERSION,
    code: state.code,
    settings: { trip_start: state.settings.trip_start, trip_end: state.settings.trip_end },
    blocked: [...state.blocked],
    hangouts: [...state.hangouts],
    joinedIds: [...state.joinedIds],
    places: [...state.places],
    participants: [...state.participants],
    receipts: [...state.receipts],
  }));
}

function readCache() {
  try {
    const cache = JSON.parse(store.get(KEYS.cache) || 'null');
    if (cache?.version !== CACHE_VERSION || cache.code !== state.code) return false;
    state.settings = cache.settings;
    state.blocked = new Map(cache.blocked);
    state.hangouts = new Map(cache.hangouts);
    state.hangoutIds = new Set([...state.hangouts.values()].flat().map((h) => h.id));
    state.joinedIds = new Set(cache.joinedIds);
    state.places = new Map(cache.places);
    state.participants = new Map(cache.participants);
    state.receipts = new Map(cache.receipts);
    return true;
  } catch {
    return false;
  }
}

// Sign in (anonymously, no prompt) and register the invite code for this
// device. A wrong code is refused by the rules. Returns false when this
// device was already registered with this code, which saves a round trip.
async function connect() {
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  const key = `${auth.currentUser.uid}|${state.code}`;
  if (store.get(KEYS.registered) === key) return false;
  try {
    await setDoc(doc(db, 'members', auth.currentUser.uid), { code: state.code });
    store.set(KEYS.registered, key);
  } catch { /* wrong code: the load below fails and shows the gate */ }
  return true;
}

// Resolves once this device is signed in and has fresh data. Writes wait for it.
let ready = Promise.resolve();

async function start() {
  if (!state.code) return showGate();
  const cached = readCache();
  if (cached) showCalendar(false);

  ready = (async () => {
    const registered = await connect();
    try {
      await load();
    } catch (error) {
      // "Already registered" was remembered locally but is no longer true on the server.
      if (error.code !== 'permission-denied' || registered) throw error;
      store.remove(KEYS.registered);
      await connect();
      await load();
    }
  })();

  try {
    await ready;
  } catch (error) {
    if (error.code === 'permission-denied') {
      store.remove(KEYS.cache);
      store.remove(KEYS.registered);
      if (!urlCode) store.remove(KEYS.code);
      return showGate();
    }
    console.error(error);
    if (cached) return toast('No hay conexión. Ves la última versión guardada.');
    $('status').textContent = 'No se pudo cargar el calendario. Revisa tu conexión y recarga la página.';
    return;
  }
  saveCache();
  showCalendar(true);
}

async function load() {
  // Friends may read only what Jose marked open, and a full plan only if they
  // are in it. The rules refuse a hangouts query that does not ask for both.
  const uid = auth.currentUser.uid;
  const [settings, blocked, hangouts, joined, receipts] = await Promise.all([
    getDoc(doc(db, 'settings', 'main')),
    getDocs(collection(db, 'blocked_slots')),
    getDocs(query(collection(db, 'hangouts'), where('open', '==', true), where('full', '==', false))),
    // The plans this device joined (full ones included). If the query fails
    // (its index is still building after a deploy) the page goes on without.
    getDocs(query(collectionGroup(db, 'joined'), where('uid', '==', uid)))
      .catch((error) => { console.warn(error); return { docs: [] }; }),
    // What happened to the proposals sent from this device. A receipt that
    // cannot be fetched counts as no answer yet.
    Promise.all(readSent().map((p) => getDoc(doc(db, 'receipts', p.id))
      .then((receipt) => (receipt.exists() ? [p.id, receipt.data()] : null), () => null))),
  ]);
  const joinedIds = joined.docs.map((d) => d.ref.parent.parent.id);
  const open = hangouts.docs.map((d) => ({ id: d.id, ...d.data() }));
  // A full plan this device is in does not come with the query: fetch it by
  // id. A private one (its proposer's) cannot be read: its receipt tells.
  const missing = joinedIds.filter((id) => !open.some((h) => h.id === id));
  const extra = await Promise.all(missing.map((id) => getDoc(doc(db, 'hangouts', id)).catch(() => null)));
  for (const d of extra) if (d?.exists()) open.push({ id: d.id, ...d.data() });
  const [names, places] = await Promise.all([
    Promise.all(open.map((h) => getDocs(collection(db, 'hangouts', h.id, 'participants')))),
    // Where the joined plans happen: readable only by those in them.
    Promise.all(joinedIds.map((id) => getDoc(doc(db, 'hangout_places', id))
      .then((place) => (place.exists() ? [id, place.data()] : null), () => null))),
  ]);

  state.settings = settings.data();
  state.joinedIds = new Set(joinedIds);
  state.places = new Map(places.filter(Boolean));
  state.blocked = new Map(blocked.docs.map((d) => [d.id, d.data()]));
  state.hangouts = new Map();
  for (const h of open) {
    const key = slotKey(h.date, h.slot);
    state.hangouts.set(key, [...(state.hangouts.get(key) || []), h]);
  }
  state.hangoutIds = new Set(open.map((h) => h.id));
  state.participants = new Map(open.map((h, i) => [h.id, names[i].docs.map((p) => p.data())
    .sort((x, y) => (x.created_at?.seconds ?? 0) - (y.created_at?.seconds ?? 0))]));
  state.receipts = new Map(receipts.filter(Boolean));
}

// Proposals sent from this device: [{ id, date, slot, title }]. See sentStatus.
function readSent() {
  try { return JSON.parse(store.get(KEYS.sent) || '[]'); } catch { return []; }
}

const people = (hangout) => state.participants.get(hangout.id) || [];
// In the plan: this device joined it, or (someone Jose added) the name matches.
const isMine = (hangout) => state.joinedIds.has(hangout.id)
  || (!!state.name && people(hangout).some((p) => nameKey(p.name) === nameKey(state.name)));
const canJoin = (hangout) => !hangout.full && !isMine(hangout);

// "Quedan 2 plazas." / "Completo." for a plan with a limit, else ''.
function spotsText(hangout) {
  if (hangout.capacity == null) return '';
  if (hangout.full) return 'Completo.';
  const spots = spotsLeft(hangout.capacity, hangout.going ?? 0);
  return spots === 1 ? 'Queda 1 plaza.' : `Quedan ${spots} plazas.`;
}

// What is in a slot. An 'open' marker only says that an open plan is there:
// with the plan in hand it takes nothing away; without it (a full plan this
// device is not in) the slot is taken.
function slotInfo(date, slotId) {
  const key = slotKey(date, slotId);
  const hangouts = state.hangouts.get(key) || [];
  const marker = state.blocked.get(key) || null;
  return {
    block: marker && !(marker.kind === 'open' && hangouts.length) ? marker : null,
    hangouts,
    mine: state.sent.filter((p) => p.date === date && p.slot === slotId),
  };
}

function render() {
  const { trip_start: start, trip_end: end } = state.settings;
  const today = todayInBolivia();
  const days = tripDays(start, end);
  const { keep, shown } = sentStatus(readSent(), state.receipts, state.hangoutIds, today);
  store.set(KEYS.sent, JSON.stringify(keep));
  state.sent = shown;

  const short = (iso) => formatDay(iso).replace(/^\S+\s/, '');
  $('lede').textContent = `Del ${short(start)} al ${short(end)}. ${countdownText(start, end, today)}.`;

  let free = 0;
  const cellFor = (date, slotId) => {
    const { block, hangouts, mine } = slotInfo(date, slotId);
    if (hangouts.length) {
      const [first] = hangouts;
      // Room for one more, and this friend is not in yet: it looks inviting.
      const joinable = date >= today && hangouts.some(canJoin);
      const spots = spotsLeft(first.capacity ?? null, first.going ?? 0);
      return {
        status: 'plan',
        title: first.title,
        sub: first.full ? 'Completo'
          : joinable && spots !== Infinity ? (spots === 1 ? 'Queda 1' : `Quedan ${spots}`)
          : people(first).map((p) => p.name).join(', '),
        more: hangouts.length - 1,
        joinable,
      };
    }
    const confirmed = mine.find((p) => p.status === 'confirmed');
    if (confirmed) return { status: 'plan', title: confirmed.title, sub: 'Confirmado' };
    if (block) {
      // No label: Jose kept it private, so all a friend learns is "taken".
      if (!block.label) return { status: 'off', title: 'Ocupado', merge: 'busy' };
      const status = reservationStatus(block.kind);
      return { status, title: block.label, merge: `${status}|${block.label}` };
    }
    if (mine.length) return { status: 'wait', title: mine[0].title, sub: 'Por confirmar' };
    if (date < today) return { status: 'gone' };
    free += 1;
    return { status: 'free' };
  };
  $('tt').replaceChildren(renderTimetable({ days, today, cellFor, onPick: openSlot }));

  const mineCount = [...state.hangouts.values()].flat().filter(isMine).length
    + state.sent.filter((p) => p.status === 'confirmed').length;
  $('summary').textContent = [
    freeText(free),
    mineCount ? `Tienes ${plural(mineCount, 'plan', 'planes')} con Jose.` : '',
  ].join(' ');

  $('legend').replaceChildren(legend([
    ['free', 'Libre'], ['plan is-joinable', 'Plan abierto: te puedes apuntar'], ['plan', 'Tu plan'],
    ['wait', 'Tu propuesta, por confirmar'], ['off', 'Ocupado'],
  ]));

  $('hello').replaceChildren(...(state.name
    ? [`Apareces como ${state.name}. `, el('button', { type: 'button', class: 'btn text', onclick: changeName }, 'Cambiar nombre')]
    : []));

  if ($('sheet').open && state.open) renderSheet();
}

// ---- Slot sheet ----

function openSlot(date, slotId) {
  state.open = { date, slotId, proposing: false };
  renderSheet();
  if (!$('sheet').open) $('sheet').showModal();
}

wireSheet();

// The name is asked for once, inside the first form that needs it.
function nameField() {
  if (state.name) return null;
  return el('label', {}, 'Tu nombre',
    el('input', { name: 'name', maxLength: LIMITS.name, required: true, autocomplete: 'given-name', placeholder: 'Ej. Caro' }));
}

function setName(name) {
  state.name = name;
  store.set(KEYS.name, name);
}

// Reads the name from a form (when it has the field) and remembers it.
function takeName(form) {
  if (form.elements.name) {
    const name = cleanName(form.elements.name.value);
    if (!name) return false;
    setName(name);
  }
  return !!state.name;
}

function changeName() {
  const name = cleanName(prompt('¿Cómo te llamas?', state.name) || '');
  if (!name) return;
  setName(name);
  render();
}

function renderSheet() {
  const { date, slotId } = state.open;
  const slot = slotById[slotId];
  const { block, hangouts, mine } = slotInfo(date, slotId);
  const past = date < todayInBolivia();
  // A block that covers the whole day is described as such.
  const wholeDay = block && SLOTS.every((s) => {
    const other = state.blocked.get(slotKey(date, s.id));
    return other && other.label === block.label && other.kind === block.kind;
  });

  $('sheet-title').textContent = formatDay(date);
  $('sheet-when').textContent = wholeDay ? 'Todo el día' : `${slot.label}, de ${slot.start} a ${slot.end}`;

  const body = [];
  const confirmed = mine.filter((p) => p.status === 'confirmed');
  const waiting = mine.filter((p) => p.status === 'waiting');
  for (const p of confirmed) {
    body.push(el('div', { class: 'entry is-plan' },
      el('h3', {}, p.title),
      el('p', {}, 'Jose confirmó tu plan. Solo tú y Jose lo ven.'),
      placeView(state.places.get(p.hangout), p.title)));
  }
  if (block && !confirmed.length) {
    body.push(el('div', { class: 'entry is-' + (block.label ? reservationStatus(block.kind) : 'off') },
      el('h3', {}, block.label || 'Ocupado'),
      el('p', {}, 'Jose no está disponible en este espacio.')));
  }
  for (const hangout of hangouts) body.push(renderHangout(hangout, past));
  for (const p of waiting) {
    body.push(el('div', { class: 'entry is-wait' },
      el('h3', {}, p.title),
      el('p', {}, 'Tu propuesta espera la confirmación de Jose.')));
  }
  if (past && !block && !hangouts.length) body.push(el('p', {}, 'Este día ya pasó.'));
  if (!block && !past) {
    const busy = hangouts.length > 0 || mine.length > 0;
    body.push(busy && !state.open.proposing
      ? el('button', { type: 'button', class: 'btn', onclick: () => { state.open.proposing = true; renderSheet(); } }, 'Proponer otro plan')
      : proposeForm(date, slotId, busy));
  }
  $('sheet-body').replaceChildren(...body);
}

function renderHangout(hangout, past) {
  const names = people(hangout).map((p) => p.name);
  const mine = isMine(hangout);
  const joinForm = el('form', { class: 'join', onsubmit: (event) => join(event, hangout) },
    nameField(),
    el('button', { type: 'submit', class: 'btn primary' }, 'Me apunto'));
  const limit = hangout.capacity == null ? '' : `Hasta ${hangout.capacity} personas, contando a Jose. `;
  return el('div', { class: 'entry is-plan' },
    el('h3', {}, hangout.title),
    hangout.place ? el('p', {}, 'En ' + hangout.place) : null,
    el('p', {}, names.length ? 'Vienen: ' + names.join(', ') : 'Todavía no se apuntó nadie.'),
    limit ? el('p', {}, limit + spotsText(hangout)) : null,
    // The pin is only for those going.
    mine ? placeView(state.places.get(hangout.id), hangout.title) : null,
    past ? null : mine ? el('p', { class: 'done' }, 'Ya estás apuntado.') : hangout.full ? null : joinForm,
  );
}

// Joining is one batch: the name, this device's joined document, and one more
// in the plan's count. The rules refuse it when the plan filled up meanwhile
// or the name is taken.
async function join(event, hangout) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!takeName(form)) return;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await ready.catch(() => {});
    const key = nameKey(state.name);
    const uid = auth.currentUser.uid;
    const going = (hangout.going ?? 0) + 1;
    const batch = writeBatch(db);
    batch.set(doc(db, 'hangouts', hangout.id, 'participants', key), participantDoc(state.name));
    batch.set(doc(db, 'hangouts', hangout.id, 'joined', uid), { uid, key });
    batch.update(doc(db, 'hangouts', hangout.id), { going, full: isFull(hangout.capacity ?? null, going) });
    await batch.commit();
    toast('Apuntado.');
  } catch (error) {
    console.error(error);
    toast(error.code === 'permission-denied'
      ? 'No se pudo apuntar: ya hay alguien con ese nombre, o se acaban de llenar las plazas.'
      : 'No se pudo apuntar. Revisa tu conexión y prueba otra vez.');
  }
  await load().then(saveCache, console.error);
  render();
}

function proposeForm(date, slotId, another) {
  const error = el('p', { class: 'error', hidden: true });
  const send = el('button', { type: 'submit', class: 'btn primary' }, 'Enviar propuesta');
  const picker = placePicker();
  const form = el('form', { class: 'propose' },
    el('h3', {}, another ? 'Proponer otro plan' : 'Proponer un plan'),
    nameField(),
    el('label', {}, '¿Qué hacemos?',
      el('input', { name: 'title', maxLength: LIMITS.title, required: true, placeholder: 'Ej. Noche de juegos de mesa' })),
    el('label', {}, '¿Dónde?',
      el('input', { name: 'place', maxLength: LIMITS.place, placeholder: 'Ej. Zona de la Recoleta' }),
      el('span', { class: 'hint' }, 'Un café o una zona. Si Jose abre el plan, esto lo ven todos.')),
    picker.node,
    el('label', {}, '¿Cuántas personas como máximo? (opcional)',
      capacityInput(),
      el('span', { class: 'hint' }, 'Contando a Jose y a ti. Cuando se llena, los demás ven «Ocupado».')),
    el('label', {}, 'Nota para Jose (opcional)',
      el('textarea', { name: 'note', maxLength: LIMITS.note, rows: 2 }),
      el('span', { class: 'hint' }, 'Solo Jose ve tu propuesta y tu nota. Él decide si los demás ven el plan.')),
    // Honeypot: people never see or fill this field; bots often do.
    el('div', { class: 'hp', 'aria-hidden': 'true' },
      el('label', {}, 'Sitio web', el('input', { name: 'website', tabIndex: -1, autocomplete: 'off' }))),
    error,
    send,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = clean(form.elements.title.value, LIMITS.title);
    if (!title || !takeName(form)) return;

    // Honeypot filled in: act as if it worked, send nothing.
    if (form.elements.website.value) {
      $('sheet').close();
      return toast('¡Enviado! Jose lo confirma pronto.');
    }

    const capacity = cleanCapacity(form.elements.capacity.value);
    if (capacity === undefined) {
      error.textContent = CAPACITY_ERROR;
      error.hidden = false;
      return;
    }
    const data = {
      date,
      slot: slotId,
      title,
      place: clean(form.elements.place.value, LIMITS.place),
      note: clean(form.elements.note.value, LIMITS.note),
      proposer_name: state.name,
      status: 'pending',
      created_at: serverTimestamp(),
      capacity,
      ...picker.value(),
    };
    send.disabled = true;
    error.hidden = true;
    try {
      await ready.catch(() => {});
      // This device joins the plan if it is approved: it keeps seeing the
      // plan and its place once it is full.
      if (auth.currentUser) data.uid = auth.currentUser.uid;
      const id = await sendProposal(data);
      store.set(KEYS.sent, JSON.stringify([...readSent(), { id, date, slot: slotId, title }]));
      $('sheet').close();
      toast('¡Enviado! Jose lo confirma pronto.');
      render();
    } catch (err) {
      console.error(err);
      error.textContent = err.code === 'permission-denied'
        ? 'No se envió. Ese espacio ya no está disponible o hoy ya hay demasiadas propuestas. Prueba otro espacio o vuelve mañana.'
        : 'No se envió. Revisa tu conexión y prueba otra vez.';
      error.hidden = false;
      send.disabled = false;
    }
  });
  return form;
}

// The rules accept a proposal only together with a bump of the rate-limit
// counter. We cannot read the counter, so first try "one more in the current
// 24 h window" and, if that is refused, "start a new window".
async function sendProposal(data) {
  const ref = doc(collection(db, 'proposals'));
  const counter = doc(db, 'counters', 'proposals');
  const commit = (newWindow) => {
    const batch = writeBatch(db);
    batch.update(counter, newWindow
      ? { count: 1, window_start: serverTimestamp(), last_id: ref.id }
      : { count: increment(1), last_id: ref.id });
    batch.set(ref, data);
    return batch.commit();
  };
  try {
    await commit(false);
  } catch (error) {
    if (error.code !== 'permission-denied') throw error;
    await commit(true);
  }
  return ref.id;
}

// ---- Share ----

$('share').addEventListener('click', () =>
  shareOnWhatsApp(`Jose va a estar en Cochabamba. Propón un plan o apúntate a uno aquí: ${friendLink(state.code)}`));

start();
