// Friends' page: the trip as one timetable. Tap a free slot to propose a
// hangout, tap a confirmed one to join it.
import { signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  doc, collection, getDoc, getDocs, setDoc, writeBatch, query, where,
  serverTimestamp, increment,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore-lite.js';
import {
  auth, db, SLOTS, slotById, LIMITS, tripDays, formatDay, todayInBolivia, el, clean,
  cleanName, nameKey, store, friendLink, whatsappUrl, toast, renderTimetable, legend,
  countdownText, plural,
} from './common.js';

const $ = (id) => document.getElementById(id);
const PENDING_VISIBLE_DAYS = 7;

const state = {
  code: null,
  name: cleanName(store.get('bh_name')),
  settings: null,
  blocked: new Map(),      // 'date_slot' -> { label, kind }: taken slots; label is '' unless Jose opened it
  hangouts: new Map(),     // 'date_slot' -> [hangout], only the ones Jose marked open
  receipts: new Map(),     // proposal id -> 'approved' | 'rejected', for proposals sent from this device
  hangoutIds: new Set(),
  participants: new Map(), // hangout id -> [{ name }]
  open: null,              // { date, slotId } of the slot shown in the sheet
};

// The invite code arrives as ?c=CODE and is remembered on this device.
const urlCode = new URLSearchParams(location.search).get('c');
if (urlCode) store.set('bh_code', urlCode);
state.code = urlCode || store.get('bh_code');

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
const CACHE = 'bh_cache';

function saveCache() {
  store.set(CACHE, JSON.stringify({
    code: state.code,
    settings: { trip_start: state.settings.trip_start, trip_end: state.settings.trip_end },
    blocked: [...state.blocked],
    hangouts: [...state.hangouts],
    participants: [...state.participants],
    receipts: [...state.receipts],
  }));
}

function readCache() {
  try {
    const cache = JSON.parse(store.get(CACHE) || 'null');
    if (!cache || cache.code !== state.code) return false;
    state.settings = cache.settings;
    state.blocked = new Map(cache.blocked);
    state.hangouts = new Map(cache.hangouts);
    state.hangoutIds = new Set([...state.hangouts.values()].flat().map((h) => h.id));
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
  if (store.get('bh_reg') === key) return false;
  try {
    await setDoc(doc(db, 'members', auth.currentUser.uid), { code: state.code });
    store.set('bh_reg', key);
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
      store.remove('bh_reg');
      await connect();
      await load();
    }
  })();

  try {
    await ready;
  } catch (error) {
    if (error.code === 'permission-denied') {
      store.remove(CACHE);
      store.remove('bh_reg');
      if (!urlCode) store.remove('bh_code');
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
  // Friends may read only what Jose marked open. The rules refuse a hangouts
  // query that does not ask for open == true.
  const [settings, blocked, hangouts] = await Promise.all([
    getDoc(doc(db, 'settings', 'main')),
    getDocs(collection(db, 'blocked_slots')),
    getDocs(query(collection(db, 'hangouts'), where('open', '==', true))),
  ]);
  state.settings = settings.data();
  state.blocked = new Map(blocked.docs.map((d) => [d.id, d.data()]));
  state.hangouts = new Map();
  state.hangoutIds = new Set();
  state.participants = new Map();
  await Promise.all(hangouts.docs.map(async (d) => {
    const hangout = { id: d.id, ...d.data() };
    const key = `${hangout.date}_${hangout.slot}`;
    state.hangouts.set(key, [...(state.hangouts.get(key) || []), hangout]);
    state.hangoutIds.add(d.id);
    const names = await getDocs(collection(db, 'hangouts', d.id, 'participants'));
    state.participants.set(d.id, names.docs.map((p) => p.data())
      .sort((x, y) => (x.created_at?.seconds ?? 0) - (y.created_at?.seconds ?? 0)));
  }));

  // What happened to the proposals sent from this device.
  state.receipts = new Map();
  await Promise.all(readSent().map(async (p) => {
    const receipt = await getDoc(doc(db, 'receipts', p.id)).catch(() => null);
    if (receipt?.exists()) state.receipts.set(p.id, receipt.data().status);
  }));
}

// Proposals sent from this device live in localStorage: friends cannot read
// proposals from the server, and a confirmed plan stays private unless Jose
// opens it, so this list is how the proposer still sees their own plan.
function readSent() {
  try { return JSON.parse(store.get('bh_sent') || '[]'); } catch { return []; }
}

// Each kept entry gets a status: 'wait' (no answer yet) or 'mine' (confirmed
// and private). Rejected ones, and confirmed ones that are now open (they
// arrive with the open hangouts), are dropped.
function myPending() {
  const cutoff = Date.now() - PENDING_VISIBLE_DAYS * 24 * 3600 * 1000;
  const list = readSent().filter((p) => {
    const receipt = state.receipts.get(p.id);
    if (receipt === 'rejected' || state.hangoutIds.has(p.id)) return false;
    return receipt === 'approved' || p.at > cutoff;
  });
  store.set('bh_sent', JSON.stringify(list));
  return list.map((p) => ({ ...p, status: state.receipts.get(p.id) === 'approved' ? 'mine' : 'wait' }));
}

const people = (hangout) => state.participants.get(hangout.id) || [];
const isMine = (hangout) => !!state.name && people(hangout).some((p) => nameKey(p.name) === nameKey(state.name));

function slotInfo(date, slotId, pending = myPending()) {
  const key = `${date}_${slotId}`;
  return {
    block: state.blocked.get(key) || null,
    hangouts: state.hangouts.get(key) || [],
    mine: pending.filter((p) => p.date === date && p.slot === slotId),
  };
}

function render() {
  const { trip_start: start, trip_end: end } = state.settings;
  const today = todayInBolivia();
  const pending = myPending();
  const days = tripDays(start, end);

  const short = (iso) => formatDay(iso).replace(/^\S+\s/, '');
  $('lede').textContent = `Del ${short(start)} al ${short(end)}. ${countdownText(start, end, today)}.`;

  let free = 0;
  const cellFor = (date, slotId) => {
    const { block, hangouts, mine } = slotInfo(date, slotId, pending);
    if (hangouts.length) {
      return {
        status: 'plan',
        title: hangouts[0].title,
        sub: people(hangouts[0]).map((p) => p.name).join(', '),
        more: hangouts.length - 1,
      };
    }
    const confirmed = mine.find((p) => p.status === 'mine');
    if (confirmed) return { status: 'plan', title: confirmed.title, sub: 'Confirmado' };
    if (block) {
      // No label: Jose kept it private, so all a friend learns is "taken".
      if (!block.label) return { status: 'off', title: 'Ocupado', merge: 'busy' };
      const own = block.kind === 'personal';
      return { status: own ? 'own' : 'off', title: block.label, merge: `${own}|${block.label}` };
    }
    if (mine.length) return { status: 'wait', title: mine[0].title, sub: 'Por confirmar' };
    if (date < today) return { status: 'gone' };
    free += 1;
    return { status: 'free' };
  };
  $('tt').replaceChildren(renderTimetable({ days, today, cellFor, onPick: openSlot }));

  const mineCount = [...state.hangouts.values()].flat().filter(isMine).length
    + pending.filter((p) => p.status === 'mine').length;
  $('summary').textContent = [
    free ? `${free === 1 ? 'Queda' : 'Quedan'} ${plural(free, 'espacio libre', 'espacios libres')}.` : 'Ya no quedan espacios libres.',
    mineCount ? `Tienes ${plural(mineCount, 'plan', 'planes')} con Jose.` : '',
  ].join(' ');

  $('legend').replaceChildren(legend([
    ['free', 'Libre'], ['plan', 'Plan'], ['wait', 'Tu propuesta, por confirmar'], ['off', 'Ocupado'],
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

$('sheet-close').addEventListener('click', () => $('sheet').close());
// A click on the backdrop (outside the sheet's box) closes it.
$('sheet').addEventListener('click', (event) => { if (event.target === $('sheet')) $('sheet').close(); });

// The name is asked for once, inside the first form that needs it.
function nameField() {
  if (state.name) return null;
  return el('label', {}, 'Tu nombre',
    el('input', { name: 'name', maxLength: LIMITS.name, required: true, autocomplete: 'given-name', placeholder: 'Ej. Caro' }));
}

// Reads the name from a form (when it has the field) and remembers it.
function takeName(form) {
  if (form.elements.name) {
    const name = cleanName(form.elements.name.value);
    if (!name) return false;
    state.name = name;
    store.set('bh_name', name);
  }
  return !!state.name;
}

function changeName() {
  const name = cleanName(prompt('¿Cómo te llamas?', state.name) || '');
  if (!name) return;
  state.name = name;
  store.set('bh_name', name);
  render();
}

function renderSheet() {
  const { date, slotId } = state.open;
  const slot = slotById[slotId];
  const { block, hangouts, mine } = slotInfo(date, slotId);
  const past = date < todayInBolivia();
  // A block that covers the whole day is described as such.
  const wholeDay = block && SLOTS.every((s) => {
    const other = state.blocked.get(`${date}_${s.id}`);
    return other && other.label === block.label && other.kind === block.kind;
  });

  $('sheet-title').textContent = formatDay(date);
  $('sheet-when').textContent = wholeDay ? 'Todo el día' : `${slot.label}, de ${slot.start} a ${slot.end}`;

  const body = [];
  const confirmed = mine.filter((p) => p.status === 'mine');
  const waiting = mine.filter((p) => p.status === 'wait');
  for (const p of confirmed) {
    body.push(el('div', { class: 'entry is-plan' },
      el('h3', {}, p.title),
      el('p', {}, 'Jose confirmó tu plan. Solo tú y Jose lo ven.')));
  }
  if (block && !confirmed.length) {
    body.push(el('div', { class: 'entry is-' + (block.label && block.kind === 'personal' ? 'own' : 'off') },
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
  const joinForm = el('form', { class: 'join', onsubmit: (event) => join(event, hangout) },
    nameField(),
    el('button', { type: 'submit', class: 'btn primary' }, 'Me apunto'));
  return el('div', { class: 'entry is-plan' },
    el('h3', {}, hangout.title),
    hangout.place ? el('p', {}, 'En ' + hangout.place) : null,
    el('p', {}, names.length ? 'Vienen: ' + names.join(', ') : 'Todavía no se apuntó nadie.'),
    past ? null : isMine(hangout) ? el('p', { class: 'done' }, 'Ya estás apuntado.') : joinForm,
  );
}

async function join(event, hangout) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!takeName(form)) return;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await ready.catch(() => {});
    await setDoc(doc(db, 'hangouts', hangout.id, 'participants', nameKey(state.name)),
      { name: state.name, created_at: serverTimestamp() });
    toast('Apuntado.');
  } catch (error) {
    console.error(error);
    toast(error.code === 'permission-denied'
      ? 'Ya hay alguien apuntado con ese nombre. Cambia tu nombre y prueba otra vez.'
      : 'No se pudo apuntar. Revisa tu conexión y prueba otra vez.');
  }
  await load().then(saveCache, console.error);
  render();
}

function proposeForm(date, slotId, another) {
  const error = el('p', { class: 'error', hidden: true });
  const send = el('button', { type: 'submit', class: 'btn primary' }, 'Enviar propuesta');
  const form = el('form', { class: 'propose' },
    el('h3', {}, another ? 'Proponer otro plan' : 'Proponer un plan'),
    nameField(),
    el('label', {}, '¿Qué hacemos?',
      el('input', { name: 'title', maxLength: LIMITS.title, required: true, placeholder: 'Ej. Café y ponernos al día' })),
    el('label', {}, '¿Dónde?',
      el('input', { name: 'place', maxLength: LIMITS.place, placeholder: 'Ej. Zona de la Recoleta' }),
      el('span', { class: 'hint' }, 'Un café o una zona. No pongas direcciones exactas.')),
    el('label', {}, 'Nota para Jose (opcional)',
      el('textarea', { name: 'note', maxLength: LIMITS.note, rows: 2 }),
      el('span', { class: 'hint' }, 'Solo Jose ve tu propuesta. Él decide si los demás ven el plan.')),
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

    const data = {
      date,
      slot: slotId,
      title,
      place: clean(form.elements.place.value, LIMITS.place),
      note: clean(form.elements.note.value, LIMITS.note),
      proposer_name: state.name,
      status: 'pending',
      created_at: serverTimestamp(),
    };
    send.disabled = true;
    error.hidden = true;
    try {
      await ready.catch(() => {});
      const id = await sendProposal(data);
      store.set('bh_sent', JSON.stringify([...readSent(), { id, date, slot: slotId, title, at: Date.now() }]));
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

$('share').addEventListener('click', () => {
  const text = `Jose va a estar en Cochabamba. Propón un plan o apúntate a uno aquí: ${friendLink(state.code)}`;
  window.open(whatsappUrl(text), '_blank', 'noopener');
});

start();
