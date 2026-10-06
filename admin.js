// Admin page: approve/reject/edit proposals, manage approved hangouts,
// participants, blocked slots and the invite code, and export an .ics file.
// Every write here is allowed only because firestore.rules finds the signed-in
// user in the `admins` collection.
import {
  GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  doc, collection, collectionGroup, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  writeBatch, serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  auth, db, SLOTS, slotById, slotIndex, LIMITS, tripDays, formatDay, formatDayShort, el,
  clean, cleanName, nameKey, friendLink, whatsappUrl, toast, todayInBolivia, renderTimetable,
  legend, countdownText, plural, SLOT_HOURS,
} from './common.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['status', 'login', 'not-admin', 'setup', 'panel'];
const show = (id) => VIEWS.forEach((view) => { $(view).hidden = view !== id; });

const TRIP = { start: '2026-12-14', end: '2027-01-02' };
const ALL = SLOTS.map((s) => s.id);
const SEED_BLOCKS = [
  ['2026-12-14', ALL, 'Llegando a Cochabamba (21:55)'],
  ['2026-12-24', ['tarde', 'noche'], 'Nochebuena en familia'],
  ['2026-12-25', ALL, 'Navidad en familia'],
  ['2026-12-31', ['tarde', 'noche'], 'Año Nuevo'],
  ['2027-01-01', ['manana', 'almuerzo'], 'Año Nuevo'],
  ['2027-01-02', ['tarde', 'noche'], 'Vuelo de vuelta'],
];

// reservations: my own time and blocks, with their real labels (admin-only).
// blocked: the public projection friends read ("taken", plus a label only when open).
const state = { settings: null, proposals: [], hangouts: [], participants: new Map(), reservations: [], blocked: [] };

const bySlot = (a, b) =>
  a.date.localeCompare(b.date) || slotIndex(a.slot) - slotIndex(b.slot)
  || (a.created_at?.seconds ?? 0) - (b.created_at?.seconds ?? 0);
const slotKey = (item) => `${item.date}_${item.slot}`;

function randomCode(length = 20) {
  // No look-alike characters (0/O, 1/l/I), easy to read aloud if needed.
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
  let code = '';
  for (const byte of bytes) {
    // Rejection sampling keeps the distribution uniform.
    if (byte < alphabet.length * 4 && code.length < length) code += alphabet[byte % alphabet.length];
  }
  return code.length === length ? code : randomCode(length);
}

// Run a write, then reload everything. Keeps the screen and the database equal.
async function act(fn, done) {
  try {
    await fn();
    if (done) toast(done);
  } catch (error) {
    console.error(error);
    toast('Error: ' + (error.code || error.message));
  }
  await refresh();
}

// ---- Auth ----

onAuthStateChanged(auth, async (user) => {
  // The friends' page signs in anonymously on this same origin; that is not a login.
  if (!user || user.isAnonymous) {
    $('who').textContent = '';
    return show('login');
  }
  $('who').textContent = user.email ? `Entraste como ${user.email}.` : '';
  const admin = await getDoc(doc(db, 'admins', user.uid)).then((snap) => snap.exists(), () => false);
  if (!admin) {
    $('uid').textContent = user.uid;
    return show('not-admin');
  }
  await refresh();
});

$('login-btn').addEventListener('click', async () => {
  $('login-error').hidden = true;
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (error) {
    console.error(error);
    $('login-error').textContent = 'No se pudo entrar: ' + (error.code || error.message);
    $('login-error').hidden = false;
  }
});
$('logout').addEventListener('click', () => signOut(auth));
$('logout-2').addEventListener('click', () => signOut(auth));
$('copy-uid').addEventListener('click', () => copy($('uid').textContent));

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado.');
  } catch {
    toast('No se pudo copiar. Selecciona el texto a mano.');
  }
}

// ---- Load ----

async function refresh() {
  try {
    const settings = await getDoc(doc(db, 'settings', 'main'));
    if (!settings.exists()) return show('setup');
    const [proposals, hangouts, participants, reservations, blocked] = await Promise.all([
      getDocs(collection(db, 'proposals')),
      getDocs(collection(db, 'hangouts')),
      getDocs(collectionGroup(db, 'participants')),
      getDocs(collection(db, 'reservations')),
      getDocs(collection(db, 'blocked_slots')),
    ]);
    const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    state.settings = settings.data();
    state.proposals = rows(proposals).sort(bySlot);
    state.hangouts = rows(hangouts).sort(bySlot);
    state.reservations = rows(reservations).sort(bySlot);
    state.blocked = rows(blocked);
    state.participants = new Map();
    for (const d of participants.docs) {
      const hangoutId = d.ref.parent.parent.id;
      const list = state.participants.get(hangoutId) || [];
      list.push({ key: d.id, ...d.data() });
      state.participants.set(hangoutId, list);
    }
    await syncPublic();
    render();
    show('panel');
  } catch (error) {
    console.error(error);
    $('status').textContent = 'No se pudo cargar: ' + (error.code || error.message);
    show('status');
  }
}

// ---- What friends may see ----

// Friends never read reservations or private plans. They read `blocked_slots`:
// one document per taken slot, with a label only if I opened that item. This
// rebuilds that projection from my data and writes just the differences, so
// every action in this file can simply change the private data and reload.
async function syncPublic() {
  const batch = writeBatch(db);
  let writes = 0;

  // One-time upgrade of data from before the privacy model: old blocks keep
  // the label friends already saw (open), old plans become private.
  if (state.settings.schema !== 2) {
    for (const b of state.blocked) {
      if (!b.label || b.kind === 'busy' || state.reservations.some((r) => r.id === b.id)) continue;
      const reservation = { date: b.date, slot: b.slot, label: b.label, kind: b.kind === 'personal' ? 'personal' : 'block', open: true };
      batch.set(doc(db, 'reservations', b.id), reservation);
      state.reservations.push({ id: b.id, ...reservation });
    }
    state.reservations.sort(bySlot);
    for (const h of state.hangouts) {
      if (typeof h.open === 'boolean') continue;
      batch.update(doc(db, 'hangouts', h.id), { open: false });
      h.open = false;
    }
    batch.update(doc(db, 'settings', 'main'), { schema: 2 });
    state.settings.schema = 2;
    writes += 1;
  }

  const wanted = new Map();
  for (const r of state.reservations) {
    wanted.set(r.id, { date: r.date, slot: r.slot, label: r.open ? r.label : '', kind: r.kind });
  }
  for (const h of state.hangouts) {
    const id = `${h.date}_${h.slot}`;
    if (!h.open && !wanted.has(id)) wanted.set(id, { date: h.date, slot: h.slot, label: '', kind: 'busy' });
  }
  for (const b of state.blocked) {
    const want = wanted.get(b.id);
    wanted.delete(b.id);
    if (!want) batch.delete(doc(db, 'blocked_slots', b.id));
    else if (want.label !== b.label || want.kind !== b.kind) batch.set(doc(db, 'blocked_slots', b.id), want);
    else continue;
    writes += 1;
  }
  for (const [id, want] of wanted) {
    batch.set(doc(db, 'blocked_slots', id), want);
    writes += 1;
  }
  if (writes) await batch.commit();
}

// ---- First-time setup ----

$('setup-btn').addEventListener('click', () => act(async () => {
  const batch = writeBatch(db);
  batch.set(doc(db, 'settings', 'main'), { invite_code: randomCode(), trip_start: TRIP.start, trip_end: TRIP.end, schema: 2 });
  // A window that started in 1970 is already over, so the first proposal opens a new one.
  batch.set(doc(db, 'counters', 'proposals'), { count: 0, window_start: Timestamp.fromMillis(0), last_id: '' });
  for (const [date, slots, label] of SEED_BLOCKS) {
    // Travel and family days: friends see the label, so they know why.
    for (const slot of slots) batch.set(doc(db, 'reservations', `${date}_${slot}`), { date, slot, label, kind: 'block', open: true });
  }
  await batch.commit();
}, 'Calendario creado.'));

// ---- Render ----

const blockAt = (date, slotId) => state.reservations.find((r) => r.id === `${date}_${slotId}`) || null;
const setOpen = (collectionName, items, open) => act(async () => {
  const batch = writeBatch(db);
  for (const item of items) batch.update(doc(db, collectionName, item.id), { open });
  await batch.commit();
}, open ? 'Ahora es abierto: tus amigos lo ven.' : 'Ahora es privado: tus amigos ven «Ocupado».');
const hangoutsAt = (date, slotId) => state.hangouts.filter((h) => h.date === date && h.slot === slotId);
const pendingAt = (date, slotId) =>
  state.proposals.filter((p) => p.status === 'pending' && p.date === date && p.slot === slotId);
const namesOf = (hangout) => (state.participants.get(hangout.id) || []).map((p) => p.name);
const slotName = (item) => slotById[item.slot]?.label ?? item.slot;
const whenText = (item) => `${formatDay(item.date)}, ${slotName(item).toLowerCase()}`;

let openSlotRef = null; // { date, slotId } of the slot shown in the sheet

function render() {
  const { trip_start: start, trip_end: end, invite_code: code } = state.settings;
  const today = todayInBolivia();
  const days = tripDays(start, end);
  const pending = state.proposals.filter((p) => p.status === 'pending');
  const rejected = state.proposals.filter((p) => p.status !== 'pending');
  const people = peopleSummary();

  let free = 0;
  const cellFor = (date, slotId) => {
    const block = blockAt(date, slotId);
    const hangouts = hangoutsAt(date, slotId);
    const waiting = pendingAt(date, slotId);
    if (hangouts.length) {
      return {
        status: 'plan',
        title: hangouts[0].title,
        sub: namesOf(hangouts[0]).join(', '),
        more: hangouts.length - 1 + waiting.length,
        alert: hangouts.length > 1 || !!block, // two plans, or a plan on reserved time
        open: hangouts[0].open,
      };
    }
    if (block) {
      const own = block.kind === 'personal';
      return {
        status: own ? 'own' : 'off', title: block.label, more: waiting.length, open: block.open,
        merge: waiting.length ? null : `${own}|${block.open}|${block.label}`,
      };
    }
    if (waiting.length) return { status: 'wait', title: waiting[0].title, sub: waiting[0].proposer_name, more: waiting.length - 1 };
    if (date < today) return { status: 'gone' };
    free += 1;
    return { status: 'free' };
  };
  $('tt').replaceChildren(renderTimetable({ days, today, cellFor, onPick: openSlot }));

  $('summary').textContent = [
    pending.length ? `${plural(pending.length, 'propuesta', 'propuestas')} por confirmar.` : 'Nada por confirmar.',
    state.hangouts.length
      ? `${plural(state.hangouts.length, 'plan confirmado', 'planes confirmados')} con ${plural(people.length, 'persona', 'personas')}.`
      : 'Todavía no hay planes confirmados.',
    `${free === 1 ? 'Queda' : 'Quedan'} ${plural(free, 'espacio libre', 'espacios libres')}.`,
    countdownText(start, end, today) + '.',
  ].join(' ');

  $('legend').replaceChildren(legend([
    ['free', 'Libre'], ['wait', 'Por confirmar'], ['plan', 'Confirmado'], ['plan is-alert', 'Choque'],
    ['own', 'Mi tiempo'], ['off', 'Bloqueado'], ['own is-open', 'Con punto: abierto, mis amigos lo ven'],
  ]));

  $('pending').replaceChildren(...(pending.length ? pending.map(renderPending)
    : [el('p', { class: 'empty' }, 'Cuando un amigo proponga un plan, aparece aquí para que lo confirmes.')]));
  $('people').replaceChildren(renderPeople(people));
  $('blocked').replaceChildren(renderBlockGroups());
  $('link').textContent = friendLink(code);
  $('rejected-count').textContent = rejected.length;
  $('rejected').replaceChildren(...(rejected.length ? rejected.map(renderRejected)
    : [el('p', { class: 'empty' }, 'No rechazaste ninguna propuesta.')]));

  $('edit-form').elements.date.replaceChildren(...days.map((d) => el('option', { value: d }, formatDay(d))));
  $('edit-form').elements.slot.replaceChildren(...SLOTS.map((s) => el('option', { value: s.id }, s.label)));

  if ($('sheet').open && openSlotRef) renderSheet();
}

// What already occupies the slot of a pending proposal.
function conflictsFor(proposal) {
  const warnings = [];
  const block = blockAt(proposal.date, proposal.slot);
  if (block) warnings.push(`Ese espacio está reservado: ${block.label}.`);
  for (const h of hangoutsAt(proposal.date, proposal.slot)) {
    warnings.push(`Ya confirmaste «${h.title}» con ${h.proposer_name} en ese espacio.`);
  }
  const others = pendingAt(proposal.date, proposal.slot).filter((p) => p.id !== proposal.id);
  if (others.length) warnings.push(`Hay otra propuesta para ese espacio: ${others.map((p) => `«${p.title}»`).join(', ')}.`);
  return warnings;
}

function proposalText(p) {
  return [
    el('h3', {}, p.title),
    el('p', {}, `${p.proposer_name} propone esto para el ${whenText(p)}${p.place ? ', en ' + p.place : ''}.`),
    p.note ? el('p', { class: 'note' }, `«${p.note}»`) : null,
  ];
}

// The receipt is how the proposer's device learns the answer: it can be read
// only by someone who knows the proposal id.
const rejectProposal = (p) => act(async () => {
  const batch = writeBatch(db);
  batch.update(doc(db, 'proposals', p.id), { status: 'rejected' });
  batch.set(doc(db, 'receipts', p.id), { status: 'rejected' });
  await batch.commit();
}, 'Rechazada.');

function pendingActions(p) {
  const open = el('input', { type: 'checkbox' });
  return el('div', { class: 'actions' },
    el('label', { class: 'check' }, open, 'Abierto: los demás lo ven y se pueden apuntar'),
    el('button', { type: 'button', class: 'btn primary', onclick: () => approve(p, open.checked) }, 'Aprobar'),
    el('button', { type: 'button', class: 'btn', onclick: () => openEdit('proposals', p) }, 'Editar'),
    el('button', { type: 'button', class: 'btn text', onclick: () => rejectProposal(p) }, 'Rechazar'));
}

function renderPending(p) {
  return el('article', { class: 'entry is-wait' },
    proposalText(p),
    conflictsFor(p).map((warning) => el('p', { class: 'warn' }, warning)),
    pendingActions(p));
}

function renderRejected(p) {
  return el('article', { class: 'entry' },
    proposalText(p),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => act(async () => {
        const batch = writeBatch(db);
        batch.update(doc(db, 'proposals', p.id), { status: 'pending' });
        batch.delete(doc(db, 'receipts', p.id));
        await batch.commit();
      }, 'Devuelta a por confirmar.') }, 'Volver a considerar'),
      el('button', { type: 'button', class: 'btn text', onclick: () => confirm(`¿Borrar la propuesta «${p.title}»? No se puede deshacer.`) && act(() => deleteDoc(doc(db, 'proposals', p.id)), 'Borrada.') }, 'Borrar')));
}

// ---- Who I spend time with ----

// One entry per person, from the participants of confirmed hangouts.
function peopleSummary() {
  const people = new Map();
  for (const h of state.hangouts) {
    for (const person of state.participants.get(h.id) || []) {
      const entry = people.get(person.key) || { name: person.name, hangouts: [], hours: 0 };
      entry.hangouts.push(h);
      entry.hours += SLOT_HOURS[h.slot] || 0;
      people.set(person.key, entry);
    }
  }
  return [...people.values()].sort((a, b) =>
    b.hangouts.length - a.hangouts.length || a.name.localeCompare(b.name, 'es'));
}

function renderPeople(people) {
  if (!people.length) return el('p', { class: 'empty' }, 'Cuando confirmes planes, aquí ves con quién pasas más tiempo.');
  return el('ul', { class: 'people' }, people.map((person) => {
    const times = person.hangouts.length;
    return el('li', {},
      el('details', {},
        el('summary', {},
          el('span', { class: 'person-name' }, person.name),
          // One square per confirmed plan: the same tiles as the timetable.
          el('span', { class: 'tiles', 'aria-hidden': 'true' }, person.hangouts.map(() => el('i'))),
          el('span', { class: 'person-count' }, `${times === 1 ? '1 vez' : times + ' veces'}, unas ${person.hours.toLocaleString('es')} h`),
        ),
        el('ul', {}, person.hangouts.map((h) => el('li', {}, `${whenText(h)}: ${h.title}`))),
      ));
  }));
}

// ---- My time and blocks ----

// Same label on many slots (gym every morning, a whole family day) is one row.
function renderBlockGroups() {
  if (!state.reservations.length) return el('p', { class: 'empty' }, 'No tienes nada reservado. Toca un espacio libre del calendario para reservarlo.');
  const groups = new Map();
  for (const b of state.reservations) {
    const key = `${b.kind === 'personal'}|${b.open}|${b.label}`;
    groups.set(key, [...(groups.get(key) || []), b]);
  }
  const remove = (items, done) => act(async () => {
    const batch = writeBatch(db);
    for (const b of items) batch.delete(doc(db, 'reservations', b.id));
    await batch.commit();
  }, done);
  return el('ul', { class: 'groups' }, [...groups.values()].map((items) => {
    const first = items[0];
    const days = new Set(items.map((b) => b.date)).size;
    const oneSlot = items.every((b) => b.slot === first.slot);
    const where = items.length === 1 ? whenText(first)
      : oneSlot ? `${slotName(first).toLowerCase()}, ${days} días`
      : days === 1 ? `${formatDay(first.date)}, ${items.length} espacios`
      : `${items.length} espacios en ${days} días`;
    return el('li', {},
      el('details', {},
        el('summary', {},
          el('i', { class: 'swatch is-' + (first.kind === 'personal' ? 'own' : 'off') }),
          el('strong', {}, first.label), ' ', el('span', { class: 'where' }, `${first.open ? 'Abierto' : 'Privado'}, ${where}`)),
        el('ul', {}, items.map((b) => el('li', {},
          el('span', {}, whenText(b)),
          el('button', { type: 'button', class: 'btn text', onclick: () => remove([b], 'Quitado.') }, 'Quitar')))),
      ),
      el('button', { type: 'button', class: 'btn text', onclick: () => setOpen('reservations', items, !first.open) },
        first.open ? 'Hacer privado' : 'Hacer abierto'),
      el('button', {
        type: 'button', class: 'btn text',
        onclick: () => (items.length === 1 || confirm(`¿Quitar «${first.label}» de los ${items.length} espacios?`)) && remove(items, 'Quitado.'),
      }, items.length === 1 ? 'Quitar' : 'Quitar todo'),
    );
  }));
}

// ---- Slot sheet (opened from the timetable) ----

function openSlot(date, slotId) {
  openSlotRef = { date, slotId };
  renderSheet();
  if (!$('sheet').open) $('sheet').showModal();
}

$('sheet-close').addEventListener('click', () => $('sheet').close());
$('sheet').addEventListener('click', (event) => { if (event.target === $('sheet')) $('sheet').close(); });

function renderSheet() {
  const { date, slotId } = openSlotRef;
  const slot = slotById[slotId];
  const block = blockAt(date, slotId);
  const hangouts = hangoutsAt(date, slotId);
  const waiting = pendingAt(date, slotId);

  $('sheet-title').textContent = formatDay(date);
  $('sheet-when').textContent = `${slot.label}, de ${slot.start} a ${slot.end}`;

  const body = [];
  if (hangouts.length > 1) body.push(el('p', { class: 'warn' }, `Hay ${hangouts.length} planes confirmados en este espacio.`));
  if (hangouts.length && block) body.push(el('p', { class: 'warn' }, 'Hay un plan confirmado sobre tiempo reservado.'));
  if (block) {
    body.push(el('div', { class: 'entry is-' + (block.kind === 'personal' ? 'own' : 'off') },
      el('h3', {}, block.label),
      el('p', {}, block.open ? 'Abierto: mis amigos ven este texto.' : 'Privado: mis amigos solo ven «Ocupado».'),
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'btn', onclick: () => setOpen('reservations', [block], !block.open) }, block.open ? 'Hacer privado' : 'Hacer abierto'),
        el('button', { type: 'button', class: 'btn text', onclick: () => act(() => deleteDoc(doc(db, 'reservations', block.id)), 'Quitado.') }, 'Quitar reserva'))));
  }
  for (const h of hangouts) body.push(renderHangout(h));
  for (const p of waiting) body.push(renderPending(p));
  if (!block) body.push(reserveForm(date, slot));
  $('sheet-body').replaceChildren(...body);
}

function renderHangout(h) {
  const people = state.participants.get(h.id) || [];
  return el('div', { class: 'entry is-plan' },
    el('h3', {}, h.title),
    el('p', {}, `Lo propuso ${h.proposer_name}${h.place ? ', en ' + h.place : ''}.`),
    h.note ? el('p', { class: 'note' }, `«${h.note}»`) : null,
    el('p', {}, h.open ? 'Abierto: mis amigos lo ven y se pueden apuntar.' : 'Privado: los demás solo ven «Ocupado».'),
    el('ul', { class: 'chips', 'aria-label': 'Quién viene' },
      people.map((person) => el('li', {}, person.name,
        el('button', {
          type: 'button', 'aria-label': `Quitar a ${person.name}`,
          onclick: () => confirm(`¿Quitar a ${person.name} de «${h.title}»?`)
            && act(() => deleteDoc(doc(db, 'hangouts', h.id, 'participants', person.key)), 'Quitado.'),
        }, '×'))),
      el('li', { class: 'add' }, el('button', { type: 'button', onclick: () => addParticipant(h) }, 'Añadir persona'))),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => setOpen('hangouts', [h], !h.open) }, h.open ? 'Hacer privado' : 'Hacer abierto'),
      el('button', { type: 'button', class: 'btn', onclick: () => openEdit('hangouts', h) }, 'Editar'),
      el('button', { type: 'button', class: 'btn text', onclick: () => removeHangout(h) }, 'Borrar plan')));
}

const PRESETS = ['Gimnasio', 'Trabajo', 'Familia', 'Descanso'];

// Reserve this slot for myself, optionally repeated across the trip.
function reserveForm(date, slot) {
  const label = el('input', { name: 'label', maxLength: 80, required: true, placeholder: 'Ej. Gimnasio' });
  const lower = slot.label.toLowerCase();
  const repeat = el('select', { name: 'repeat' },
    el('option', { value: 'once' }, `Solo este día, ${lower}`),
    el('option', { value: 'day' }, 'Este día completo'),
    el('option', { value: 'weekdays' }, `De lunes a viernes, ${lower}, todo el viaje`),
    el('option', { value: 'daily' }, `Todos los días, ${lower}, todo el viaje`));
  const who = el('select', { name: 'who' },
    el('option', { value: 'private' }, 'Solo yo. Mis amigos ven «Ocupado»'),
    el('option', { value: 'open' }, 'Mis amigos ven el texto'),
    el('option', { value: 'join' }, 'Mis amigos ven el texto y se pueden apuntar'));
  const form = el('form', { class: 'reserve' },
    el('h3', {}, 'Reservar para mí'),
    el('label', {}, '¿Para qué?', label),
    el('div', { class: 'presets' }, PRESETS.map((name) =>
      el('button', { type: 'button', class: 'btn small', onclick: () => { label.value = name; } }, name))),
    el('label', {}, '¿Cuándo?', repeat),
    el('label', {}, '¿Quién lo ve?', who),
    el('button', { type: 'submit', class: 'btn primary' }, 'Reservar'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = clean(label.value, 80);
    if (!text) return;
    const days = tripDays(state.settings.trip_start, state.settings.trip_end);
    const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
    const targets = {
      once: [{ date, slot: slot.id }],
      day: ALL.map((id) => ({ date, slot: id })),
      weekdays: days.filter((d) => weekday(d) >= 1 && weekday(d) <= 5).map((d) => ({ date: d, slot: slot.id })),
      daily: days.map((d) => ({ date: d, slot: slot.id })),
    }[repeat.value];
    // Slots that already have a reservation keep it. Slots with a confirmed
    // plan are reserved too and show up as a conflict, so I can decide.
    const fresh = targets.filter((t) => !blockAt(t.date, t.slot));
    const skipped = targets.length - fresh.length;
    const busy = fresh.filter((t) => hangoutsAt(t.date, t.slot).length).length;
    $('sheet').close();
    const joinable = who.value === 'join';
    act(async () => {
      const batch = writeBatch(db);
      for (const t of fresh) {
        // Something friends can join is a plan of mine; anything else is reserved time.
        if (joinable) {
          batch.set(doc(collection(db, 'hangouts')), {
            date: t.date, slot: t.slot, title: text, place: '', proposer_name: 'Jose', note: '', open: true, created_at: serverTimestamp(),
          });
        } else {
          batch.set(doc(db, 'reservations', `${t.date}_${t.slot}`), { date: t.date, slot: t.slot, label: text, kind: 'personal', open: who.value === 'open' });
        }
      }
      await batch.commit();
    }, [
      `Reservado en ${plural(fresh.length, 'espacio', 'espacios')}.`,
      skipped ? `${plural(skipped, 'ya estaba reservado', 'ya estaban reservados')}.` : '',
      busy ? `${plural(busy, 'choca', 'chocan')} con un plan confirmado.` : '',
    ].filter(Boolean).join(' '));
  });
  return form;
}

// ---- Actions ----

// Approving moves the proposal into `hangouts`, the only collection friends
// can read, and adds the proposer as the first participant.
function approve(p, open = false) {
  return act(async () => {
    const batch = writeBatch(db);
    batch.set(doc(db, 'hangouts', p.id), {
      date: p.date, slot: p.slot, title: p.title, place: p.place,
      proposer_name: p.proposer_name, note: p.note, open, created_at: p.created_at ?? serverTimestamp(),
    });
    batch.set(doc(db, 'receipts', p.id), { status: 'approved' });
    const name = cleanName(p.proposer_name);
    if (name && name !== '.' && name !== '..') {
      batch.set(doc(db, 'hangouts', p.id, 'participants', nameKey(name)), { name, created_at: serverTimestamp() });
    }
    batch.delete(doc(db, 'proposals', p.id));
    await batch.commit();
  }, open ? 'Aprobado y abierto: tus amigos lo ven.' : `Aprobado. Solo ${p.proposer_name} y tú lo ven.`);
}

function removeHangout(h) {
  if (!confirm(`¿Borrar el plan «${h.title}»? Tus amigos dejan de verlo.`)) return;
  act(async () => {
    const batch = writeBatch(db);
    for (const person of state.participants.get(h.id) || []) {
      batch.delete(doc(db, 'hangouts', h.id, 'participants', person.key));
    }
    batch.delete(doc(db, 'hangouts', h.id));
    batch.set(doc(db, 'receipts', h.id), { status: 'rejected' });
    await batch.commit();
  }, 'Plan borrado.');
}

function addParticipant(h) {
  const name = cleanName(prompt(`¿Quién más viene a «${h.title}»?`) || '');
  if (!name || name === '.' || name === '..') return;
  act(() => setDoc(doc(db, 'hangouts', h.id, 'participants', nameKey(name)), { name, created_at: serverTimestamp() }), 'Añadido.');
}

let editing = null;

function openEdit(collectionName, item) {
  editing = { collectionName, id: item.id };
  const fields = $('edit-form').elements;
  for (const name of ['date', 'slot', 'title', 'place', 'proposer_name', 'note']) fields[name].value = item[name] ?? '';
  $('edit-dialog').showModal();
}

$('edit-cancel').addEventListener('click', () => $('edit-dialog').close());

$('edit-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const fields = $('edit-form').elements;
  const data = {
    date: fields.date.value,
    slot: fields.slot.value,
    title: clean(fields.title.value, LIMITS.title),
    place: clean(fields.place.value, LIMITS.place),
    proposer_name: cleanName(fields.proposer_name.value),
    note: clean(fields.note.value, LIMITS.note),
  };
  if (!editing || !data.title || !data.proposer_name) return;
  const { collectionName, id } = editing;
  $('edit-dialog').close();
  // The slot may have changed: follow the item to its new place.
  if ($('sheet').open) openSlotRef = { date: data.date, slotId: data.slot };
  act(() => updateDoc(doc(db, collectionName, id), data), 'Cambios guardados.');
});

$('copy-link').addEventListener('click', () => copy($('link').textContent));
$('share-link').addEventListener('click', () => {
  const text = `¡Voy a Cochabamba! Propón un plan o apúntate a uno aquí: ${$('link').textContent}`;
  window.open(whatsappUrl(text), '_blank', 'noopener');
});
$('rotate').addEventListener('click', () => {
  if (!confirm('¿Cambiar el código? Todos los enlaces que ya mandaste dejan de funcionar.')) return;
  act(() => updateDoc(doc(db, 'settings', 'main'), { invite_code: randomCode() }), 'Código cambiado. Manda el enlace nuevo.');
});

// ---- .ics export ----

function buildIcs(hangouts) {
  const escape = (text) => String(text ?? '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  // RFC 5545: lines are at most 75 octets; continuation lines start with a space.
  const encoder = new TextEncoder();
  const fold = (line) => {
    const parts = [];
    let current = '';
    let size = 0;
    for (const char of line) {
      const length = encoder.encode(char).length;
      if (size + length > 75) {
        parts.push(current);
        current = ' ';
        size = 1;
      }
      current += char;
      size += length;
    }
    parts.push(current);
    return parts.join('\r\n');
  };
  const local = (date, time) => `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//bolivia-hangouts//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Cochabamba',
    'X-WR-TIMEZONE:America/La_Paz',
    'BEGIN:VTIMEZONE',
    'TZID:America/La_Paz',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0400',
    'TZNAME:-04',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
  for (const h of hangouts) {
    const slot = slotById[h.slot];
    if (!slot) continue;
    const people = (state.participants.get(h.id) || []).map((p) => p.name);
    const description = [
      `Propuesto por ${h.proposer_name}`,
      `Vienen: ${people.length ? people.join(', ') : 'nadie todavía'}`,
      h.note ? `Nota: ${h.note}` : null,
    ].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${h.id}@bolivia-hangouts`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=America/La_Paz:${local(h.date, slot.start)}`,
      `DTEND;TZID=America/La_Paz:${local(h.date, slot.end)}`,
      `SUMMARY:${escape(h.title)}`,
      h.place ? `LOCATION:${escape(h.place)}` : null,
      `DESCRIPTION:${escape(description)}`,
      'END:VEVENT',
    );
  }
  for (const b of state.reservations.filter((b) => b.kind === 'personal')) {
    const slot = slotById[b.slot];
    if (!slot) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${b.id}@bolivia-hangouts`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=America/La_Paz:${local(b.date, slot.start)}`,
      `DTEND;TZID=America/La_Paz:${local(b.date, slot.end)}`,
      `SUMMARY:${escape(b.label)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).map(fold).join('\r\n') + '\r\n';
}

$('export').addEventListener('click', () => {
  if (!state.hangouts.length && !state.reservations.some((b) => b.kind === 'personal')) return toast('Todavía no hay planes ni reservas que descargar.');
  const blob = new Blob([buildIcs(state.hangouts)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: 'cochabamba.ics' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
