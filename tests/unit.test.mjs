// Unit tests for lib.js, the pure helpers both pages use. No emulator, no
// browser, no dependencies:   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_IDS, slotKey, slotHours, tripDays, daysBetween, weekday, dayParts, formatDay, todayInBolivia,
  countdownText, plural, freeText, clean, cleanName, nameKey, reservationStatus, randomCode,
  publicSlots, publicDiff, sentStatus, icsFold, buildIcs, isFull, spotsLeft, cleanCapacity, parseLocation,
  cleanMapUrl, cleanPlace, hasPlace, mapLinks,
} from '../lib.js';

test('slots: keys and hours come from the slot times', () => {
  assert.equal(slotKey('2026-12-18', 'tarde'), '2026-12-18_tarde');
  assert.deepEqual(SLOT_IDS.map(slotHours), [2.5, 2.5, 3.5, 3.5]);
  assert.equal(slotHours('madrugada'), 0);
});

test('dates: the trip is 20 days across the new year', () => {
  const days = tripDays('2026-12-14', '2027-01-02');
  assert.equal(days.length, 20);
  assert.equal(days[0], '2026-12-14');
  assert.equal(days.at(-1), '2027-01-02');
  assert.ok(days.includes('2026-12-31') && days.includes('2027-01-01'));
  assert.deepEqual(tripDays('2026-12-14', '2026-12-14'), ['2026-12-14']);
  assert.equal(daysBetween('2026-12-14', '2027-01-02'), 19);
  assert.equal(weekday('2026-12-14'), 1); // Monday
  assert.equal(weekday('2026-12-20'), 0); // Sunday
});

test('dates: Spanish names do not depend on the local time zone', () => {
  const parts = dayParts('2026-12-14');
  assert.equal(parts.day, 14);
  assert.equal(parts.monthLong, 'diciembre');
  assert.equal(parts.weekday, 'lun');
  assert.match(formatDay('2027-01-02'), /^sábado,? 2 de enero$/);
});

test('dates: today is the date in Bolivia (UTC-4)', () => {
  assert.equal(todayInBolivia(new Date('2026-12-15T03:59:00Z')), '2026-12-14');
  assert.equal(todayInBolivia(new Date('2026-12-15T04:00:00Z')), '2026-12-15');
});

test('countdown: before, during and after the trip', () => {
  const [start, end] = ['2026-12-14', '2027-01-02'];
  assert.equal(countdownText(start, end, '2026-12-13'), 'Falta 1 día');
  assert.equal(countdownText(start, end, '2026-12-01'), 'Faltan 13 días');
  assert.equal(countdownText(start, end, '2026-12-14'), 'Día 1 de 20');
  assert.equal(countdownText(start, end, '2027-01-02'), 'Día 20 de 20');
  assert.equal(countdownText(start, end, '2027-01-03'), 'Hasta la próxima');
});

test('text: plural and free slots', () => {
  assert.equal(plural(1, 'plan', 'planes'), '1 plan');
  assert.equal(plural(2, 'plan', 'planes'), '2 planes');
  assert.equal(freeText(0), 'Ya no quedan espacios libres.');
  assert.equal(freeText(1), 'Queda 1 espacio libre.');
  assert.equal(freeText(5), 'Quedan 5 espacios libres.');
});

test('text: clean trims, collapses whitespace and cuts without a trailing space', () => {
  assert.equal(clean('  Café \n y   salteñas '), 'Café y salteñas');
  assert.equal(clean('abc def', 4), 'abc');
  assert.equal(clean(null, 10), '');
});

test('names: unusable as document ids become no name', () => {
  assert.equal(cleanName(' Caro '), 'Caro');
  assert.equal(cleanName('Ana/María'), 'Ana María');
  assert.equal(cleanName('x'.repeat(50)).length, 40);
  for (const bad of ['.', '..', '__x__', '/', '   ']) assert.equal(cleanName(bad), '', bad);
  assert.equal(cleanName('...'), '...');
  assert.equal(nameKey('MARÍA'), 'maría');
});

test('reservations: own time versus blocks', () => {
  assert.equal(reservationStatus('personal'), 'own');
  assert.equal(reservationStatus('block'), 'off');
});

test('invite code: 20 characters without look-alikes', () => {
  for (let i = 0; i < 50; i++) {
    const code = randomCode();
    assert.match(code, /^[a-km-np-zA-HJ-NP-Z2-9]{20}$/);
  }
  assert.notEqual(randomCode(), randomCode());
});

test('public projection: private items are anonymous, open ones keep their label', () => {
  const reservations = [
    { id: '2026-12-15_manana', date: '2026-12-15', slot: 'manana', label: 'Gimnasio', kind: 'personal', open: false },
    { id: '2026-12-25_manana', date: '2026-12-25', slot: 'manana', label: 'Navidad en familia', kind: 'block', open: true },
    { id: '2026-12-19_noche', date: '2026-12-19', slot: 'noche', label: 'Trabajo', kind: 'personal', open: true },
  ];
  const hangouts = [
    { id: 'a', date: '2026-12-18', slot: 'tarde', open: false },  // private plan
    { id: 'b', date: '2026-12-20', slot: 'noche', open: true },   // open plan: an anonymous 'open' marker
    { id: 'c', date: '2026-12-19', slot: 'noche', open: false },  // under an open reservation
    { id: 'd', date: '2026-12-21', slot: 'tarde', open: true },   // open and private in one slot:
    { id: 'e', date: '2026-12-21', slot: 'tarde', open: false },  // private wins
  ];
  const slots = publicSlots(reservations, hangouts);
  assert.deepEqual(Object.fromEntries(slots), {
    '2026-12-15_manana': { date: '2026-12-15', slot: 'manana', label: '', kind: 'busy' },
    '2026-12-25_manana': { date: '2026-12-25', slot: 'manana', label: 'Navidad en familia', kind: 'block' },
    '2026-12-19_noche': { date: '2026-12-19', slot: 'noche', label: 'Trabajo', kind: 'personal' },
    '2026-12-18_tarde': { date: '2026-12-18', slot: 'tarde', label: '', kind: 'busy' },
    '2026-12-20_noche': { date: '2026-12-20', slot: 'noche', label: '', kind: 'open' },
    '2026-12-21_tarde': { date: '2026-12-21', slot: 'tarde', label: '', kind: 'busy' },
  });
  // Nothing private: no label, and one kind for private plans and private time alike.
  for (const marker of slots.values()) assert.ok(marker.label || ['busy', 'open'].includes(marker.kind));
});

test('limits: the host counts, and full means no more room', () => {
  assert.equal(isFull(null, 30), false, 'no limit');
  assert.equal(isFull(6, 4), false, 'Jose + 4 of 6');
  assert.equal(isFull(6, 5), true, 'Jose + 5 of 6');
  assert.equal(spotsLeft(6, 2), 3);
  assert.equal(spotsLeft(6, 9), 0);
  assert.equal(spotsLeft(null, 3), Infinity);
  assert.equal(cleanCapacity(''), null);
  assert.equal(cleanCapacity(' 6 '), 6);
  for (const bad of ['1', '51', '2.5', 'seis']) assert.equal(cleanCapacity(bad), undefined, bad);
});

test('places: coordinates from the links people paste', () => {
  const at = (lat, lng) => ({ lat, lng });
  const cases = [
    // A Google place link: the pin (!3d!4d), not the view center (@).
    ['https://www.google.com/maps/place/Caf%C3%A9/@-17.38,-66.15,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-17.3812345!4d-66.1601234', at(-17.381234, -66.160123)],
    ['https://www.google.com/maps?q=-17.39%2C-66.16', at(-17.39, -66.16)],
    ['https://www.google.com/maps/search/?api=1&query=-17.39,-66.16', at(-17.39, -66.16)],
    ['https://www.google.com/maps/@-17.3912,-66.1534,15z', at(-17.3912, -66.1534)],
    ['https://maps.apple.com/?ll=-17.39,-66.16&q=Pin', at(-17.39, -66.16)],
    ['https://maps.apple.com/?coordinate=-17.39,-66.16', at(-17.39, -66.16)],
    ['https://www.openstreetmap.org/?mlat=-17.39&mlon=-66.16#map=17/-17.40/-66.17', at(-17.39, -66.16)],
    ['https://www.openstreetmap.org/#map=15/-17.40/-66.17', at(-17.4, -66.17)],
    ['geo:-17.39,-66.16', at(-17.39, -66.16)],
    ['-17.39, -66.16', at(-17.39, -66.16)],
  ];
  for (const [text, expected] of cases) assert.deepEqual(parseLocation(text), expected, text);
  for (const none of ['https://maps.app.goo.gl/AbCd123', 'Café París', '', '0,0', '91, 10', '-17.39, 181']) {
    assert.equal(parseLocation(none), null, none);
  }
});

test('places: only web links are kept, pins are rounded', () => {
  assert.equal(cleanMapUrl('javascript:alert(1)'), '');
  assert.equal(cleanMapUrl('data:text/html,x'), '');
  assert.equal(cleanMapUrl(' https://maps.app.goo.gl/x '), 'https://maps.app.goo.gl/x');
  assert.deepEqual(cleanPlace({ url: 'https://maps.app.goo.gl/x', lat: -17.123456789, lng: -66.1 }),
    { map_url: 'https://maps.app.goo.gl/x', lat: -17.123457, lng: -66.1 });
  assert.deepEqual(cleanPlace({ url: '-17.39, -66.16' }), { map_url: '', lat: null, lng: null });
  assert.equal(hasPlace(cleanPlace({})), false);
  assert.equal(hasPlace({ map_url: 'https://x.y', lat: null, lng: null }), true);
  const links = mapLinks({ lat: -17.39, lng: -66.16 }, 'Juegos & café');
  assert.equal(links.google, 'https://www.google.com/maps/search/?api=1&query=-17.39%2C-66.16');
  assert.equal(links.apple, 'https://maps.apple.com/?ll=-17.39%2C-66.16&q=Juegos%20%26%20caf%C3%A9');
});

test('public projection: the diff writes only what changed', () => {
  const marker = (label, kind) => ({ date: '2026-12-15', slot: 'manana', label, kind });
  const current = new Map([
    ['2026-12-15_manana', marker('', 'personal')], // kind from an older version
    ['2026-12-16_manana', { date: '2026-12-16', slot: 'manana', label: '', kind: 'busy' }],
    ['2026-12-17_manana', { date: '2026-12-17', slot: 'manana', label: 'x', kind: 'block' }],
  ]);
  const wanted = new Map([
    ['2026-12-15_manana', marker('', 'busy')],
    ['2026-12-17_manana', { date: '2026-12-17', slot: 'manana', label: 'x', kind: 'block' }],
    ['2026-12-18_noche', { date: '2026-12-18', slot: 'noche', label: '', kind: 'busy' }],
  ]);
  const { set, remove } = publicDiff(current, wanted);
  assert.deepEqual(set.map(([id]) => id), ['2026-12-15_manana', '2026-12-18_noche']);
  assert.deepEqual(remove, ['2026-12-16_manana']);
  assert.deepEqual(publicDiff(wanted, wanted), { set: [], remove: [] });
});

test('sent proposals: what the proposer sees of their own plans', () => {
  const today = '2026-11-01';
  const sent = [
    { id: 'wait', date: '2026-12-18', slot: 'tarde', title: 'Café' },
    { id: 'no', date: '2026-12-18', slot: 'noche', title: 'Cine' },
    { id: 'yes', date: '2026-12-19', slot: 'tarde', title: 'Fútbol' },
    { id: 'moved', date: '2026-12-20', slot: 'tarde', title: 'Asado' },
    { id: 'opened', date: '2026-12-21', slot: 'noche', title: 'Fiesta' },
    { id: 'legacy', date: '2026-12-22', slot: 'noche', title: 'Bar' },
    { id: 'old', date: '2026-10-30', slot: 'noche', title: 'Ya pasó' },
  ];
  const receipts = new Map([
    ['no', { status: 'rejected' }],
    ['yes', { status: 'approved', date: '2026-12-19', slot: 'tarde', title: 'Fútbol', hangout: 'h-yes' }],
    ['moved', { status: 'approved', date: '2026-12-27', slot: 'noche', title: 'Asado y piscina', hangout: 'h-moved' }],
    ['opened', { status: 'approved', date: '2026-12-21', slot: 'noche', title: 'Fiesta', hangout: 'h-opened' }],
    ['legacy', { status: 'approved' }], // approved before receipts carried details
  ]);
  const openIds = new Set(['h-opened', 'legacy']);
  const { keep, shown } = sentStatus(sent, receipts, openIds, today);

  assert.deepEqual(keep.map((p) => p.id), ['wait', 'yes', 'moved', 'opened', 'legacy'], 'rejected and past unanswered ones are dropped');
  assert.deepEqual(shown.map((p) => [p.id, p.status]), [['wait', 'waiting'], ['yes', 'confirmed'], ['moved', 'confirmed']],
    'open plans are drawn with the open plans, not twice');
  const moved = shown.find((p) => p.id === 'moved');
  assert.deepEqual([moved.date, moved.slot, moved.title], ['2026-12-27', 'noche', 'Asado y piscina'], 'the host\'s edits win');
  assert.equal(keep.find((p) => p.id === 'moved').date, '2026-12-27', 'the device keeps the edited copy');

  // The open plan turns private again: the proposer still sees it.
  const again = sentStatus(keep, receipts, new Set(), today);
  assert.ok(again.shown.some((p) => p.id === 'opened' && p.status === 'confirmed'));
  assert.ok(again.shown.some((p) => p.id === 'legacy' && p.title === 'Bar'));

  // No answer for weeks: still waiting, not forgotten.
  const later = sentStatus(keep, new Map(), new Set(), '2026-12-17');
  assert.ok(later.shown.some((p) => p.id === 'wait' && p.status === 'waiting'));
});

test('.ics: lines are folded at 75 octets and unfold to the original', () => {
  const line = 'SUMMARY:' + 'Salteñas y café con la familia en la casa de la abuela, ñ '.repeat(3);
  const folded = icsFold(line);
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => Buffer.byteLength(part) <= 75));
  assert.ok(parts.slice(1).every((part) => part.startsWith(' ')));
  assert.equal(folded.replace(/\r\n /g, ''), line);
  assert.equal(icsFold('SHORT'), 'SHORT');
});

test('.ics: events, escaping, time zone; only own time from reservations', () => {
  const ics = buildIcs({
    hangouts: [{
      id: 'h1', date: '2026-12-18', slot: 'manana', title: 'Café; luego, cine', place: 'Zona norte', proposer_name: 'Caro',
      note: 'línea 1\nlínea 2', location: { map_url: '', lat: -17.39, lng: -66.16 },
    }],
    reservations: [
      { id: '2026-12-15_manana', date: '2026-12-15', slot: 'manana', label: 'Gimnasio', kind: 'personal' },
      { id: '2026-12-25_manana', date: '2026-12-25', slot: 'manana', label: 'Navidad', kind: 'block' },
    ],
    participants: new Map([['h1', [{ name: 'Caro' }, { name: 'Luis' }]]]),
    now: new Date('2026-11-01T12:34:56.789Z'),
  });
  const text = ics.replace(/\r\n /g, '');
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'every line ends in CRLF');
  assert.ok(text.includes('TZID:America/La_Paz'));
  assert.ok(text.includes('DTSTAMP:20261101T123456Z'));
  assert.ok(text.includes('DTSTART;TZID=America/La_Paz:20261218T100000'));
  assert.ok(text.includes('DTEND;TZID=America/La_Paz:20261218T123000'));
  assert.ok(text.includes('SUMMARY:Café\\; luego\\, cine'));
  assert.ok(text.includes('LOCATION:Zona norte'));
  assert.ok(text.includes('GEO:-17.39;-66.16'));
  assert.ok(text.includes('Vienen: Caro\\, Luis\\nNota: línea 1\\nlínea 2'));
  assert.ok(text.includes('SUMMARY:Gimnasio'));
  assert.ok(!text.includes('Navidad'), 'family blocks are not exported');
  assert.equal(text.match(/BEGIN:VEVENT/g).length, 2);
});

test('telling people: when, WhatsApp links and Google Calendar', async () => {
  const { whenLong, cleanPhone, whatsappUrl, googleCalendarUrl } = await import('../lib.js');
  assert.match(whenLong('2026-12-18', 'manana'), /^viernes,? 18 de diciembre, mañana \(10:00 a 12:30\)$/);
  assert.equal(cleanPhone('+591 700-00000'), '59170000000');
  assert.equal(cleanPhone('123'), '', 'too short to be a number');
  assert.equal(whatsappUrl('Hola & chau', '+591 70000000'), 'https://wa.me/59170000000?text=Hola%20%26%20chau');
  assert.equal(whatsappUrl('Hola'), 'https://wa.me/?text=Hola', 'no number: WhatsApp asks whom to send it to');
  const url = new URL(googleCalendarUrl({ date: '2026-12-18', slot: 'noche', title: 'Juegos de mesa', place: '-17.39,-66.16' }));
  assert.equal(url.origin + url.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('text'), 'Juegos de mesa');
  assert.equal(url.searchParams.get('dates'), '20261218T200000/20261218T233000');
  assert.equal(url.searchParams.get('ctz'), 'America/La_Paz');
  assert.equal(url.searchParams.get('location'), '-17.39,-66.16');
});
