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

export const LIMITS = { title: 80, place: 80, name: 40, note: 280, mapUrl: 500 };

// ---- How many people ----

// capacity is the size of the whole gathering, Jose included; null means no
// limit. going counts everyone else who joined (the proposer too).
export const CAPACITY = { min: 2, max: 50 };
export const isFull = (capacity, going) => capacity != null && going + 1 >= capacity;
// Places still free, or Infinity without a limit.
export const spotsLeft = (capacity, going) => (capacity == null ? Infinity : Math.max(0, capacity - 1 - going));

// A capacity typed into a form: a whole number in range, or null (no limit).
export function cleanCapacity(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= CAPACITY.min && n <= CAPACITY.max ? n : undefined;
}

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
// private time. An open plan is { label: '', kind: 'open' }: friends read the
// plan itself while it has room, and see "Ocupado" once it is full and they
// are not in it. A slot with an open plan still takes proposals.
export function publicSlots(reservations, hangouts) {
  const slots = new Map();
  const marker = (item, kind) => ({ date: item.date, slot: item.slot, label: '', kind });
  for (const r of reservations) {
    slots.set(slotKey(r.date, r.slot), r.open ? { date: r.date, slot: r.slot, label: r.label, kind: r.kind } : marker(r, 'busy'));
  }
  // Private plans first: a slot that holds one is busy, whatever else is there.
  for (const h of [...hangouts].sort((a, b) => Number(a.open) - Number(b.open))) {
    const id = slotKey(h.date, h.slot);
    if (!slots.has(id)) slots.set(id, marker(h, h.open ? 'open' : 'busy'));
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

// ---- Places ----

// Cochabamba, where a map starts when there is no pin yet.
export const HOME = { lat: -17.3895, lng: -66.1568, zoom: 13 };

const inRange = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng)
  && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
const point = (lat, lng) => {
  const p = { lat: Number(lat), lng: Number(lng) };
  return inRange(p.lat, p.lng) ? { lat: round(p.lat), lng: round(p.lng) } : null;
};
// Six decimals is about 10 cm: plenty for a meeting point.
const round = (n) => Math.round(n * 1e6) / 1e6;
const NUM = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
const SEP = String.raw`\s*,\s*`;

// Coordinates in a pasted link or text, or null. Understands Google Maps
// (place links, ?q=, ?query=, @lat,lng), Apple Maps (ll=, q=, coordinate=),
// OpenStreetMap (mlat/mlon, #map=), geo: links and plain "lat, lng". Short
// share links (maps.app.goo.gl/...) carry no coordinates: null.
export function parseLocation(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  let decoded = value;
  try { decoded = decodeURIComponent(value.replace(/\+/g, ' ')); } catch { /* keep as is */ }
  const patterns = [
    String.raw`!3d${NUM}!4d${NUM}`, // Google place link: the pin itself
    String.raw`[?&#]mlat=${NUM}&mlon=${NUM}`, // OpenStreetMap marker
    String.raw`[?&](?:q|query|ll|sll|coordinate|destination|daddr|center)=${NUM}${SEP}${NUM}`,
    String.raw`^geo:${NUM},${NUM}`,
    String.raw`#map=\d+(?:\.\d+)?/${NUM}/${NUM}`, // OpenStreetMap view
    String.raw`@${NUM},${NUM}`, // Google view center
    String.raw`^${NUM}${SEP}${NUM}$`, // plain "lat, lng"
  ];
  for (const pattern of patterns) {
    const match = decoded.match(new RegExp(pattern));
    if (match) return point(match[1], match[2]);
  }
  return null;
}

// Only web links: a stored link is opened by friends, so never javascript: or data:.
export function cleanMapUrl(value) {
  const text = String(value ?? '').trim().slice(0, LIMITS.mapUrl);
  return /^https?:\/\/[^\s]+$/i.test(text) ? text : '';
}

// A place as stored: { map_url, lat, lng }, from what a form holds.
export function cleanPlace({ url, lat, lng } = {}) {
  const pin = lat == null || lng == null ? null : point(lat, lng);
  return { map_url: cleanMapUrl(url), lat: pin?.lat ?? null, lng: pin?.lng ?? null };
}

export const hasPlace = (place) => !!place && (place.lat != null || !!place.map_url);

// Links that open the pin in the map apps people have.
export function mapLinks({ lat, lng }, label = '') {
  const at = `${lat},${lng}`;
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(at)}`,
    apple: `https://maps.apple.com/?ll=${encodeURIComponent(at)}&q=${encodeURIComponent(label || at)}`,
  };
}

// ---- Telling people ----

// "viernes, 18 de diciembre, mañana (10:00 a 12:30)"
export function whenLong(date, slot) {
  const times = slotById[slot];
  return `${formatDay(date)}, ${times.label.toLowerCase()} (${times.start} a ${times.end})`;
}

// A WhatsApp number as wa.me wants it: digits only, country code included.
export function cleanPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

// A WhatsApp message to a number, or, without one, to whoever the sender picks.
export const whatsappUrl = (text, phone = '') => `https://wa.me/${cleanPhone(phone)}?text=${encodeURIComponent(text)}`;

// A date and slot time as calendars write local times: 20261218T100000.
const localStamp = (date, time) => `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;

// "Add to Google Calendar" for one plan, in Bolivia time.
export function googleCalendarUrl({ date, slot, title, place = '', details = '' }) {
  const times = slotById[slot];
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${localStamp(date, times.start)}/${localStamp(date, times.end)}`,
    ctz: 'America/La_Paz',
  });
  if (place) params.set('location', place);
  if (details) params.set('details', details);
  return `https://calendar.google.com/calendar/render?${params}`;
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
    const hangout = approved ? receipt.hangout ?? p.id : null;
    if (approved && openIds.has(hangout)) continue;
    shown.push({ ...entry, hangout, status: approved ? 'confirmed' : 'waiting' });
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

// hangouts: [{ id, date, slot, title, place, proposer_name, note, location }]
// reservations: [{ id, date, slot, label, kind }]; only the host's own time
// ('personal') is exported, not travel or family blocks.
// participants: hangout id -> [{ name }]
export function buildIcs({ hangouts, reservations, participants, now = new Date() }) {
  const local = localStamp;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const event = ({ id, date, slot, summary, location, description, pin }) => {
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
      pin?.lat != null ? `GEO:${pin.lat};${pin.lng}` : null,
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
      id: h.id, date: h.date, slot: h.slot, summary: h.title, location: h.place, pin: h.location,
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
