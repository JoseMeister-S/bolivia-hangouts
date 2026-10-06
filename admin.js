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
  clean, cleanName, nameKey, friendLink, whatsappUrl, toast,
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
    $('who').textContent = '';
    return show('login');
  }
  $('who').textContent = user.email || '';
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

function render() {
  const link = friendLink(state.settings.invite_code);
  $('link').textContent = link;

  const pending = state.proposals.filter((p) => p.status === 'pending');
  const rejected = state.proposals.filter((p) => p.status !== 'pending');
  $('pending-count').textContent = pending.length;
  $('rejected-count').textContent = rejected.length;
  $('approved-count').textContent = state.hangouts.length;

  $('pending').replaceChildren(...(pending.length ? pending.map(renderPending)
    : [el('p', { class: 'empty' }, 'Nada pendiente.')]));
  $('rejected').replaceChildren(...(rejected.length ? rejected.map(renderRejected)
    : [el('p', { class: 'empty' }, 'Nada rechazado.')]));
  $('approved').replaceChildren(...(state.hangouts.length ? state.hangouts.map(renderApproved)
    : [el('p', { class: 'empty' }, 'Todavía no hay planes confirmados.')]));
  $('blocked').replaceChildren(...state.blocked.map(renderBlocked));

  const days = tripDays(state.settings.trip_start, state.settings.trip_end);
  for (const select of [$('block-form').elements.date, $('edit-form').elements.date]) {
    const current = select.value;
    select.replaceChildren(...days.map((d) => el('option', { value: d }, formatDayShort(d))));
    if (current) select.value = current;
  }
  const slotOptions = () => SLOTS.map((s) => el('option', { value: s.id }, s.label));
  $('edit-form').elements.slot.replaceChildren(...slotOptions());
  const blockSlot = $('block-form').elements.slot;
  if (blockSlot.options.length === 1) blockSlot.append(...slotOptions());
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

function renderBlocked(b) {
  return el('li', {},
    el('span', {}, `${formatDayShort(b.date)} · ${slotById[b.slot]?.label ?? b.slot} — ${b.label}`),
    el('button', { type: 'button', class: 'btn small danger', onclick: () => act(() => deleteDoc(doc(db, 'blocked_slots', b.id))) }, 'Quitar'),
  );
}

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

$('block-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const fields = $('block-form').elements;
  const date = fields.date.value;
  const label = clean(fields.label.value, 80);
  const slots = fields.slot.value === 'all' ? ALL : [fields.slot.value];
  if (!date || !label) return;
  act(async () => {
    const batch = writeBatch(db);
    for (const slot of slots) batch.set(doc(db, 'blocked_slots', `${date}_${slot}`), { date, slot, label });
    await batch.commit();
    fields.label.value = '';
  }, 'Bloqueado');
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
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).map(fold).join('\r\n') + '\r\n';
}

$('export').addEventListener('click', () => {
  if (!state.hangouts.length) return toast('No hay planes confirmados.');
  const blob = new Blob([buildIcs(state.hangouts)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: 'cochabamba.ics' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
