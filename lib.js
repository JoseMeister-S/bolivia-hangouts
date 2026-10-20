// Pure helpers shared by both pages and the unit tests (npm run test:unit):
// slots, dates, text, what friends may see, and the .ics file. Nothing here
// touches Firebase, the DOM or the page URL, so Node can import it.
// All dates are plain 'YYYY-MM-DD' strings in Bolivia time; nothing here
// depends on the visitor's time zone.

// ---- Slots ----

// Default times are Bolivia time (America/La_Paz, UTC-4, no DST).
export const SLOTS = [
  { id: 'manana', label: 'Mañana', start: '10:00', end: '12:30' },
  { id: 'almuerzo', label: 'Almuerzo', start: '12:30', end: '15:00' },
  { id: 'tarde', label: 'Tarde', start: '15:30', end: '19:00' },
  { id: 'noche', label: 'Noche', start: '20:00', end: '23:30' },
];
export const SLOT_IDS = SLOTS.map((s) => s.id);
export const slotById = Object.fromEntries(SLOTS.map((s) => [s.id, s]));
export const slotIndex = (id) => SLOT_IDS.indexOf(id);

// The id of everything stored per slot: reservations, blocked_slots.
export const slotKey = (date, slot) => `${date}_${slot}`;

const minutes = (time) => {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
};
// Length of a slot in hours (2.5 for 10:00 to 12:30).
export function slotHours(id) {
  const slot = slotById[id];
  return slot ? (minutes(slot.end) - minutes(slot.start)) / 60 : 0;
}

export const LIMITS = { title: 80, place: 80, name: 40, note: 280 };

// ---- Dates ----

// Midnight UTC of a 'YYYY-MM-DD' day, so date maths ignores the local zone.
export const utcDate = (iso) => new Date(iso + 'T00:00:00Z');
export const weekday = (iso) => utcDate(iso).getUTCDay(); // 0 = Sunday, 1 = Monday

// Every 'YYYY-MM-DD' from start to end, inclusive.
export function tripDays(start, end) {
  const days = [];
  const d = utcDate(start);
  const last = utcDate(end);
  while (d <= last) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

const DAY_MS = 24 * 3600 * 1000;
export const daysBetween = (from, to) => Math.round((utcDate(to) - utcDate(from)) / DAY_MS);

const dayFormat = new Intl.DateTimeFormat('es-BO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
export const formatDay = (iso) => dayFormat.format(utcDate(iso));

const partsFormat = new Intl.DateTimeFormat('es-BO', { weekday: 'short', month: 'short', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat('es-BO', { month: 'long', timeZone: 'UTC' });
// { weekday: 'lun', day: 14, month: 'dic', monthLong: 'diciembre' }
export function dayParts(iso) {
  const date = utcDate(iso);
  const parts = Object.fromEntries(partsFormat.formatToParts(date).map((p) => [p.type, p.value.replace('.', '')]));
  return { weekday: parts.weekday, day: date.getUTCDate(), month: parts.month, monthLong: monthFormat.format(date) };
}

// Today's date in Bolivia, whatever the visitor's own time zone is.
export function todayInBolivia(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz' }).format(now);
}

export function countdownText(start, end, today) {
  if (today < start) {
    const left = daysBetween(today, start);
    return left === 1 ? 'Falta 1 día' : `Faltan ${left} días`;
  }
  if (today > end) return 'Hasta la próxima';
  return `Día ${daysBetween(start, today) + 1} de ${daysBetween(start, end) + 1}`;
}

// ---- Text ----

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export const freeText = (n) => (n
  ? `${n === 1 ? 'Queda' : 'Quedan'} ${plural(n, 'espacio libre', 'espacios libres')}.`
  : 'Ya no quedan espacios libres.');

// Trim, collapse inner whitespace and cut to the maximum length.
export function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

// Names double as document ids (lower-cased), so a name Firestore refuses as
// an id ('/', '.', '..', '__x__') is cleaned to '' (no name).
export function cleanName(value) {
  const name = clean(String(value ?? '').replace(/\//g, ' '), LIMITS.name);
  return /^\.\.?$|^__.*__$/.test(name) ? '' : name;
}

export const nameKey = (name) => name.toLowerCase();

// How a reservation is drawn: the host's own time, or a block (travel, family).
export const reservationStatus = (kind) => (kind === 'personal' ? 'own' : 'off');

export function randomCode(length = 20) {
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

// ---- What friends may see ----

// Friends never read reservations or private plans. They read `blocked_slots`:
// one document per taken slot, id -> { date, slot, label, kind }. Only an item
// the host opened carries its label and kind. Anything private is
// { label: '', kind: 'busy' }, so friends cannot tell a private plan from
// private time. An open plan needs no marker: friends read the plan itself.
export function publicSlots(reservations, hangouts) {
  const slots = new Map();
  const busy = (item) => ({ date: item.date, slot: item.slot, label: '', kind: 'busy' });
  for (const r of reservations) {
    slots.set(slotKey(r.date, r.slot), r.open ? { date: r.date, slot: r.slot, label: r.label, kind: r.kind } : busy(r));
  }
  for (const h of hangouts) {
    const id = slotKey(h.date, h.slot);
    if (!h.open && !slots.has(id)) slots.set(id, busy(h));
  }
  return slots;
}

// The writes that turn `current` into `wanted` (both id -> document).
export function publicDiff(current, wanted) {
  const same = (a, b) => a.date === b.date && a.slot === b.slot && a.label === b.label && a.kind === b.kind;
  const set = [...wanted].filter(([id, want]) => !current.has(id) || !same(current.get(id), want));
  const remove = [...current.keys()].filter((id) => !wanted.has(id));
  return { set, remove };
}

// ---- Proposals sent from this device ----

// Friends cannot read proposals, and a confirmed plan stays private unless the
// host opens it, so the friends' page keeps the proposals it sent and asks for
// their receipts. `receipts` is proposal id -> { status, date, slot, title,
// hangout }. The receipt's date, slot and title win over the device's copy,
// because the host may have edited them. Returns:
//   keep   the list to store again on the device
//   shown  what to draw, each with status 'waiting' or 'confirmed' (approved
//          and private). An approved plan that is open is drawn with the open
//          plans instead; it stays in `keep` in case it turns private again.
// Rejected proposals are dropped, and so are unanswered ones whose day is past.
export function sentStatus(sent, receipts, openIds, today) {
  const keep = [];
  const shown = [];
  for (const p of sent) {
    const receipt = receipts.get(p.id) || {};
    if (receipt.status === 'rejected') continue;
    const approved = receipt.status === 'approved';
    const entry = {
      id: p.id,
      date: receipt.date ?? p.date,
      slot: receipt.slot ?? p.slot,
      title: receipt.title ?? p.title,
    };
    if (!approved && entry.date < today) continue;
    keep.push(entry);
    // Plans approved before receipts named the hangout share the proposal's id.
    if (approved && openIds.has(receipt.hangout ?? p.id)) continue;
    shown.push({ ...entry, status: approved ? 'confirmed' : 'waiting' });
  }
  return { keep, shown };
}

// ---- .ics export ----

const icsEscape = (text) => String(text ?? '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// RFC 5545: lines are at most 75 octets; continuation lines start with a space.
const encoder = new TextEncoder();
export function icsFold(line) {
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
}

// hangouts: [{ id, date, slot, title, place, proposer_name, note }]
// reservations: [{ id, date, slot, label, kind }]; only the host's own time
// ('personal') is exported, not travel or family blocks.
// participants: hangout id -> [{ name }]
export function buildIcs({ hangouts, reservations, participants, now = new Date() }) {
  const local = (date, time) => `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const event = ({ id, date, slot, summary, location, description }) => {
    const times = slotById[slot];
    if (!times) return [];
    return [
      'BEGIN:VEVENT',
      `UID:${id}@bolivia-hangouts`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=America/La_Paz:${local(date, times.start)}`,
      `DTEND;TZID=America/La_Paz:${local(date, times.end)}`,
      `SUMMARY:${icsEscape(summary)}`,
      location ? `LOCATION:${icsEscape(location)}` : null,
      description ? `DESCRIPTION:${icsEscape(description)}` : null,
      'END:VEVENT',
    ];
  };

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
    const people = (participants.get(h.id) || []).map((p) => p.name);
    lines.push(...event({
      id: h.id, date: h.date, slot: h.slot, summary: h.title, location: h.place,
      description: [
        `Propuesto por ${h.proposer_name}`,
        `Vienen: ${people.length ? people.join(', ') : 'nadie todavía'}`,
        h.note ? `Nota: ${h.note}` : null,
      ].filter(Boolean).join('\n'),
    }));
  }
  for (const r of reservations.filter((r) => r.kind === 'personal')) {
    lines.push(...event({ id: r.id, date: r.date, slot: r.slot, summary: r.label }));
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).map(icsFold).join('\r\n') + '\r\n';
}
