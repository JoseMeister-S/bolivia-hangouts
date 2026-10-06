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
  clean, cleanName, nameKey, friendLink, whatsappUrl, toast, todayInBolivia, renderCalendar,
  legend, statTile, countdownText, dayParts, SLOT_HOURS,
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

const state = { settings: null, proposals: [], hangouts: [], participants: new Map(), blocked: [] };

const bySlot = (a, b) =>
  a.date.localeCompare(b.date) || slotIndex(a.slot) - slotIndex(b.slot)
  || (a.created_at?.seconds ?? 0) - (b.created_at?.seconds ?? 0);
const slotKey = (item) => `${item.date}_${item.slot}`;
const whenText = (item) => {
  const slot = slotById[item.slot];
  return `${formatDay(item.date)} · ${slot ? `${slot.label} (${slot.start}–${slot.end})` : item.slot}`;
};

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
    $('who').textContent = 'Panel privado';
    return show('login');
  }
  $('who').textContent = user.email || 'Panel privado';
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
    toast('Copiado');
  } catch {
    toast('No se pudo copiar. Selecciona el texto a mano.');
  }
}

// ---- Load ----

async function refresh() {
  try {
    const settings = await getDoc(doc(db, 'settings', 'main'));
    if (!settings.exists()) return show('setup');
    const [proposals, hangouts, participants, blocked] = await Promise.all([
      getDocs(collection(db, 'proposals')),
      getDocs(collection(db, 'hangouts')),
      getDocs(collectionGroup(db, 'participants')),
      getDocs(collection(db, 'blocked_slots')),
    ]);
    const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    state.settings = settings.data();
    state.proposals = rows(proposals).sort(bySlot);
    state.hangouts = rows(hangouts).sort(bySlot);
    state.blocked = rows(blocked).sort(bySlot);
    state.participants = new Map();
    for (const d of participants.docs) {
      const hangoutId = d.ref.parent.parent.id;
      const list = state.participants.get(hangoutId) || [];
      list.push({ key: d.id, ...d.data() });
      state.participants.set(hangoutId, list);
    }
    render();
    show('panel');
  } catch (error) {
    console.error(error);
    $('status').textContent = 'No se pudo cargar: ' + (error.code || error.message);
    show('status');
  }
}

// ---- First-time setup ----

$('setup-btn').addEventListener('click', () => act(async () => {
  const batch = writeBatch(db);
  batch.set(doc(db, 'settings', 'main'), { invite_code: randomCode(), trip_start: TRIP.start, trip_end: TRIP.end });
  // A window that started in 1970 is already over, so the first proposal opens a new one.
  batch.set(doc(db, 'counters', 'proposals'), { count: 0, window_start: Timestamp.fromMillis(0), last_id: '' });
  for (const [date, slots, label] of SEED_BLOCKS) {
    for (const slot of slots) batch.set(doc(db, 'blocked_slots', `${date}_${slot}`), { date, slot, label });
  }
  await batch.commit();
}, 'Listo'));

// ---- Render ----

const blockAt = (date, slotId) => state.blocked.find((b) => b.id === `${date}_${slotId}`) || null;
const hangoutsAt = (date, slotId) => state.hangouts.filter((h) => h.date === date && h.slot === slotId);
const pendingAt = (date, slotId) =>
  state.proposals.filter((p) => p.status === 'pending' && p.date === date && p.slot === slotId);

function slotStatus(date, slotId) {
  const block = blockAt(date, slotId);
  const hangouts = hangoutsAt(date, slotId);
  if (hangouts.length > 1 || (hangouts.length && block)) return 'hangout conflict';
  if (block) return block.kind === 'personal' ? 'personal' : 'blocked';
  if (hangouts.length) return 'hangout';
  return pendingAt(date, slotId).length ? 'pending' : 'free';
}

function render() {
  const { trip_start: start, trip_end: end, invite_code: code } = state.settings;
  const today = todayInBolivia();
  const days = tripDays(start, end);

  $('countdown').textContent = countdownText(start, end, today);
  $('countdown').hidden = false;
  $('link').textContent = friendLink(code);

  const pending = state.proposals.filter((p) => p.status === 'pending');
  const rejected = state.proposals.filter((p) => p.status !== 'pending');
  const people = peopleSummary();
  const free = days.filter((d) => d >= today)
    .reduce((n, d) => n + SLOTS.filter((s) => slotStatus(d, s.id) === 'free').length, 0);

  $('stats').replaceChildren(
    statTile(pending.length, pending.length === 1 ? 'pendiente' : 'pendientes', 'tone-pending'),
    statTile(state.hangouts.length, state.hangouts.length === 1 ? 'confirmado' : 'confirmados', 'tone-hangout'),
    statTile(free, free === 1 ? 'espacio libre' : 'espacios libres', 'tone-free'),
    statTile(people.length, people.length === 1 ? 'persona' : 'personas', 'tone-mine'),
  );

  $('cal').replaceChildren(renderCalendar({
    days, today,
    stateOf: slotStatus,
    describe: (date) => `${SLOTS.filter((s) => slotStatus(date, s.id) === 'free').length} libres`,
    badgeOf: (date) => pending.filter((p) => p.date === date).length,
    onPick: openDay,
  }));
  $('legend').replaceChildren(legend([
    ['free', 'Libre'], ['pending', 'Pendiente'], ['hangout', 'Confirmado'], ['hangout conflict', 'Choque'],
    ['personal', 'Mi tiempo'], ['blocked', 'Bloqueado'],
  ]));

  $('pending-count').textContent = pending.length;
  $('rejected-count').textContent = rejected.length;
  $('approved-count').textContent = state.hangouts.length;

  $('pending').replaceChildren(...(pending.length ? pending.map(renderPending)
    : [el('p', { class: 'empty' }, 'Nada pendiente.')]));
  $('rejected').replaceChildren(...(rejected.length ? rejected.map(renderRejected)
    : [el('p', { class: 'empty' }, 'Nada rechazado.')]));
  $('approved').replaceChildren(...(state.hangouts.length ? state.hangouts.map(renderApproved)
    : [el('p', { class: 'empty' }, 'Todavía no hay planes confirmados.')]));
  $('people').replaceChildren(renderPeople(people));
  $('blocked').replaceChildren(renderBlockGroups());

  const dateSelect = $('edit-form').elements.date;
  dateSelect.replaceChildren(...days.map((d) => el('option', { value: d }, formatDayShort(d))));
  $('edit-form').elements.slot.replaceChildren(...SLOTS.map((s) => el('option', { value: s.id }, s.label)));

  if ($('day-dialog').open && openDate) renderDay(openDate);
}

function details(item) {
  return [
    el('p', { class: 'when' }, whenText(item)),
    el('p', { class: 'hangout-title' }, item.title),
    item.place ? el('p', { class: 'hangout-place' }, item.place) : null,
    el('p', { class: 'meta' }, 'Propuesto por ' + item.proposer_name),
    item.note ? el('p', { class: 'note' }, '«' + item.note + '»') : null,
  ];
}

// What already occupies the slot of a pending proposal.
function conflictsFor(proposal) {
  const key = slotKey(proposal);
  const warnings = [];
  const block = state.blocked.find((b) => b.id === key);
  if (block) warnings.push(`Espacio bloqueado: ${block.label}`);
  for (const h of state.hangouts.filter((h) => slotKey(h) === key)) {
    warnings.push(`Ya confirmado en este espacio: ${h.title} (${h.proposer_name})`);
  }
  const others = state.proposals.filter((p) => p.status === 'pending' && p.id !== proposal.id && slotKey(p) === key);
  const soft = others.length ? `Otra propuesta pendiente en este espacio: ${others.map((p) => p.title).join(', ')}` : null;
  return { warnings, soft };
}

function renderPending(p) {
  const { warnings, soft } = conflictsFor(p);
  return el('article', { class: 'card item' + (warnings.length ? ' conflict' : '') },
    warnings.map((w) => el('p', { class: 'warn' }, '⚠ ' + w)),
    soft ? el('p', { class: 'warn soft' }, soft) : null,
    details(p),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn primary', onclick: () => approve(p) }, 'Aprobar'),
      el('button', { type: 'button', class: 'btn', onclick: () => openEdit('proposals', p) }, 'Editar'),
      el('button', { type: 'button', class: 'btn danger', onclick: () => act(() => updateDoc(doc(db, 'proposals', p.id), { status: 'rejected' }), 'Rechazado') }, 'Rechazar'),
    ),
  );
}

function renderRejected(p) {
  return el('article', { class: 'card item muted' },
    details(p),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => act(() => updateDoc(doc(db, 'proposals', p.id), { status: 'pending' })) }, 'Volver a pendiente'),
      el('button', { type: 'button', class: 'btn danger', onclick: () => confirm('¿Borrar esta propuesta?') && act(() => deleteDoc(doc(db, 'proposals', p.id)), 'Borrado') }, 'Borrar'),
    ),
  );
}

function renderApproved(h) {
  const same = state.hangouts.filter((other) => slotKey(other) === slotKey(h));
  const block = state.blocked.find((b) => b.id === slotKey(h));
  const people = state.participants.get(h.id) || [];
  return el('article', { class: 'card item' + (same.length > 1 || block ? ' conflict' : '') },
    same.length > 1 ? el('p', { class: 'warn' }, `⚠ Choque: ${same.length} planes en este espacio`) : null,
    block ? el('p', { class: 'warn' }, `⚠ Espacio bloqueado: ${block.label}`) : null,
    details(h),
    el('div', { class: 'chips' },
      people.map((person) => el('span', { class: 'chip' }, person.name,
        el('button', {
          type: 'button', title: 'Quitar', 'aria-label': `Quitar a ${person.name}`,
          onclick: () => confirm(`¿Quitar a ${person.name}?`)
            && act(() => deleteDoc(doc(db, 'hangouts', h.id, 'participants', person.key))),
        }, '×'))),
      el('button', { type: 'button', class: 'chip add', onclick: () => addParticipant(h) }, '+ Añadir'),
    ),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => openEdit('hangouts', h) }, 'Editar'),
      el('button', { type: 'button', class: 'btn danger', onclick: () => removeHangout(h) }, 'Borrar'),
    ),
  );
}

// ---- Who I spend time with ----

// One entry per person, from the participants of approved hangouts.
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
  const most = people[0].hangouts.length;
  return el('ol', { class: 'people' }, people.map((person) => {
    const times = person.hangouts.length;
    return el('li', {},
      el('details', {},
        el('summary', {},
          el('span', { class: 'person-name' }, person.name),
          el('span', { class: 'person-count' }, `${times === 1 ? '1 vez' : times + ' veces'} · ≈ ${String(person.hours).replace('.', ',')} h`),
          el('span', { class: 'meter', 'aria-hidden': 'true' }, el('i', { style: `width:${Math.round((times / most) * 100)}%` })),
        ),
        el('ul', { class: 'person-list' }, person.hangouts.map((h) =>
          el('li', {}, `${formatDayShort(h.date)} · ${slotById[h.slot]?.label ?? h.slot} — ${h.title}`))),
      ),
    );
  }));
}

// ---- My time and blocks ----

// Same label and kind on many slots (gym every morning, a whole family day) shows as one row.
function renderBlockGroups() {
  if (!state.blocked.length) return el('p', { class: 'empty' }, 'Sin reservas ni bloqueos.');
  const groups = new Map();
  for (const b of state.blocked) {
    const key = `${b.kind === 'personal' ? 'personal' : 'block'}|${b.label}`;
    groups.set(key, [...(groups.get(key) || []), b]);
  }
  const removeAll = (items) => act(async () => {
    const batch = writeBatch(db);
    for (const b of items) batch.delete(doc(db, 'blocked_slots', b.id));
    await batch.commit();
  }, 'Quitado');
  return el('ul', { class: 'plain groups' }, [...groups.values()].map((items) => {
    const first = items[0];
    const personal = first.kind === 'personal';
    const slotName = (b) => slotById[b.slot]?.label ?? b.slot;
    const oneSlot = items.every((b) => b.slot === first.slot);
    const days = new Set(items.map((b) => b.date)).size;
    const where = items.length === 1 ? `${slotName(first)} · ${formatDayShort(first.date)}`
      : oneSlot ? `${slotName(first)} · ${days} días`
      : days === 1 ? `${formatDayShort(first.date)} · ${items.length} espacios`
      : `${items.length} espacios en ${days} días`;
    return el('li', {},
      el('details', {},
        el('summary', {},
          el('span', { class: 'tag ' + (personal ? 'personal' : 'blocked') }, personal ? 'Mi tiempo' : 'Bloqueo'),
          el('strong', {}, first.label),
          el('span', { class: 'meta' }, ' · ' + where),
        ),
        el('ul', { class: 'plain' }, items.map((b) => el('li', {},
          el('span', {}, `${formatDayShort(b.date)} · ${slotName(b)}`),
          el('button', { type: 'button', class: 'btn small danger', onclick: () => act(() => deleteDoc(doc(db, 'blocked_slots', b.id))) }, 'Quitar'),
        ))),
      ),
      items.length > 1 ? el('button', {
        type: 'button', class: 'btn small danger',
        onclick: () => confirm(`¿Quitar «${first.label}» de los ${items.length} espacios?`) && removeAll(items),
      }, 'Quitar todo') : null,
    );
  }));
}

// ---- Day view (opened from the calendar) ----

let openDate = null;

function openDay(date) {
  openDate = date;
  renderDay(date);
  if (!$('day-dialog').open) $('day-dialog').showModal();
}

function renderDay(date) {
  $('day-title').textContent = formatDay(date);
  $('day-body').replaceChildren(...SLOTS.map((slot) => {
    const block = blockAt(date, slot.id);
    const hangouts = hangoutsAt(date, slot.id);
    const pending = pendingAt(date, slot.id);
    const body = el('div', { class: 'slot-body' });
    if (block) {
      body.append(el('div', { class: 'row-line' },
        el('p', { class: block.kind === 'personal' ? 'personal' : 'blocked' },
          block.kind === 'personal' ? el('span', { class: 'who' }, 'Jose') : null, block.label),
        el('button', { type: 'button', class: 'btn small danger', onclick: () => act(() => deleteDoc(doc(db, 'blocked_slots', block.id))) }, 'Quitar'),
      ));
    }
    for (const h of hangouts) {
      const names = (state.participants.get(h.id) || []).map((p) => p.name);
      body.append(el('div', { class: 'hangout' },
        el('p', { class: 'hangout-title' }, h.title),
        h.place ? el('p', { class: 'hangout-place' }, h.place) : null,
        el('p', { class: 'hangout-people' }, names.length ? 'Vienen: ' + names.join(', ') : 'Nadie apuntado.')));
    }
    for (const p of pending) {
      body.append(el('div', { class: 'row-line' },
        el('p', { class: 'pending' }, `${p.title} — ${p.proposer_name}`),
        el('button', { type: 'button', class: 'btn small primary', onclick: () => approve(p) }, 'Aprobar')));
    }
    if (!block) {
      body.append(el('div', { class: 'slot-actions' },
        !hangouts.length && !pending.length ? el('span', { class: 'free' }, 'Libre') : null,
        el('button', { type: 'button', class: 'btn small', onclick: () => openReserve({ dates: [date], slot: slot.id }) }, 'Reservar para mí')));
    }
    return el('section', { class: 'slot is-' + slotStatus(date, slot.id).split(' ')[0] },
      el('div', { class: 'slot-head' },
        el('span', { class: 'slot-name' }, slot.label),
        el('span', { class: 'slot-time' }, `${slot.start}–${slot.end}`)),
      body);
  }));
}

$('day-close').addEventListener('click', () => $('day-dialog').close());

// ---- Reserve time for myself / block slots ----

const PRESETS = ['Gimnasio', 'Trabajo', 'Familia', 'Descanso'];

function openReserve({ dates = [], slot = 'manana' } = {}) {
  const form = $('reserve-form');
  form.reset();
  $('reserve-error').hidden = true;
  $('reserve-presets').replaceChildren(...PRESETS.map((label) =>
    el('button', { type: 'button', class: 'chip-filter', onclick: () => { form.elements.label.value = label; } }, label)));
  form.elements.slot.replaceChildren(
    ...SLOTS.map((s) => el('option', { value: s.id }, `${s.label} (${s.start}–${s.end})`)),
    el('option', { value: 'all' }, 'Todo el día'));
  form.elements.slot.value = slot;
  const today = todayInBolivia();
  $('reserve-days').replaceChildren(...tripDays(state.settings.trip_start, state.settings.trip_end).map((date) => {
    const { weekday, day } = dayParts(date);
    return el('label', { class: 'day-pick' + (date < today ? ' past' : '') },
      el('input', { type: 'checkbox', name: 'day', value: date, checked: dates.includes(date) }),
      el('span', {}, el('small', {}, weekday), day));
  }));
  if ($('day-dialog').open) $('day-dialog').close();
  $('reserve-dialog').showModal();
}

$('reserve-open').addEventListener('click', () => openReserve());
$('reserve-cancel').addEventListener('click', () => $('reserve-dialog').close());

// Quick day selection: all, Monday to Friday, none.
for (const button of document.querySelectorAll('#reserve-form [data-pick]')) {
  button.addEventListener('click', () => {
    for (const box of $('reserve-form').querySelectorAll('input[name=day]')) {
      const weekday = new Date(box.value + 'T00:00:00Z').getUTCDay();
      box.checked = button.dataset.pick === 'all' || (button.dataset.pick === 'weekdays' && weekday >= 1 && weekday <= 5);
    }
  });
}

$('reserve-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = $('reserve-form');
  const label = clean(form.elements.label.value, 80);
  const kind = form.elements.kind.value;
  const slots = form.elements.slot.value === 'all' ? ALL : [form.elements.slot.value];
  const dates = [...form.querySelectorAll('input[name=day]:checked')].map((box) => box.value);
  if (!label || !dates.length) {
    $('reserve-error').textContent = 'Escribe para qué es y elige al menos un día.';
    $('reserve-error').hidden = false;
    return;
  }
  // Slots that already have a block keep it; slots with plans are still
  // reserved, and show up as a conflict so I can decide.
  const targets = dates.flatMap((date) => slots.map((slot) => ({ date, slot })));
  const fresh = targets.filter((t) => !blockAt(t.date, t.slot));
  const skipped = targets.length - fresh.length;
  const busy = fresh.filter((t) => hangoutsAt(t.date, t.slot).length).length;
  $('reserve-dialog').close();
  if (!fresh.length) return toast('Esos espacios ya estaban reservados.');
  act(async () => {
    const batch = writeBatch(db);
    for (const { date, slot } of fresh) {
      batch.set(doc(db, 'blocked_slots', `${date}_${slot}`), { date, slot, label, kind });
    }
    await batch.commit();
  }, `Reservado: ${fresh.length}${skipped ? ` · ${skipped} ya ocupados` : ''}${busy ? ` · ojo: ${busy} con planes` : ''}`);
});

// ---- Actions ----

// Approving moves the proposal into `hangouts`, the only collection friends
// can read, and adds the proposer as the first participant.
function approve(p) {
  return act(async () => {
    const batch = writeBatch(db);
    batch.set(doc(db, 'hangouts', p.id), {
      date: p.date, slot: p.slot, title: p.title, place: p.place,
      proposer_name: p.proposer_name, note: p.note, created_at: p.created_at ?? serverTimestamp(),
    });
    const name = cleanName(p.proposer_name);
    if (name && name !== '.' && name !== '..') {
      batch.set(doc(db, 'hangouts', p.id, 'participants', nameKey(name)), { name, created_at: serverTimestamp() });
    }
    batch.delete(doc(db, 'proposals', p.id));
    await batch.commit();
  }, 'Aprobado. Ya lo ven tus amigos.');
}

function removeHangout(h) {
  if (!confirm(`¿Borrar «${h.title}»? Tus amigos dejarán de verlo.`)) return;
  act(async () => {
    const batch = writeBatch(db);
    for (const person of state.participants.get(h.id) || []) {
      batch.delete(doc(db, 'hangouts', h.id, 'participants', person.key));
    }
    batch.delete(doc(db, 'hangouts', h.id));
    await batch.commit();
  }, 'Borrado');
}

function addParticipant(h) {
  const name = cleanName(prompt('Nombre') || '');
  if (!name || name === '.' || name === '..') return;
  act(() => setDoc(doc(db, 'hangouts', h.id, 'participants', nameKey(name)), { name, created_at: serverTimestamp() }));
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
  act(() => updateDoc(doc(db, collectionName, id), data), 'Guardado');
});

$('copy-link').addEventListener('click', () => copy($('link').textContent));
$('share-link').addEventListener('click', () => {
  const text = `¡Voy a Cochabamba! Propón un plan o apúntate a uno aquí: ${$('link').textContent}`;
  window.open(whatsappUrl(text), '_blank', 'noopener');
});
$('rotate').addEventListener('click', () => {
  if (!confirm('¿Cambiar el código? Todos los enlaces que ya mandaste dejan de funcionar.')) return;
  act(() => updateDoc(doc(db, 'settings', 'main'), { invite_code: randomCode() }), 'Código nuevo. Manda el enlace nuevo.');
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
  for (const b of state.blocked.filter((b) => b.kind === 'personal')) {
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
  if (!state.hangouts.length && !state.blocked.some((b) => b.kind === 'personal')) return toast('No hay nada que exportar.');
  const blob = new Blob([buildIcs(state.hangouts)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: 'cochabamba.ics' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
