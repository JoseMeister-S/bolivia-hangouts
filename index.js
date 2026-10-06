// Friends' page: read the approved calendar, propose a hangout, join one.
import { signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  doc, collection, collectionGroup, getDoc, getDocs, setDoc, writeBatch,
  serverTimestamp, increment,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  auth, db, SLOTS, slotById, LIMITS, tripDays, formatDay, todayInBolivia, el, clean,
  cleanName, nameKey, store, friendLink, whatsappUrl, toast,
} from './common.js';

const $ = (id) => document.getElementById(id);
const PENDING_VISIBLE_DAYS = 7;

const state = {
  code: null,
  name: cleanName(store.get('bh_name')),
  settings: null,
  blocked: new Map(),     // 'date_slot' -> label
  hangouts: new Map(),    // 'date_slot' -> [hangout]
  hangoutIds: new Set(),
  participants: new Map(), // hangout id -> [name]
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

async function start() {
  if (!state.code) return showGate();
  try {
    await auth.authStateReady();
    if (!auth.currentUser) await signInAnonymously(auth);
    // Register the code for this device. A wrong code is refused by the rules.
    await setDoc(doc(db, 'members', auth.currentUser.uid), { code: state.code }).catch(() => {});
    await load();
  } catch (error) {
    if (error.code === 'permission-denied') {
      if (!urlCode) store.remove('bh_code');
      return showGate();
    }
    console.error(error);
    $('status').textContent = 'No se pudo cargar. Revisa tu conexión y vuelve a intentar.';
    return;
  }
  $('status').hidden = true;
  $('calendar').hidden = false;
  render();
  if (!state.name) askName();
}

async function load() {
  const [settings, blocked, hangouts, participants] = await Promise.all([
    getDoc(doc(db, 'settings', 'main')),
    getDocs(collection(db, 'blocked_slots')),
    getDocs(collection(db, 'hangouts')),
    getDocs(collectionGroup(db, 'participants')),
  ]);
  state.settings = settings.data();
  state.blocked = new Map(blocked.docs.map((d) => [d.id, d.data().label]));
  state.hangouts = new Map();
  state.hangoutIds = new Set();
  for (const d of hangouts.docs) {
    const hangout = { id: d.id, ...d.data() };
    const key = `${hangout.date}_${hangout.slot}`;
    state.hangouts.set(key, [...(state.hangouts.get(key) || []), hangout]);
    state.hangoutIds.add(d.id);
  }
  state.participants = new Map();
  for (const d of participants.docs) {
    const hangoutId = d.ref.parent.parent.id;
    state.participants.set(hangoutId, [...(state.participants.get(hangoutId) || []), d.data()]);
  }
  for (const list of state.participants.values()) {
    list.sort((a, b) => (a.created_at?.seconds ?? 0) - (b.created_at?.seconds ?? 0));
  }
}

// Proposals this device sent that are not confirmed yet. Friends cannot read
// pending proposals from the server, so this small list lives in localStorage.
function myPending() {
  let list = [];
  try { list = JSON.parse(store.get('bh_sent') || '[]'); } catch { /* ignore */ }
  const cutoff = Date.now() - PENDING_VISIBLE_DAYS * 24 * 3600 * 1000;
  list = list.filter((p) => !state.hangoutIds.has(p.id) && p.at > cutoff);
  store.set('bh_sent', JSON.stringify(list));
  return list;
}

function render() {
  const { trip_start: start, trip_end: end } = state.settings;
  $('trip-range').textContent = `${formatDay(start).replace(/^\S+\s/, '')} – ${formatDay(end).replace(/^\S+\s/, '')}`;

  $('hello').replaceChildren(
    state.name ? `Hola, ${state.name}. ` : '',
    el('button', { type: 'button', class: 'link', onclick: askName }, state.name ? 'Cambiar nombre' : 'Decir mi nombre'),
  );

  const today = todayInBolivia();
  const pending = myPending();
  $('days').replaceChildren(...tripDays(start, end).map((date) => {
    const past = date < today;
    return el('article', { class: 'card day' + (past ? ' past' : '') },
      el('h2', {}, formatDay(date)),
      SLOTS.map((slot) => renderSlot(date, slot, past, pending)),
    );
  }));
}

function renderSlot(date, slot, past, pending) {
  const key = `${date}_${slot.id}`;
  const blockedLabel = state.blocked.get(key);
  const hangouts = state.hangouts.get(key) || [];
  const mine = pending.filter((p) => p.date === date && p.slot === slot.id);
  const body = el('div', { class: 'slot-body' });

  if (blockedLabel != null) {
    body.append(el('p', { class: 'blocked' }, blockedLabel || 'No disponible'));
  }
  for (const hangout of hangouts) body.append(renderHangout(hangout, past));
  for (const p of mine) {
    body.append(el('p', { class: 'pending' }, `Tu propuesta «${p.title}» espera la confirmación de Jose.`));
  }
  if (blockedLabel == null && !past) {
    const free = hangouts.length === 0 && mine.length === 0;
    body.append(el('div', { class: 'slot-actions' },
      free ? el('span', { class: 'free' }, 'Libre') : null,
      el('button', { type: 'button', class: 'btn small' + (free ? ' primary' : ''), onclick: () => openPropose(date, slot) },
        free ? 'Proponer plan' : 'Proponer otro plan'),
    ));
  }

  return el('section', { class: 'slot' + (blockedLabel != null ? ' is-blocked' : '') },
    el('div', { class: 'slot-head' },
      el('span', { class: 'slot-name' }, slot.label),
      el('span', { class: 'slot-time' }, `${slot.start}–${slot.end}`),
    ),
    body,
  );
}

function renderHangout(hangout, past) {
  const people = state.participants.get(hangout.id) || [];
  const joined = state.name && people.some((p) => nameKey(p.name) === nameKey(state.name));
  return el('div', { class: 'hangout' },
    el('p', { class: 'hangout-title' }, hangout.title),
    hangout.place ? el('p', { class: 'hangout-place' }, hangout.place) : null,
    el('p', { class: 'hangout-people' },
      people.length ? 'Vienen: ' + people.map((p) => p.name).join(', ') : 'Todavía nadie se apuntó.'),
    past ? null
      : joined ? el('p', { class: 'joined' }, '✓ Ya estás apuntado')
      : el('button', { type: 'button', class: 'btn small primary', onclick: (event) => join(hangout, event.currentTarget) }, 'Me apunto'),
  );
}

// ---- Name ----

let afterName = null;

function askName(then = null) {
  afterName = typeof then === 'function' ? then : null;
  $('name-form').elements.name.value = state.name;
  $('name-dialog').showModal();
}

$('name-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = cleanName($('name-form').elements.name.value);
  if (!name) return;
  state.name = name;
  store.set('bh_name', name);
  $('name-dialog').close();
  render();
  const next = afterName;
  afterName = null;
  if (next) next();
});

// ---- Join ----

async function join(hangout, button) {
  if (!state.name) return askName(() => join(hangout, null));
  if (button) button.disabled = true;
  try {
    await setDoc(doc(db, 'hangouts', hangout.id, 'participants', nameKey(state.name)),
      { name: state.name, created_at: serverTimestamp() });
    toast('¡Listo! Estás apuntado.');
  } catch (error) {
    console.error(error);
    toast(error.code === 'permission-denied'
      ? 'Ya hay alguien apuntado con ese nombre. Cambia tu nombre y prueba otra vez.'
      : 'No se pudo apuntar. Intenta de nuevo.');
  }
  await load().catch(console.error);
  render();
}

// ---- Propose ----

let proposing = null;

function openPropose(date, slot) {
  if (!state.name) return askName(() => openPropose(date, slot));
  proposing = { date, slot: slot.id };
  $('propose-form').reset();
  $('propose-error').hidden = true;
  $('propose-when').textContent = `${formatDay(date)} · ${slot.label} (${slot.start}–${slot.end})`;
  $('propose-dialog').showModal();
}

$('propose-cancel').addEventListener('click', () => $('propose-dialog').close());

$('propose-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = $('propose-form');
  const title = clean(form.elements.title.value, LIMITS.title);
  if (!title || !proposing) return;

  // Honeypot filled in: act as if it worked, send nothing.
  if (form.elements.website.value) {
    $('propose-dialog').close();
    return toast('¡Enviado! Jose lo confirma pronto.');
  }

  const data = {
    ...proposing,
    title,
    place: clean(form.elements.place.value, LIMITS.place),
    note: clean(form.elements.note.value, LIMITS.note),
    proposer_name: state.name,
    status: 'pending',
    created_at: serverTimestamp(),
  };
  $('propose-send').disabled = true;
  $('propose-error').hidden = true;
  try {
    const id = await sendProposal(data);
    const sent = myPending();
    sent.push({ id, date: data.date, slot: data.slot, title, at: Date.now() });
    store.set('bh_sent', JSON.stringify(sent));
    $('propose-dialog').close();
    toast('¡Enviado! Jose lo confirma pronto.');
    render();
  } catch (error) {
    console.error(error);
    $('propose-error').textContent = error.code === 'permission-denied'
      ? 'No se pudo enviar. Puede que ese espacio ya no esté disponible o que haya demasiadas propuestas hoy. Prueba más tarde.'
      : 'No se pudo enviar. Revisa tu conexión e intenta de nuevo.';
    $('propose-error').hidden = false;
  } finally {
    $('propose-send').disabled = false;
  }
});

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
