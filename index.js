// Friends' page: read the approved calendar, propose a hangout, join one.
import { signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  doc, collection, collectionGroup, getDoc, getDocs, setDoc, writeBatch,
  serverTimestamp, increment,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  auth, db, SLOTS, slotById, LIMITS, tripDays, formatDay, todayInBolivia, el, clean,
  cleanName, nameKey, store, friendLink, whatsappUrl, toast, renderCalendar, legend, statTile,
  countdownText, dayParts,
} from './common.js';

const $ = (id) => document.getElementById(id);
const PENDING_VISIBLE_DAYS = 7;

const state = {
  code: null,
  name: cleanName(store.get('bh_name')),
  settings: null,
  filter: 'all',
  blocked: new Map(),     // 'date_slot' -> { label, kind } (kind 'personal' = Jose's own time)
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
  state.blocked = new Map(blocked.docs.map((d) => [d.id, d.data()]));
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

const FILTERS = [
  ['all', 'Todos los días'],
  ['free', 'Con espacio libre'],
  ['plans', 'Con planes'],
  ['mine', 'Mis planes'],
];

const isMine = (hangout) => state.name
  && (state.participants.get(hangout.id) || []).some((p) => nameKey(p.name) === nameKey(state.name));

// Everything the views need to know about one slot.
function slotInfo(date, slotId, pending) {
  const key = `${date}_${slotId}`;
  const block = state.blocked.get(key) || null;
  const hangouts = state.hangouts.get(key) || [];
  const mine = pending.filter((p) => p.date === date && p.slot === slotId);
  // A confirmed plan wins over a block in the overview: it is what people look for.
  const status = hangouts.length ? (hangouts.some(isMine) ? 'hangout mine' : 'hangout')
    : block ? (block.kind === 'personal' ? 'personal' : 'blocked')
    : mine.length ? 'pending' : 'free';
  return { block, hangouts, mine, status };
}

function render() {
  const { trip_start: start, trip_end: end } = state.settings;
  const today = todayInBolivia();
  const pending = myPending();
  const days = tripDays(start, end);
  const info = new Map(days.map((date) => [date, SLOTS.map((slot) => slotInfo(date, slot.id, pending))]));

  const countdown = $('countdown');
  countdown.textContent = countdownText(start, end, today);
  countdown.hidden = false;

  $('hello').replaceChildren(
    state.name ? `Hola, ${state.name}. ` : '',
    el('button', { type: 'button', class: 'link', onclick: askName }, state.name ? 'Cambiar nombre' : 'Decir mi nombre'),
  );

  // Numbers at the top: only days that are still ahead count as free.
  const upcoming = days.filter((date) => date >= today);
  const free = upcoming.reduce((n, date) => n + info.get(date).filter((s) => s.status === 'free').length, 0);
  const myCount = [...state.hangouts.values()].flat().filter(isMine).length;
  $('stats').replaceChildren(
    statTile(state.hangoutIds.size, state.hangoutIds.size === 1 ? 'plan confirmado' : 'planes confirmados', 'tone-hangout'),
    statTile(free, free === 1 ? 'espacio libre' : 'espacios libres', 'tone-free'),
    statTile(myCount, myCount === 1 ? 'plan contigo' : 'planes contigo', 'tone-mine'),
  );

  const describe = (date) => {
    const slots = info.get(date);
    const count = (status) => slots.filter((s) => s.status.startsWith(status)).length;
    return `${count('free')} libres, ${count('hangout')} con plan`;
  };
  $('cal').replaceChildren(renderCalendar({
    days, today, describe,
    stateOf: (date, slotId) => info.get(date)[SLOTS.findIndex((s) => s.id === slotId)].status,
    onPick: goToDay,
  }));
  $('legend').replaceChildren(legend([
    ['free', 'Libre'], ['hangout', 'Plan confirmado'], ['pending', 'Tu propuesta'],
    ['personal', 'Jose ocupado'], ['blocked', 'No disponible'],
  ]));

  $('filters').replaceChildren(...FILTERS.map(([id, label]) => el('button', {
    type: 'button',
    class: 'chip-filter' + (state.filter === id ? ' on' : ''),
    'aria-pressed': String(state.filter === id),
    onclick: () => { state.filter = id; render(); },
  }, label)));

  const matches = (date) => {
    const slots = info.get(date);
    if (state.filter === 'free') return date >= today && slots.some((s) => s.status === 'free');
    if (state.filter === 'plans') return slots.some((s) => s.hangouts.length);
    if (state.filter === 'mine') return slots.some((s) => s.mine.length || s.hangouts.some(isMine));
    return true;
  };
  const shown = days.filter(matches);
  $('no-days').hidden = shown.length > 0;
  $('days').replaceChildren(...shown.map((date) => {
    const past = date < today;
    const { weekday, day, month } = dayParts(date);
    const slots = info.get(date);
    const freeHere = past ? 0 : slots.filter((s) => s.status === 'free').length;
    const plansHere = slots.reduce((n, s) => n + s.hangouts.length, 0);
    return el('article', { class: 'card day' + (past ? ' past' : '') + (date === today ? ' is-today' : ''), id: 'day-' + date },
      el('header', { class: 'day-head' },
        el('div', { class: 'date-block', 'aria-hidden': 'true' },
          el('span', { class: 'dow' }, weekday), el('strong', {}, day), el('span', { class: 'mon' }, month)),
        el('div', {},
          el('h2', {}, formatDay(date)),
          el('p', { class: 'day-sum' },
            date === today ? el('span', { class: 'tag today' }, 'Hoy') : null,
            plansHere ? el('span', { class: 'tag plans' }, plansHere === 1 ? '1 plan' : `${plansHere} planes`) : null,
            freeHere ? el('span', { class: 'tag free' }, freeHere === 1 ? '1 libre' : `${freeHere} libres`) : null,
            !plansHere && !freeHere ? el('span', { class: 'tag' }, past ? 'Ya pasó' : 'Sin espacio') : null,
          )),
      ),
      SLOTS.map((slot, i) => renderSlot(date, slot, past, slots[i])),
    );
  }));
}

function goToDay(date) {
  if (!document.getElementById('day-' + date)) {
    state.filter = 'all';
    render();
  }
  const card = document.getElementById('day-' + date);
  if (!card) return;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  card.classList.remove('flash');
  void card.offsetWidth; // restart the animation
  card.classList.add('flash');
}

function renderSlot(date, slot, past, { block, hangouts, mine, status }) {
  const body = el('div', { class: 'slot-body' });

  if (block) {
    body.append(block.kind === 'personal'
      ? el('p', { class: 'personal' }, el('span', { class: 'who' }, 'Jose'), block.label || 'Ocupado')
      : el('p', { class: 'blocked' }, block.label || 'No disponible'));
  }
  for (const hangout of hangouts) body.append(renderHangout(hangout, past));
  for (const p of mine) {
    body.append(el('p', { class: 'pending' }, `Tu propuesta «${p.title}» espera la confirmación de Jose.`));
  }
  if (!block && !past) {
    const free = status === 'free';
    body.append(el('div', { class: 'slot-actions' },
      free ? el('span', { class: 'free' }, 'Libre') : null,
      el('button', { type: 'button', class: 'btn small' + (free ? ' primary' : ''), onclick: () => openPropose(date, slot) },
        free ? 'Proponer plan' : 'Proponer otro plan'),
    ));
  }

  return el('section', { class: 'slot is-' + status.split(' ')[0] },
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
  return el('div', { class: 'hangout' + (joined ? ' mine' : '') },
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
