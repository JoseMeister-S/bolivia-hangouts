// Admin page: approve/reject/edit proposals, manage approved hangouts,
// participants, reservations and the invite code, and export an .ics file.
// Every write here is allowed only because firestore.rules finds the signed-in
// user in the `admins` collection.
import {
  GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from 'firebase/auth';
import {
  doc, collection, collectionGroup, getDoc, getDocs, writeBatch, serverTimestamp, deleteField, Timestamp,
} from 'firebase/firestore/lite';
import {
  auth, db, $, el, toast, friendLink, shareOnWhatsApp, whatsappButton, download, ask, onReturn, wireSheet,
  renderTimetable, legend, participantDoc, whenLong, cleanPhone,
  placePicker, placeView, capacityInput, CAPACITY_ERROR, SLOTS, SLOT_IDS, slotById, slotIndex, slotKey, slotHours, LIMITS, CAPACITY,
  tripDays, weekday, formatDay, clean, cleanName, nameKey, todayInBolivia, countdownText, plural, freeText,
  reservationStatus, randomCode, publicSlots, publicDiff, buildIcs, cleanCapacity, isFull, spotsLeft,
  hasPlace, cleanPlace,
} from './common.js';

const VIEWS = ['status', 'login', 'not-admin', 'setup', 'panel'];
const show = (id) => VIEWS.forEach((view) => { $(view).hidden = view !== id; });

const HOST = 'Jose';
const TRIP = { start: '2026-12-14', end: '2027-01-02' };
const SEED_BLOCKS = [
  ['2026-12-14', SLOT_IDS, 'Llegando a Cochabamba (21:55)'],
  ['2026-12-24', ['tarde', 'noche'], 'Nochebuena en familia'],
  ['2026-12-25', SLOT_IDS, 'Navidad en familia'],
  ['2026-12-31', ['tarde', 'noche'], 'Año Nuevo'],
  ['2027-01-01', ['manana', 'almuerzo'], 'Año Nuevo'],
  ['2027-01-02', ['tarde', 'noche'], 'Vuelo de vuelta'],
];
// Version of the stored data; upgrade() brings older data up to it.
const SCHEMA = 4;

// reservations: my own time and blocks, with their real labels (admin-only).
// hangouts: each one also carries its private side from `hangout_private`
//   (note, and receipt: the id of the proposal it came from) and its place
//   from `hangout_places` (location: { map_url, lat, lng } or null).
// joined: hangout id -> [{ uid, key }], the devices that joined it.
// blocked: the public projection friends read, id -> document (publicSlots).
// open: { date, slotId } of the slot shown in the sheet.
const state = {
  settings: null, proposals: [], hangouts: [], participants: new Map(), joined: new Map(), reservations: [],
  blocked: new Map(), open: null,
};

const bySlot = (a, b) =>
  a.date.localeCompare(b.date) || slotIndex(a.slot) - slotIndex(b.slot)
  || (a.created_at?.seconds ?? 0) - (b.created_at?.seconds ?? 0);

// ---- Writes ----

// One action = one batch. The batch mirrors every change to reservations and
// hangouts on a copy of the state, so commit() can rebuild what friends see
// (blocked_slots) and write it in the same batch. The private data and the
// public projection never disagree, not even when the reload afterwards fails.
// Paths are arrays: ['hangouts', id] or ['hangouts', id, 'participants', key].
function changes() {
  const batch = writeBatch(db);
  const draft = {
    reservations: new Map(state.reservations.map((r) => [r.id, r])),
    hangouts: new Map(state.hangouts.map((h) => [h.id, h])),
  };
  const mirrored = (path) => (path.length === 2 ? draft[path[0]] : null);
  let writes = 0;
  return {
    set(path, data) {
      batch.set(doc(db, ...path), data);
      writes += 1;
      mirrored(path)?.set(path[1], { id: path[1], ...data });
    },
    update(path, data) {
      batch.update(doc(db, ...path), data);
      writes += 1;
      const items = mirrored(path);
      if (items?.has(path[1])) items.set(path[1], { ...items.get(path[1]), ...data });
    },
    delete(path) {
      batch.delete(doc(db, ...path));
      writes += 1;
      mirrored(path)?.delete(path[1]);
    },
    // Resolves to true when anything was written.
    async commit() {
      const wanted = publicSlots([...draft.reservations.values()], [...draft.hangouts.values()]);
      const { set, remove } = publicDiff(state.blocked, wanted);
      for (const [id, data] of set) batch.set(doc(db, 'blocked_slots', id), data);
      for (const id of remove) batch.delete(doc(db, 'blocked_slots', id));
      if (!writes && !set.length && !remove.length) return false;
      await batch.commit();
      state.blocked = wanted;
      return true;
    },
  };
}

// Run an action's writes as one batch, then reload everything.
async function act(fn, done) {
  try {
    const tx = changes();
    fn(tx);
    await tx.commit();
    if (done) toast(done);
  } catch (error) {
    console.error(error);
    toast('Error: ' + (error.code || error.message));
  }
  await refresh();
}

// A new id for a hangout. Friends see the ids of open hangouts, so a hangout
// never reuses the id of the proposal it came from: that id opens the receipt.
const newHangoutId = () => doc(collection(db, 'hangouts')).id;

// How many people a hangout holds: the limit (whole gathering, me included;
// null for none), how many others are going, and whether that fills it.
const headcount = (capacity, going) => ({ capacity, going, full: isFull(capacity, going) });

// The place a form or a proposal holds, as stored in hangout_places.
const placeOf = (item) => cleanPlace({ url: item.map_url, lat: item.lat, lng: item.lng });

// What the proposer's device reads, by the proposal id, to show its own plan
// even while it is private.
const receiptFor = (status, item, hangout) => ({
  status, date: item.date, slot: item.slot, title: item.title, ...(hangout ? { hangout } : {}),
});

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
    const [settings, proposals, hangouts, privates, places, participants, joined, reservations, blocked] = await Promise.all([
      getDoc(doc(db, 'settings', 'main')),
      getDocs(collection(db, 'proposals')),
      getDocs(collection(db, 'hangouts')),
      getDocs(collection(db, 'hangout_private')),
      getDocs(collection(db, 'hangout_places')),
      getDocs(collectionGroup(db, 'participants')),
      getDocs(collectionGroup(db, 'joined')),
      getDocs(collection(db, 'reservations')),
      getDocs(collection(db, 'blocked_slots')),
    ]);
    if (!settings.exists()) return show('setup');
    const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const privateOf = new Map(privates.docs.map((d) => [d.id, d.data()]));
    const placeOf = new Map(places.docs.map((d) => [d.id, d.data()]));
    state.settings = settings.data();
    state.proposals = rows(proposals).sort(bySlot);
    // Hangouts from before schema 3 still carry their note; upgrade() moves it.
    state.hangouts = rows(hangouts)
      .map((h) => ({ ...h, note: h.note ?? '', receipt: null, ...privateOf.get(h.id), location: placeOf.get(h.id) ?? null }))
      .sort(bySlot);
    state.reservations = rows(reservations).sort(bySlot);
    state.blocked = new Map(blocked.docs.map((d) => [d.id, d.data()]));
    // Both are subcollections of a hangout: group them by its id.
    const byHangout = (snap, row) => {
      const groups = new Map();
      for (const d of snap.docs) {
        const hangoutId = d.ref.parent.parent.id;
        groups.set(hangoutId, [...(groups.get(hangoutId) || []), row(d)]);
      }
      return groups;
    };
    state.participants = byHangout(participants, (d) => ({ key: d.id, ...d.data() }));
    state.joined = byHangout(joined, (d) => d.data());
    // An upgrade changes the data underneath: load it again.
    if (await upgrade()) return refresh();
    render();
    show('panel');
  } catch (error) {
    console.error(error);
    $('status').textContent = 'No se pudo cargar: ' + (error.code || error.message);
    show('status');
  }
}

// Brings data from older versions up to SCHEMA, and repairs the public
// projection in case something changed the data from outside this page (the
// Firebase console). Resolves to true when it upgraded the schema.
async function upgrade() {
  const tx = changes();
  const schema = state.settings.schema ?? 1;
  // 2: the privacy model. Old blocks keep the label friends already saw
  // (open), old plans become private.
  if (schema < 2) {
    for (const [id, b] of state.blocked) {
      if (!b.label || b.kind === 'busy' || state.reservations.some((r) => r.id === id)) continue;
      tx.set(['reservations', id], { date: b.date, slot: b.slot, label: b.label, kind: b.kind === 'personal' ? 'personal' : 'block', open: true });
    }
    for (const h of state.hangouts) {
      if (typeof h.open !== 'boolean') tx.update(['hangouts', h.id], { open: false });
    }
  }
  // 3: a hangout's note is private, so it leaves the document friends may read.
  if (schema < 3) {
    for (const h of state.hangouts) {
      tx.update(['hangouts', h.id], { note: deleteField() });
      if (h.note) tx.set(['hangout_private', h.id], { note: h.note });
    }
  }
  // 4: limits. Every hangout counts who is going and says whether it is full
  // (friends' joins and the rules rely on both), with no limit by default.
  if (schema < 4) {
    for (const h of state.hangouts) {
      tx.update(['hangouts', h.id], headcount(h.capacity ?? null, peopleOf(h).length));
    }
  }
  if (schema < SCHEMA) tx.update(['settings', 'main'], { schema: SCHEMA });
  const wrote = await tx.commit();
  return wrote && schema < SCHEMA;
}

// ---- First-time setup ----

$('setup-btn').addEventListener('click', () => act((tx) => {
  tx.set(['settings', 'main'], { invite_code: randomCode(), trip_start: TRIP.start, trip_end: TRIP.end, schema: SCHEMA });
  // A window that started in 1970 is already over, so the first proposal opens a new one.
  tx.set(['counters', 'proposals'], { count: 0, window_start: Timestamp.fromMillis(0), last_id: '' });
  for (const [date, slots, label] of SEED_BLOCKS) {
    // Travel and family days: friends see the label, so they know why.
    for (const slot of slots) tx.set(['reservations', slotKey(date, slot)], { date, slot, label, kind: 'block', open: true });
  }
}, 'Calendario creado.'));

// ---- Render ----

const reservationAt = (date, slotId) => state.reservations.find((r) => r.id === slotKey(date, slotId)) || null;
const hangoutsAt = (date, slotId) => state.hangouts.filter((h) => h.date === date && h.slot === slotId);
const pendingAt = (date, slotId) =>
  state.proposals.filter((p) => p.status === 'pending' && p.date === date && p.slot === slotId);
const peopleOf = (hangout) => state.participants.get(hangout.id) || [];
const joinedOf = (hangout) => state.joined.get(hangout.id) || [];
const namesOf = (hangout) => peopleOf(hangout).map((p) => p.name);
const slotName = (item) => slotById[item.slot]?.label ?? item.slot;
const whenText = (item) => `${formatDay(item.date)}, ${slotName(item).toLowerCase()}`;
const setOpen = (collectionName, items, open) => act((tx) => {
  for (const item of items) tx.update([collectionName, item.id], { open });
}, open ? 'Ahora es abierto: tus amigos lo ven.' : 'Ahora es privado: tus amigos ven «Ocupado».');

function render() {
  const { trip_start: start, trip_end: end, invite_code: code } = state.settings;
  const today = todayInBolivia();
  const days = tripDays(start, end);
  const pending = state.proposals.filter((p) => p.status === 'pending');
  const rejected = state.proposals.filter((p) => p.status !== 'pending');
  const people = peopleSummary();

  let free = 0;
  const cellFor = (date, slotId) => {
    const reservation = reservationAt(date, slotId);
    const hangouts = hangoutsAt(date, slotId);
    const waiting = pendingAt(date, slotId);
    if (hangouts.length) {
      return {
        status: 'plan',
        title: hangouts[0].title,
        sub: namesOf(hangouts[0]).join(', '),
        more: hangouts.length - 1 + waiting.length,
        alert: hangouts.length > 1 || !!reservation, // two plans, or a plan on reserved time
        open: hangouts[0].open,
      };
    }
    if (reservation) {
      const status = reservationStatus(reservation.kind);
      return {
        status, title: reservation.label, more: waiting.length, open: reservation.open,
        merge: waiting.length ? null : `${status}|${reservation.open}|${reservation.label}`,
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
    freeText(free),
    countdownText(start, end, today) + '.',
  ].join(' ');

  $('legend').replaceChildren(legend([
    ['free', 'Libre'], ['wait', 'Por confirmar'], ['plan', 'Confirmado'], ['plan is-alert', 'Choque'],
    ['own', 'Mi tiempo'], ['off', 'Bloqueado'], ['own is-open', 'Con punto: abierto, mis amigos lo ven'],
  ]));

  $('pending').replaceChildren(...(pending.length ? pending.map(renderPending)
    : [el('p', { class: 'empty' }, 'Cuando un amigo proponga un plan, aparece aquí para que lo confirmes.')]));
  $('people').replaceChildren(renderPeople(people));
  $('reservations').replaceChildren(renderReservations());
  $('link').textContent = friendLink(code);
  if (document.activeElement !== $('phone-form').elements.phone) {
    $('phone-form').elements.phone.value = state.settings.host_phone ? '+' + state.settings.host_phone : '';
  }
  $('rejected-count').textContent = rejected.length;
  $('rejected').replaceChildren(...(rejected.length ? rejected.map(renderRejected)
    : [el('p', { class: 'empty' }, 'No rechazaste ninguna propuesta.')]));

  editFields.date.replaceChildren(...days.map((d) => el('option', { value: d }, formatDay(d))));

  if ($('sheet').open && state.open) renderSheet();
}

// What already occupies the slot of a pending proposal.
function conflictsFor(proposal) {
  const warnings = [];
  const reservation = reservationAt(proposal.date, proposal.slot);
  if (reservation) warnings.push(`Ese espacio está reservado: ${reservation.label}.`);
  for (const h of hangoutsAt(proposal.date, proposal.slot)) {
    warnings.push(`Ya confirmaste «${h.title}» con ${h.proposer_name} en ese espacio.`);
  }
  const others = pendingAt(proposal.date, proposal.slot).filter((p) => p.id !== proposal.id);
  if (others.length) warnings.push(`Hay otra propuesta para ese espacio: ${others.map((p) => `«${p.title}»`).join(', ')}.`);
  return warnings;
}

// "Hasta 6 personas, contándome. Quedan 2 plazas." or null without a limit.
function capacityText(capacity, going) {
  if (capacity == null) return null;
  if (isFull(capacity, going)) return `Completo: ${capacity} personas, contándome.`;
  const spots = spotsLeft(capacity, going);
  return `Hasta ${capacity} personas, contándome. ${spots === 1 ? 'Queda 1 plaza' : `Quedan ${spots} plazas`}.`;
}

function proposalText(p) {
  const limit = p.capacity == null ? null : `Hasta ${p.capacity} personas, contándote.`;
  return [
    el('h3', {}, p.title),
    el('p', {}, `${p.proposer_name} propone esto para el ${whenText(p)}${p.place ? ', en ' + p.place : ''}.`),
    limit ? el('p', {}, limit) : null,
    p.note ? el('p', { class: 'note' }, `«${p.note}»`) : null,
    placeView(placeOf(p), p.title),
  ];
}

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
      el('button', { type: 'button', class: 'btn', onclick: () => reconsider(p) }, 'Volver a considerar'),
      whatsappButton(`Avisar a ${p.proposer_name}`,
        `Hola ${p.proposer_name}, esta vez no puedo con «${p.title}» (${whenLong(p.date, p.slot)}). ¡Propón otro día! ${friendLink(state.settings.invite_code)}`),
      el('button', {
        type: 'button', class: 'btn text',
        onclick: async () => await ask({
          title: '¿Borrar la propuesta?', text: `«${p.title}» desaparece del todo. No se puede deshacer.`, confirm: 'Borrar',
        }) && act((tx) => tx.delete(['proposals', p.id]), 'Borrada.'),
      }, 'Borrar')));
}

// ---- Who I spend time with ----

// One entry per person, from the participants of confirmed hangouts.
function peopleSummary() {
  const people = new Map();
  for (const h of state.hangouts) {
    for (const person of peopleOf(h)) {
      const entry = people.get(person.key) || { name: person.name, hangouts: [], hours: 0 };
      entry.hangouts.push(h);
      entry.hours += slotHours(h.slot);
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

const removeReservations = (items) => act((tx) => {
  for (const r of items) tx.delete(['reservations', r.id]);
}, 'Quitado.');

// Same label on many slots (gym every morning, a whole family day) is one row.
function renderReservations() {
  if (!state.reservations.length) return el('p', { class: 'empty' }, 'No tienes nada reservado. Toca un espacio libre del calendario para reservarlo.');
  const groups = new Map();
  for (const r of state.reservations) {
    const key = `${r.kind === 'personal'}|${r.open}|${r.label}`;
    groups.set(key, [...(groups.get(key) || []), r]);
  }
  return el('ul', { class: 'groups' }, [...groups.values()].map((items) => {
    const first = items[0];
    const days = new Set(items.map((r) => r.date)).size;
    const oneSlot = items.every((r) => r.slot === first.slot);
    const where = items.length === 1 ? whenText(first)
      : oneSlot ? `${slotName(first).toLowerCase()}, ${days} días`
      : days === 1 ? `${formatDay(first.date)}, ${items.length} espacios`
      : `${items.length} espacios en ${days} días`;
    return el('li', {},
      el('details', {},
        el('summary', {},
          el('i', { class: 'swatch is-' + reservationStatus(first.kind) }),
          el('strong', {}, first.label), ' ', el('span', { class: 'where' }, `${first.open ? 'Abierto' : 'Privado'}, ${where}`)),
        el('ul', {}, items.map((r) => el('li', {},
          el('span', {}, whenText(r)),
          el('button', { type: 'button', class: 'btn text', onclick: () => removeReservations([r]) }, 'Quitar')))),
      ),
      el('button', { type: 'button', class: 'btn text', onclick: () => setOpen('reservations', items, !first.open) },
        first.open ? 'Hacer privado' : 'Hacer abierto'),
      el('button', {
        type: 'button', class: 'btn text',
        onclick: async () => (items.length === 1 || await ask({
          title: `¿Quitar «${first.label}»?`, text: `Se quita de los ${items.length} espacios.`, confirm: 'Quitar todo',
        })) && removeReservations(items),
      }, items.length === 1 ? 'Quitar' : 'Quitar todo'),
    );
  }));
}

// ---- Slot sheet (opened from the timetable) ----

function openSlot(date, slotId) {
  state.open = { date, slotId };
  renderSheet();
  if (!$('sheet').open) $('sheet').showModal();
}

wireSheet(() => state.open);

function renderSheet() {
  const { date, slotId } = state.open;
  const slot = slotById[slotId];
  const reservation = reservationAt(date, slotId);
  const hangouts = hangoutsAt(date, slotId);
  const waiting = pendingAt(date, slotId);

  $('sheet-title').textContent = formatDay(date);
  $('sheet-when').textContent = `${slot.label}, de ${slot.start} a ${slot.end}`;

  const body = [];
  if (hangouts.length > 1) body.push(el('p', { class: 'warn' }, `Hay ${hangouts.length} planes confirmados en este espacio.`));
  if (hangouts.length && reservation) body.push(el('p', { class: 'warn' }, 'Hay un plan confirmado sobre tiempo reservado.'));
  if (reservation) {
    body.push(el('div', { class: 'entry is-' + reservationStatus(reservation.kind) },
      el('h3', {}, reservation.label),
      el('p', {}, reservation.open ? 'Abierto: mis amigos ven este texto.' : 'Privado: mis amigos solo ven «Ocupado».'),
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'btn', onclick: () => setOpen('reservations', [reservation], !reservation.open) }, reservation.open ? 'Hacer privado' : 'Hacer abierto'),
        el('button', { type: 'button', class: 'btn text', onclick: () => removeReservations([reservation]) }, 'Quitar reserva'))));
  }
  for (const h of hangouts) body.push(renderHangout(h));
  for (const p of waiting) body.push(renderPending(p));
  if (!reservation) body.push(reserveForm(date, slot));
  $('sheet-body').replaceChildren(...body);
}

function renderHangout(h) {
  const limit = capacityText(h.capacity ?? null, peopleOf(h).length);
  return el('div', { class: 'entry is-plan' },
    el('h3', {}, h.title),
    el('p', {}, `Lo propuso ${h.proposer_name}${h.place ? ', en ' + h.place : ''}.`),
    h.note ? el('p', { class: 'note' }, `«${h.note}»`) : null,
    el('p', {}, h.open
      ? (h.full ? 'Abierto y completo: quien no se apuntó ve «Ocupado».' : 'Abierto: mis amigos lo ven y se pueden apuntar.')
      : 'Privado: los demás solo ven «Ocupado».'),
    limit ? el('p', {}, limit) : null,
    placeView(h.location, h.title),
    el('ul', { class: 'chips', 'aria-label': 'Quién viene' },
      peopleOf(h).map((person) => el('li', {}, person.name,
        el('button', {
          type: 'button', 'aria-label': `Quitar a ${person.name}`,
          onclick: () => removeParticipant(h, person),
        }, '×'))),
      el('li', { class: 'add' }, el('button', { type: 'button', onclick: () => addParticipant(h) }, 'Añadir persona'))),
    el('div', { class: 'actions' },
      whatsappButton('Avisar por WhatsApp', confirmedText(h)),
    ),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => setOpen('hangouts', [h], !h.open) }, h.open ? 'Hacer privado' : 'Hacer abierto'),
      el('button', { type: 'button', class: 'btn', onclick: () => openEdit('hangouts', h) }, 'Editar'),
      el('button', { type: 'button', class: 'btn text', onclick: () => removeHangout(h) }, 'Borrar plan')));
}

// What I send someone about a confirmed plan (WhatsApp lets me pick whom).
const confirmedText = (h) => [
  `¡Confirmado! «${h.title}», ${whenLong(h.date, h.slot)}${h.place ? ', en ' + h.place : ''}.`,
  h.open ? `Los demás también lo ven y se pueden apuntar: ${friendLink(state.settings.invite_code)}` : `Lo ves en el calendario: ${friendLink(state.settings.invite_code)}`,
].join(' ');

const PRESETS = ['Gimnasio', 'Trabajo', 'Familia', 'Descanso'];

// Reserve this slot for myself, optionally repeated across the trip.
function reserveForm(date, slot) {
  const label = el('input', { name: 'label', maxLength: LIMITS.title, required: true, placeholder: 'Ej. Gimnasio' });
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
  // Only for a plan friends can join: how many fit, and where.
  const capacity = capacityInput();
  const picker = placePicker();
  const joinFields = el('div', { hidden: true },
    el('label', {}, 'Máximo de personas, contándome (opcional)', capacity), picker.node);
  who.addEventListener('change', () => { joinFields.hidden = who.value !== 'join'; });
  const form = el('form', { class: 'reserve' },
    el('h3', {}, 'Reservar para mí'),
    el('label', {}, '¿Para qué?', label),
    el('div', { class: 'presets' }, PRESETS.map((name) =>
      el('button', { type: 'button', class: 'btn small', onclick: () => { label.value = name; } }, name))),
    el('label', {}, '¿Cuándo?', repeat),
    el('label', {}, '¿Quién lo ve?', who),
    joinFields,
    el('button', { type: 'submit', class: 'btn primary' }, 'Reservar'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = clean(label.value, LIMITS.title);
    if (!text) return;
    const limit = who.value === 'join' ? cleanCapacity(capacity.value) : null;
    if (limit === undefined) return toast(CAPACITY_ERROR);
    const place = picker.value();
    const days = tripDays(state.settings.trip_start, state.settings.trip_end);
    const targets = {
      once: [{ date, slot: slot.id }],
      day: SLOT_IDS.map((id) => ({ date, slot: id })),
      weekdays: days.filter((d) => weekday(d) >= 1 && weekday(d) <= 5).map((d) => ({ date: d, slot: slot.id })),
      daily: days.map((d) => ({ date: d, slot: slot.id })),
    }[repeat.value];
    // Slots that already have a reservation keep it. Slots with a confirmed
    // plan are reserved too and show up as a conflict, so I can decide.
    const fresh = targets.filter((t) => !reservationAt(t.date, t.slot));
    const skipped = targets.length - fresh.length;
    const busy = fresh.filter((t) => hangoutsAt(t.date, t.slot).length).length;
    $('sheet').close();
    const joinable = who.value === 'join';
    act((tx) => {
      for (const t of fresh) {
        // Something friends can join is a plan of mine; anything else is reserved time.
        if (joinable) {
          const id = newHangoutId();
          tx.set(['hangouts', id], {
            date: t.date, slot: t.slot, title: text, place: '', proposer_name: HOST, open: true,
            ...headcount(limit, 0), created_at: serverTimestamp(),
          });
          if (hasPlace(place)) tx.set(['hangout_places', id], place);
        } else {
          tx.set(['reservations', slotKey(t.date, t.slot)], { date: t.date, slot: t.slot, label: text, kind: 'personal', open: who.value === 'open' });
        }
      }
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
// can read, adds the proposer as the first participant (and their device as
// joined, so they keep seeing the plan and its place when it fills up), and
// keeps the note and the proposal id on the private side.
function approve(p, open = false) {
  return act((tx) => {
    const id = newHangoutId();
    const name = cleanName(p.proposer_name);
    tx.set(['hangouts', id], {
      date: p.date, slot: p.slot, title: p.title, place: p.place,
      proposer_name: p.proposer_name, open, ...headcount(p.capacity ?? null, name ? 1 : 0),
      created_at: p.created_at ?? serverTimestamp(),
    });
    tx.set(['hangout_private', id], { note: p.note, receipt: p.id });
    if (hasPlace(placeOf(p))) tx.set(['hangout_places', id], placeOf(p));
    tx.set(['receipts', p.id], receiptFor('approved', p, id));
    if (name) {
      tx.set(['hangouts', id, 'participants', nameKey(name)], participantDoc(name));
      if (p.uid) tx.set(['hangouts', id, 'joined', p.uid], { uid: p.uid, key: nameKey(name) });
    }
    tx.delete(['proposals', p.id]);
  }, open ? 'Aprobado y abierto: tus amigos lo ven.' : `Aprobado. Solo ${p.proposer_name} y tú lo ven.`);
}

// The receipt is how the proposer's device learns the answer.
const rejectProposal = (p) => act((tx) => {
  tx.update(['proposals', p.id], { status: 'rejected' });
  tx.set(['receipts', p.id], { status: 'rejected' });
}, 'Rechazada.');

const reconsider = (p) => act((tx) => {
  tx.update(['proposals', p.id], { status: 'pending' });
  tx.set(['receipts', p.id], receiptFor('pending', p));
}, 'Devuelta a por confirmar.');

async function removeHangout(h) {
  if (!await ask({ title: '¿Borrar el plan?', text: `«${h.title}» desaparece y tus amigos dejan de verlo.`, confirm: 'Borrar plan' })) return;
  act((tx) => {
    for (const person of peopleOf(h)) tx.delete(['hangouts', h.id, 'participants', person.key]);
    for (const device of joinedOf(h)) tx.delete(['hangouts', h.id, 'joined', device.uid]);
    tx.delete(['hangouts', h.id]);
    tx.delete(['hangout_private', h.id]);
    tx.delete(['hangout_places', h.id]);
    // Plans approved before schema 3 have their receipt under their own id.
    tx.set(['receipts', h.receipt ?? h.id], { status: 'rejected' });
  }, 'Plan borrado.');
}

// Someone joining from here has no device behind them: they are counted, but
// only the name says they are in.
async function addParticipant(h) {
  const name = cleanName(await ask({
    title: `¿Quién más viene a «${h.title}»?`, confirm: 'Añadir', input: { label: 'Nombre', maxLength: LIMITS.name },
  }));
  if (!name) return;
  if (peopleOf(h).some((person) => person.key === nameKey(name))) return toast(`${name} ya está apuntado.`);
  act((tx) => {
    tx.set(['hangouts', h.id, 'participants', nameKey(name)], participantDoc(name));
    tx.update(['hangouts', h.id], headcount(h.capacity ?? null, peopleOf(h).length + 1));
  }, 'Añadido.');
}

async function removeParticipant(h, person) {
  if (!await ask({ title: `¿Quitar a ${person.name}?`, text: `Deja de estar en «${h.title}».`, confirm: 'Quitar' })) return;
  act((tx) => {
    tx.delete(['hangouts', h.id, 'participants', person.key]);
    for (const device of joinedOf(h).filter((j) => j.key === person.key)) tx.delete(['hangouts', h.id, 'joined', device.uid]);
    tx.update(['hangouts', h.id], headcount(h.capacity ?? null, peopleOf(h).length - 1));
  }, 'Quitado.');
}

// ---- Edit dialog (a pending proposal or a confirmed plan) ----

const editFields = $('edit-form').elements;
editFields.title.maxLength = LIMITS.title;
editFields.place.maxLength = LIMITS.place;
editFields.proposer_name.maxLength = LIMITS.name;
editFields.note.maxLength = LIMITS.note;
editFields.slot.replaceChildren(...SLOTS.map((s) => el('option', { value: s.id }, s.label)));
Object.assign(editFields.capacity, { min: CAPACITY.min, max: CAPACITY.max });

let editing = null; // { collectionName, item, picker }

function openEdit(collectionName, item) {
  const picker = placePicker(collectionName === 'proposals' ? placeOf(item) : item.location ?? {});
  editing = { collectionName, item, picker };
  for (const name of ['date', 'slot', 'title', 'place', 'proposer_name', 'note']) editFields[name].value = item[name] ?? '';
  editFields.capacity.value = item.capacity ?? '';
  $('edit-place').replaceChildren(picker.node);
  $('edit-dialog').showModal();
}

$('edit-cancel').addEventListener('click', () => $('edit-dialog').close());

$('edit-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = {
    date: editFields.date.value,
    slot: editFields.slot.value,
    title: clean(editFields.title.value, LIMITS.title),
    place: clean(editFields.place.value, LIMITS.place),
    proposer_name: cleanName(editFields.proposer_name.value),
    note: clean(editFields.note.value, LIMITS.note),
  };
  if (!editing || !data.title || !data.proposer_name) return;
  const capacity = cleanCapacity(editFields.capacity.value);
  if (capacity === undefined) return toast(CAPACITY_ERROR);
  const { collectionName, item, picker } = editing;
  const place = picker.value();
  $('edit-dialog').close();
  // The slot may have changed: follow the item to its new place.
  if ($('sheet').open) state.open = { date: data.date, slotId: data.slot };
  act((tx) => {
    if (collectionName === 'proposals') {
      tx.update(['proposals', item.id], { ...data, capacity, ...place });
      // The proposer's page shows their proposal where it is now.
      tx.set(['receipts', item.id], receiptFor('pending', data));
      return;
    }
    const { note, ...shared } = data;
    tx.update(['hangouts', item.id], { ...shared, ...headcount(capacity, peopleOf(item).length) });
    tx.set(['hangout_private', item.id], { note, ...(item.receipt ? { receipt: item.receipt } : {}) });
    if (hasPlace(place)) tx.set(['hangout_places', item.id], place);
    else tx.delete(['hangout_places', item.id]);
    // Plans approved before schema 3 share their id with their receipt, and
    // friends may know that id, so their receipt only ever says 'approved'.
    if (item.receipt) tx.set(['receipts', item.receipt], receiptFor('approved', data, item.id));
  }, 'Cambios guardados.');
});

// ---- Invite link ----

$('copy-link').addEventListener('click', () => copy($('link').textContent));

// My WhatsApp number: friends' "Avisar a Jose" opens my chat directly.
$('phone-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const typed = $('phone-form').elements.phone.value.trim();
  const phone = cleanPhone(typed);
  if (typed && !phone) return toast('Escribe el número con código de país, por ejemplo +591 70000000.');
  act((tx) => tx.update(['settings', 'main'], { host_phone: phone }), phone ? 'Número guardado.' : 'Número quitado.');
});

// Back in view after a while: friends may have proposed or joined meanwhile.
onReturn(() => { if (state.settings && !$('panel').hidden) refresh(); });
$('share-link').addEventListener('click', () =>
  shareOnWhatsApp(`¡Voy a Cochabamba! Propón un plan o apúntate a uno aquí: ${$('link').textContent}`));
$('rotate').addEventListener('click', async () => {
  if (!await ask({
    title: '¿Cambiar el código?', text: 'Todos los enlaces que ya mandaste dejan de funcionar.', confirm: 'Cambiar código',
  })) return;
  act((tx) => tx.update(['settings', 'main'], { invite_code: randomCode() }), 'Código cambiado. Manda el enlace nuevo.');
});

// ---- .ics export ----

$('export').addEventListener('click', () => {
  if (!state.hangouts.length && !state.reservations.some((r) => r.kind === 'personal')) return toast('Todavía no hay planes ni reservas que descargar.');
  const ics = buildIcs({ hangouts: state.hangouts, reservations: state.reservations, participants: state.participants });
  download(ics, 'cochabamba.ics', 'text/calendar;charset=utf-8');
});
