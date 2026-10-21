// Security tests for firestore.rules.
//
// Two modes, same assertions:
//   npm run test:rules              -> Firestore emulator (full suite, seeded data)
//   INVITE_CODE=xxx npm run test:live -> live project, using ONLY the public web
//                                        config + anonymous sign-in, like a friend.
//
// The live run leaves one pending proposal titled "[TEST] security script".
// Delete it in admin.html.
import fs from 'node:fs';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  getFirestore, doc, collection, collectionGroup, getDoc, getDocs, setDoc,
  updateDoc, deleteDoc, writeBatch, serverTimestamp, increment, Timestamp, query, where,
} from 'firebase/firestore';

// What the friends' page asks for: only hangouts the admin marked open, with room.
const openHangouts = (db) => query(collection(db, 'hangouts'), where('open', '==', true), where('full', '==', false));

// The page's join: the name, this device's joined document and one more in the
// count, in one batch. Options break one part at a time.
function join(db, uid, hangoutId, name, { going, capacity = null, key = name.toLowerCase(), joined = true, bump = 1, full } = {}) {
  const batch = writeBatch(db);
  batch.set(doc(db, 'hangouts', hangoutId, 'participants', key), { name, created_at: serverTimestamp() });
  if (joined) batch.set(doc(db, 'hangouts', hangoutId, 'joined', uid), { uid, key });
  if (bump) {
    const after = going + bump;
    batch.update(doc(db, 'hangouts', hangoutId), { going: after, full: full ?? (capacity != null && after + 1 >= capacity) });
  }
  return batch.commit();
}

const EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST;
const results = [];

function record(ok, name, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}

async function denied(name, fn) {
  try {
    await fn();
    record(false, name, 'expected permission-denied, but it succeeded');
  } catch (e) {
    record(e.code === 'permission-denied', name, e.code === 'permission-denied' ? '' : `unexpected error: ${e.code || e.message}`);
  }
}

async function allowed(name, fn) {
  try {
    const value = await fn();
    record(true, name);
    return value;
  } catch (e) {
    record(false, name, `unexpected error: ${e.code || e.message}`);
    return undefined;
  }
}

const baseProposal = () => ({
  date: '2026-12-18',
  slot: 'tarde',
  title: '[TEST] security script',
  place: 'Test',
  proposer_name: 'Tester',
  note: '',
  status: 'pending',
  created_at: serverTimestamp(),
});

// Same write the page does: proposal + rate-limit counter bump in one batch.
// First try "increment within the window", then "start a new window".
async function propose(db, overrides = {}, { bump = true, extraProposals = 0 } = {}) {
  const ref = doc(collection(db, 'proposals'));
  const counter = doc(db, 'counters', 'proposals');
  const commit = (reset) => {
    const batch = writeBatch(db);
    if (bump) {
      batch.update(counter, reset
        ? { count: 1, window_start: serverTimestamp(), last_id: ref.id }
        : { count: increment(1), last_id: ref.id });
    }
    batch.set(ref, { ...baseProposal(), ...overrides });
    for (let i = 0; i < extraProposals; i++) {
      batch.set(doc(collection(db, 'proposals')), { ...baseProposal(), ...overrides });
    }
    return batch.commit();
  };
  try {
    await commit(false);
  } catch (e) {
    if (e.code !== 'permission-denied' || !bump) throw e;
    await commit(true);
  }
  return ref;
}

async function setup() {
  if (EMULATOR) {
    const { initializeTestEnvironment } = await import('@firebase/rules-unit-testing');
    const env = await initializeTestEnvironment({
      projectId: 'demo-bolivia-hangouts',
      firestore: { rules: fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
    });
    await env.clearFirestore();
    const seed = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));
    await seed(async (db) => {
      await setDoc(doc(db, 'settings', 'main'), { invite_code: 'GOODCODE', trip_start: '2026-12-14', trip_end: '2027-01-02' });
      await setDoc(doc(db, 'admins', 'admin'), {});
      await setDoc(doc(db, 'blocked_slots', '2026-12-25_manana'), { date: '2026-12-25', slot: 'manana', label: 'Navidad en familia' });
      await setDoc(doc(db, 'counters', 'proposals'), { count: 0, window_start: Timestamp.now(), last_id: '' });
      await setDoc(doc(db, 'hangouts', 'h1'), { date: '2026-12-16', slot: 'noche', title: 'Open plan', place: 'Cafe', proposer_name: 'Ana', open: true, capacity: null, going: 1, full: false, created_at: Timestamp.now() });
      await setDoc(doc(db, 'hangouts', 'h1', 'participants', 'ana'), { name: 'Ana', created_at: Timestamp.now() });
      await setDoc(doc(db, 'hangouts', 'h2'), { date: '2026-12-19', slot: 'noche', title: 'SECRET private party', place: 'Somewhere', proposer_name: 'Jose', open: false, capacity: null, going: 1, full: false, created_at: Timestamp.now() });
      // Board games for 3 (Jose included): Bea is in, one place left.
      await setDoc(doc(db, 'hangouts', 'h3'), { date: '2026-12-20', slot: 'noche', title: 'Juegos de mesa', place: 'Casa de Bea', proposer_name: 'Bea', open: true, capacity: 3, going: 1, full: false, created_at: Timestamp.now() });
      await setDoc(doc(db, 'hangouts', 'h3', 'participants', 'bea'), { name: 'Bea', created_at: Timestamp.now() });
      await setDoc(doc(db, 'hangouts', 'h3', 'joined', 'bea-device'), { uid: 'bea-device', key: 'bea' });
      await setDoc(doc(db, 'hangout_places', 'h3'), { map_url: '', lat: -17.39, lng: -66.16 });
      await setDoc(doc(db, 'hangout_places', 'h1'), { map_url: 'https://maps.app.goo.gl/x', lat: null, lng: null });
      await setDoc(doc(db, 'blocked_slots', '2026-12-20_noche'), { date: '2026-12-20', slot: 'noche', label: '', kind: 'open' });
      await setDoc(doc(db, 'hangout_private', 'h1'), { note: 'SECRET note to the host', receipt: 'p-known' });
      await setDoc(doc(db, 'hangouts', 'h2', 'participants', 'eva'), { name: 'SECRET Eva', created_at: Timestamp.now() });
      await setDoc(doc(db, 'blocked_slots', '2026-12-19_noche'), { date: '2026-12-19', slot: 'noche', label: '', kind: 'busy' });
      await setDoc(doc(db, 'reservations', '2026-12-15_manana'), { date: '2026-12-15', slot: 'manana', label: 'SECRET gym', kind: 'personal', open: false });
      await setDoc(doc(db, 'blocked_slots', '2026-12-15_manana'), { date: '2026-12-15', slot: 'manana', label: '', kind: 'busy' });
      await setDoc(doc(db, 'receipts', 'p-known'), { status: 'approved' });
      await setDoc(doc(db, 'proposals', 'p1'), { date: '2026-12-17', slot: 'noche', title: 'SECRET pending', place: 'Cafe', proposer_name: 'Luis', note: '', status: 'pending', created_at: Timestamp.now() });
      await setDoc(doc(db, 'proposals', 'p2'), { date: '2026-12-17', slot: 'tarde', title: 'SECRET rejected', place: 'Cafe', proposer_name: 'Luis', note: '', status: 'rejected', created_at: Timestamp.now() });
    });
    return {
      code: 'GOODCODE',
      good: { db: env.authenticatedContext('good').firestore(), uid: 'good' },
      bad: { db: env.authenticatedContext('bad').firestore(), uid: 'bad' },
      stranger: { db: env.authenticatedContext('stranger').firestore(), uid: 'stranger' },
      other: { db: env.authenticatedContext('other').firestore(), uid: 'other' },
      admin: { db: env.authenticatedContext('admin').firestore(), uid: 'admin' },
      seed,
      cleanup: () => env.cleanup(),
    };
  }

  const code = process.env.INVITE_CODE || process.argv[2];
  if (!code) {
    console.error('Live mode needs the invite code: INVITE_CODE=xxx npm run test:live');
    process.exit(2);
  }
  const { firebaseConfig } = await import('../config.js');
  const apps = [];
  const anon = async (name) => {
    const app = initializeApp(firebaseConfig, name);
    apps.push(app);
    const cred = await signInAnonymously(getAuth(app));
    return { db: getFirestore(app), uid: cred.user.uid };
  };
  return {
    code,
    good: await anon('good'),
    bad: await anon('bad'),
    stranger: await anon('stranger'),
    cleanup: () => Promise.all(apps.map(deleteApp)),
  };
}

const ctx = await setup();
const { good, bad, stranger, code } = ctx;
console.log(`\nMode: ${EMULATOR ? 'emulator' : 'LIVE project (anonymous clients only)'}\n`);

console.log('--- A client with no invite code gets nothing');
for (const name of ['hangouts', 'blocked_slots', 'proposals', 'members', 'settings', 'admins', 'counters', 'reservations', 'receipts', 'hangout_private']) {
  await denied(`no code: list ${name}`, () => getDocs(collection(stranger.db, name)));
}
await denied('no code: read settings/main (invite code)', () => getDoc(doc(stranger.db, 'settings', 'main')));
await denied('no code: list open hangouts', () => getDocs(openHangouts(stranger.db)));
await denied('no code: read all participants', () => getDocs(collectionGroup(stranger.db, 'participants')));
await denied('no code: read a receipt', () => getDoc(doc(stranger.db, 'receipts', 'p-known')));
await denied('no code: write a hangout', () => setDoc(doc(collection(stranger.db, 'hangouts')), { title: 'x' }));
await denied('no code: propose', () => propose(stranger.db));

console.log('--- A wrong invite code fails');
await denied('wrong code: register', () => setDoc(doc(bad.db, 'members', bad.uid), { code: 'not-the-code' }));
await denied('wrong code: list open hangouts', () => getDocs(openHangouts(bad.db)));
await denied('wrong code: list blocked slots', () => getDocs(collection(bad.db, 'blocked_slots')));
await denied('wrong code: propose', () => propose(bad.db));
await denied('register under another uid', () => setDoc(doc(bad.db, 'members', good.uid), { code }));

console.log('--- A friend with the right code');
await allowed('right code: register', () => setDoc(doc(good.db, 'members', good.uid), { code }));
const hangoutsBefore = await allowed('read open hangouts', () => getDocs(openHangouts(good.db)));
await allowed('read blocked slots (the public "taken" markers)', () => getDocs(collection(good.db, 'blocked_slots')));

console.log('--- Privacy: private plans and reservation labels stay with the admin');
await denied('friend cannot list all hangouts (would include private ones)', () => getDocs(collection(good.db, 'hangouts')));
await denied('friend cannot ask for private hangouts', () => getDocs(query(collection(good.db, 'hangouts'), where('open', '==', false))));
await denied('friend cannot read all participants', () => getDocs(collectionGroup(good.db, 'participants')));
await denied('friend cannot list reservations (real labels)', () => getDocs(collection(good.db, 'reservations')));
await denied('friend cannot read one reservation', () => getDoc(doc(good.db, 'reservations', '2026-12-15_manana')));
await denied('friend cannot list receipts', () => getDocs(collection(good.db, 'receipts')));
await denied('friend cannot write a receipt', () => setDoc(doc(good.db, 'receipts', 'x'), { status: 'approved' }));
await denied('friend cannot list the private side of hangouts (notes)', () => getDocs(collection(good.db, 'hangout_private')));
await denied('friend cannot write a reservation', () => setDoc(doc(good.db, 'reservations', '2026-12-20_tarde'), { label: 'x' }));
console.log('--- A friend with the right code (continued)');
await denied('friend cannot list proposals (pending/rejected)', () => getDocs(collection(good.db, 'proposals')));
await denied('friend cannot list members', () => getDocs(collection(good.db, 'members')));
await denied('friend cannot write a hangout directly', () => setDoc(doc(collection(good.db, 'hangouts')), { ...baseProposal(), status: 'approved' }));
await denied('friend cannot add fields to their member document', () => setDoc(doc(good.db, 'members', good.uid), { code, admin: true }));
await denied('friend cannot make themselves admin', () => setDoc(doc(good.db, 'admins', good.uid), {}));
await denied('friend cannot change the invite code', () => updateDoc(doc(good.db, 'settings', 'main'), { invite_code: 'hacked' }));
await denied('friend cannot add a blocked slot', () => setDoc(doc(good.db, 'blocked_slots', '2026-12-20_tarde'), { date: '2026-12-20', slot: 'tarde', label: 'x' }));
await denied('friend cannot delete a blocked slot', () => deleteDoc(doc(good.db, 'blocked_slots', '2026-12-25_manana')));

console.log('--- Proposals are always pending and validated');
await denied('proposal with status=approved', () => propose(good.db, { status: 'approved' }));
await denied('proposal with an extra field', () => propose(good.db, { approved: true }));
await denied('proposal on a blocked slot (25 Dec, manana)', () => propose(good.db, { date: '2026-12-25', slot: 'manana' }));
await denied('proposal before the trip', () => propose(good.db, { date: '2026-12-13' }));
await denied('proposal after the trip', () => propose(good.db, { date: '2027-01-03' }));
await denied('proposal with an invalid slot', () => propose(good.db, { slot: 'madrugada' }));
await denied('proposal with an empty title', () => propose(good.db, { title: '' }));
await denied('proposal with an empty name', () => propose(good.db, { proposer_name: '' }));
await denied('proposal with a blank (spaces) name', () => propose(good.db, { proposer_name: '   ' }));
await denied('proposal with an 81-char title', () => propose(good.db, { title: 'x'.repeat(81) }));
await denied('proposal with a 281-char note', () => propose(good.db, { note: 'x'.repeat(281) }));
await denied('proposal with an 81-char place', () => propose(good.db, { place: 'x'.repeat(81) }));
await denied('proposal with a 41-char name', () => propose(good.db, { proposer_name: 'x'.repeat(41) }));
await denied('proposal with an untrimmed title', () => propose(good.db, { title: ' Café' }));
await denied('proposal with a malformed date', () => propose(good.db, { date: '2026-12-1' }));
await denied('proposal with a client-chosen timestamp', () => propose(good.db, { created_at: Timestamp.fromMillis(0) }));
await denied('proposal without the rate-limit counter', () => propose(good.db, {}, { bump: false }));
await denied('two proposals with one counter bump', () => propose(good.db, {}, { extraProposals: 1 }));
const mine = await allowed('valid proposal is accepted', () => propose(good.db));

if (mine) {
  console.log('--- A pending proposal is invisible and cannot be joined');
  await denied('proposer cannot read back their own pending proposal', () => getDoc(doc(good.db, 'proposals', mine.id)));
  await denied('proposer cannot approve it (update status)', () => updateDoc(doc(good.db, 'proposals', mine.id), { status: 'approved' }));
  await denied('proposer cannot copy it into hangouts', () => setDoc(doc(good.db, 'hangouts', mine.id), baseProposal()));
  await denied('cannot join a pending proposal', () =>
    setDoc(doc(good.db, 'hangouts', mine.id, 'participants', 'tester'), { name: 'Tester', created_at: serverTimestamp() }));
  await denied('cannot add participants under proposals/', () =>
    setDoc(doc(good.db, 'proposals', mine.id, 'participants', 'tester'), { name: 'Tester', created_at: serverTimestamp() }));
  const after = await allowed('re-read open hangouts', () => getDocs(openHangouts(good.db)));
  await allowed('proposer can fetch the receipt of their own proposal by id', () => getDoc(doc(good.db, 'receipts', mine.id)));
  if (after && hangoutsBefore) {
    const leaked = after.docs.some((d) => d.id === mine.id || d.data().open !== true || d.data().status === 'pending' || d.data().status === 'rejected');
    record(!leaked && after.size === hangoutsBefore.size, 'calendar contains no pending, rejected or private item');
  }
}

if (EMULATOR) {
  const { seed, admin } = ctx;
  console.log('--- Emulator only: seeded pending data, joins, rate limit, code rotation');
  await denied('friend cannot read a seeded pending proposal', () => getDoc(doc(good.db, 'proposals', 'p1')));
  await denied('friend cannot read a seeded rejected proposal', () => getDoc(doc(good.db, 'proposals', 'p2')));
  await denied('cannot join the seeded pending proposal', () =>
    setDoc(doc(good.db, 'hangouts', 'p1', 'participants', 'ana'), { name: 'Ana', created_at: serverTimestamp() }));
  const open = await allowed('open-hangouts query succeeds', () => getDocs(openHangouts(good.db)));
  record(!!open && open.docs.map((d) => d.id).sort().join() === 'h1,h3', 'the private hangout is absent from the result');
  await denied('a query that does not ask for full == false is refused', () =>
    getDocs(query(collection(good.db, 'hangouts'), where('open', '==', true))));
  await denied('friend cannot read the note of an open hangout', () => getDoc(doc(good.db, 'hangout_private', 'h1')));
  await denied('no code: join an open hangout', () =>
    setDoc(doc(stranger.db, 'hangouts', 'h1', 'participants', 'eve'), { name: 'Eve', created_at: serverTimestamp() }));
  await denied('friend cannot read a private hangout by id', () => getDoc(doc(good.db, 'hangouts', 'h2')));
  await denied('friend cannot read who goes to a private hangout', () => getDocs(collection(good.db, 'hangouts', 'h2', 'participants')));
  await denied('friend cannot join a private hangout', () =>
    setDoc(doc(good.db, 'hangouts', 'h2', 'participants', 'ana'), { name: 'Ana', created_at: serverTimestamp() }));
  await denied('friend cannot propose on a slot taken by a private plan', () => propose(good.db, { date: '2026-12-19', slot: 'noche' }));
  await denied('friend cannot propose on privately reserved time', () => propose(good.db, { date: '2026-12-15', slot: 'manana' }));
  const taken = await allowed('friend reads the public marker of the reserved slot', () => getDoc(doc(good.db, 'blocked_slots', '2026-12-15_manana')));
  record(!!taken && taken.data().label === '', 'the public marker carries no label');
  await allowed('friend reads who goes to an open hangout', () => getDocs(collection(good.db, 'hangouts', 'h1', 'participants')));
  const receipt = await allowed('receipt can be fetched by a known id', () => getDoc(doc(good.db, 'receipts', 'p-known')));
  record(!!receipt && receipt.data().status === 'approved', 'receipt says approved');
  const { other } = ctx;
  await allowed('a second friend registers', () => setDoc(doc(other.db, 'members', other.uid), { code }));
  await denied('join with the name alone (no joined document, no count)', () =>
    setDoc(doc(good.db, 'hangouts', 'h1', 'participants', 'maría'), { name: 'María', created_at: serverTimestamp() }));
  await allowed('join an approved hangout', () => join(good.db, good.uid, 'h1', 'María', { going: 1 }));
  await denied('the same device cannot join twice', () => join(good.db, good.uid, 'h1', 'Mari', { going: 2 }));
  await denied('same name again (different case) is rejected', () => join(other.db, other.uid, 'h1', 'MARÍA', { going: 2, key: 'maría' }));
  await denied('join with an empty name', () => join(other.db, other.uid, 'h1', ' ', { going: 2, key: ' ' }));
  await denied('join with a 41-char name', () => join(other.db, other.uid, 'h1', 'x'.repeat(41), { going: 2 }));
  await denied('join with an id that is not the lower-cased name', () => join(other.db, other.uid, 'h1', 'Pedro', { going: 2, key: 'other' }));

  console.log('--- Limits: a full plan is only for those in it');
  await denied('join without bumping the count', () => join(other.db, other.uid, 'h3', 'Gus', { going: 1, capacity: 3, bump: 0 }));
  await denied('join without a joined document', () => join(other.db, other.uid, 'h3', 'Gus', { going: 1, capacity: 3, joined: false }));
  await denied('join counting two', () => join(other.db, other.uid, 'h3', 'Gus', { going: 1, capacity: 3, bump: 2 }));
  await denied('join that fills the plan but leaves it marked not full', () =>
    join(other.db, other.uid, 'h3', 'Gus', { going: 1, capacity: 3, full: false }));
  await denied('a joined document for another device', () => {
    const batch = writeBatch(other.db);
    batch.set(doc(other.db, 'hangouts', 'h3', 'participants', 'gus'), { name: 'Gus', created_at: serverTimestamp() });
    batch.set(doc(other.db, 'hangouts', 'h3', 'joined', good.uid), { uid: good.uid, key: 'gus' });
    batch.update(doc(other.db, 'hangouts', 'h3'), { going: 2, full: true });
    return batch.commit();
  });
  await denied('claim someone else\'s place in the plan (an existing name)', () => {
    const batch = writeBatch(other.db);
    batch.set(doc(other.db, 'hangouts', 'h3', 'joined', other.uid), { uid: other.uid, key: 'bea' });
    batch.update(doc(other.db, 'hangouts', 'h3'), { going: 2, full: true });
    return batch.commit();
  });
  await denied('the place is only for those in the plan', () => getDoc(doc(other.db, 'hangout_places', 'h3')));
  await allowed('the last place: the plan is now full', () => join(other.db, other.uid, 'h3', 'Gus', { going: 1, capacity: 3 }));
  await allowed('who joined still reads the full plan', () => getDoc(doc(other.db, 'hangouts', 'h3')));
  await allowed('who joined reads who comes', () => getDocs(collection(other.db, 'hangouts', 'h3', 'participants')));
  const place = await allowed('who joined reads the place', () => getDoc(doc(other.db, 'hangout_places', 'h3')));
  record(!!place && place.data().lat === -17.39, 'the place has its pin');
  const mineJoined = await allowed('a device finds the plans it joined', () =>
    getDocs(query(collectionGroup(other.db, 'joined'), where('uid', '==', other.uid))));
  record(!!mineJoined && mineJoined.docs.map((d) => d.ref.parent.parent.id).join() === 'h3', 'and only those');
  await denied('a device cannot list who else joined', () => getDocs(collectionGroup(other.db, 'joined')));
  await denied('nor find the plans of another device', () =>
    getDocs(query(collectionGroup(other.db, 'joined'), where('uid', '==', good.uid))));
  await denied('the full plan is hidden from the rest', () => getDoc(doc(good.db, 'hangouts', 'h3')));
  await denied('and so is who comes', () => getDocs(collection(good.db, 'hangouts', 'h3', 'participants')));
  await denied('and the place', () => getDoc(doc(good.db, 'hangout_places', 'h3')));
  const withRoom = await allowed('the query for plans with room still works', () => getDocs(openHangouts(good.db)));
  record(!!withRoom && !withRoom.docs.some((d) => d.id === 'h3'), 'the full plan is not among them');
  await denied('nobody joins a full plan', () => join(good.db, good.uid, 'h3', 'Lalo', { going: 2, capacity: 3 }));
  await denied('the place of a plan you did not join', () => getDoc(doc(other.db, 'hangout_places', 'h1')));
  await allowed('the place of a plan you joined, even without a pin', () => getDoc(doc(good.db, 'hangout_places', 'h1')));

  console.log('--- Leaving a plan');
  // The page's leave: the name, this device's joined document and one less, in one batch.
  const leave = (db, uid, hangoutId, key, { going, capacity = null, joined = true, drop = 1 } = {}) => {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'hangouts', hangoutId, 'participants', key));
    if (joined) batch.delete(doc(db, 'hangouts', hangoutId, 'joined', uid));
    if (drop) batch.update(doc(db, 'hangouts', hangoutId), { going: going - drop, full: capacity != null && going - drop + 1 >= capacity });
    return batch.commit();
  };
  await denied('leave keeping the joined document', () => leave(other.db, other.uid, 'h3', 'gus', { going: 2, capacity: 3, joined: false }));
  await denied('leave without lowering the count', () => leave(other.db, other.uid, 'h3', 'gus', { going: 2, capacity: 3, drop: 0 }));
  await denied('leave counting two less', () => leave(other.db, other.uid, 'h3', 'gus', { going: 2, capacity: 3, drop: 2 }));
  await denied('take someone else off the plan', () => leave(other.db, other.uid, 'h3', 'bea', { going: 2, capacity: 3 }));
  await allowed('leave a full plan: the place is free again', () => leave(other.db, other.uid, 'h3', 'gus', { going: 2, capacity: 3 }));
  const reopened = await allowed('the plan has room again for everyone', () => getDoc(doc(good.db, 'hangouts', 'h3')));
  record(!!reopened && reopened.data().going === 1 && reopened.data().full === false, 'one going, not full');
  await denied('leave twice', () => leave(other.db, other.uid, 'h3', 'gus', { going: 1, capacity: 3 }));
  await denied('a friend Jose added (no device) cannot be taken off by others', () =>
    leave(good.db, good.uid, 'h3', 'bea', { going: 1, capacity: 3, joined: false }));

  console.log('--- Proposals with a limit and a place');
  await denied('limit of 1', () => propose(good.db, { date: '2026-12-21', capacity: 1 }));
  await denied('limit of 51', () => propose(good.db, { date: '2026-12-21', capacity: 51 }));
  await denied('limit that is not a whole number', () => propose(good.db, { date: '2026-12-21', capacity: 2.5 }));
  await denied('a javascript: link as the map', () => propose(good.db, { date: '2026-12-21', map_url: 'javascript:alert(1)' }));
  await denied('a pin out of range', () => propose(good.db, { date: '2026-12-21', lat: 100, lng: 0 }));
  await denied('another device as the proposer', () => propose(good.db, { date: '2026-12-21', uid: other.uid }));
  await allowed('a proposal with a limit, a link and a pin', () => propose(good.db, {
    date: '2026-12-21', capacity: 6, uid: good.uid, map_url: 'https://maps.app.goo.gl/x', lat: -17.39, lng: -66.16,
  }));
  await allowed('a proposal on a slot an open plan takes', () => propose(good.db, { date: '2026-12-20', slot: 'noche' }));

  console.log('--- Withdrawing a proposal');
  const waiting = await allowed('a proposal sent with its device', () => propose(good.db, { date: '2026-12-22', uid: good.uid }));
  await denied('another device cannot withdraw it', () => deleteDoc(doc(other.db, 'proposals', waiting.id)));
  await allowed('the device that sent it withdraws it', () => deleteDoc(doc(good.db, 'proposals', waiting.id)));
  if (mine) await denied('a proposal sent without its device cannot be withdrawn', () => deleteDoc(doc(good.db, 'proposals', mine.id)));
  await seed((db) => setDoc(doc(db, 'proposals', 'p-answered'), {
    date: '2026-12-23', slot: 'tarde', title: 'Answered', place: '', proposer_name: 'Tester', note: '', status: 'rejected', uid: good.uid, created_at: Timestamp.now(),
  }));
  await denied('an answered proposal cannot be withdrawn', () => deleteDoc(doc(good.db, 'proposals', 'p-answered')));
  await denied('friend cannot remove a participant', () => deleteDoc(doc(good.db, 'hangouts', 'h1', 'participants', 'maría')));
  await denied('friend cannot edit an approved hangout', () => updateDoc(doc(good.db, 'hangouts', 'h1'), { title: 'hacked' }));

  const counter = doc(good.db, 'counters', 'proposals');
  await seed((db) => setDoc(doc(db, 'counters', 'proposals'), { count: 5, window_start: Timestamp.now(), last_id: '' }));
  await denied('friend cannot restart the window while it is running', () =>
    updateDoc(counter, { count: 1, window_start: serverTimestamp(), last_id: 'x' }));
  await denied('friend cannot bump the counter by two', () => updateDoc(counter, { count: increment(2), last_id: 'x' }));
  // Known limit (README): a bump without a proposal is allowed, so anyone with
  // the link can use up the daily quota.
  await allowed('a bump alone is allowed (uses up quota)', () => updateDoc(counter, { count: increment(1), last_id: 'x' }));
  await seed((db) => setDoc(doc(db, 'counters', 'proposals'), { count: 20, window_start: Timestamp.now(), last_id: '' }));
  await denied('21st proposal in 24 h is rejected', () => propose(good.db));
  await seed((db) => setDoc(doc(db, 'counters', 'proposals'),
    { count: 20, window_start: Timestamp.fromMillis(Date.now() - 25 * 3600 * 1000), last_id: '' }));
  await allowed('proposal accepted again after the 24 h window', () => propose(good.db));

  await allowed('admin reads pending proposals', () => getDocs(collection(admin.db, 'proposals')));
  await allowed('admin approves (writes a hangout)', () =>
    setDoc(doc(admin.db, 'hangouts', 'p1'), { date: '2026-12-17', slot: 'noche', title: 'Now approved', place: 'Cafe', proposer_name: 'Luis', open: false, capacity: null, going: 0, full: false, created_at: serverTimestamp() }));
  await denied('a newly approved plan is private until the admin opens it', () => getDoc(doc(good.db, 'hangouts', 'p1')));
  await allowed('admin opens the plan', () => updateDoc(doc(admin.db, 'hangouts', 'p1'), { open: true }));
  await allowed('now the friend can read it', () => getDoc(doc(good.db, 'hangouts', 'p1')));
  await denied('admin cannot put a note on a hangout (friends could read it)', () => updateDoc(doc(admin.db, 'hangouts', 'p1'), { note: 'x' }));
  await allowed('admin keeps the note on the private side', () => setDoc(doc(admin.db, 'hangout_private', 'p1'), { note: 'x', receipt: 'p1' }));
  await denied('admin cannot publish a private marker with a telling kind', () =>
    setDoc(doc(admin.db, 'blocked_slots', '2026-12-20_tarde'), { date: '2026-12-20', slot: 'tarde', label: '', kind: 'personal' }));
  await denied('admin cannot add fields to a marker', () =>
    setDoc(doc(admin.db, 'blocked_slots', '2026-12-20_tarde'), { date: '2026-12-20', slot: 'tarde', label: '', kind: 'busy', title: 'x' }));
  await allowed('admin publishes an open-plan marker', () =>
    setDoc(doc(admin.db, 'blocked_slots', '2026-12-20_tarde'), { date: '2026-12-20', slot: 'tarde', label: '', kind: 'open' }));
  await allowed('admin publishes an anonymous marker', () =>
    setDoc(doc(admin.db, 'blocked_slots', '2026-12-20_tarde'), { date: '2026-12-20', slot: 'tarde', label: '', kind: 'busy' }));
  await allowed('admin publishes an open marker with its label', () =>
    setDoc(doc(admin.db, 'blocked_slots', '2026-12-20_tarde'), { date: '2026-12-20', slot: 'tarde', label: 'Gimnasio', kind: 'personal' }));
  await allowed('admin removes a marker', () => deleteDoc(doc(admin.db, 'blocked_slots', '2026-12-20_tarde')));
  await denied('even the admin cannot add admins from a client', () => setDoc(doc(admin.db, 'admins', 'someone'), {}));

  await allowed('admin rotates the invite code', () => updateDoc(doc(admin.db, 'settings', 'main'), { invite_code: 'NEWCODE' }));
  await denied('old code: list open hangouts after rotation', () => getDocs(openHangouts(good.db)));
  await denied('old code: propose after rotation', () => propose(good.db));
  await denied('old code: re-register with the old code', () => setDoc(doc(good.db, 'members', good.uid), { code: 'GOODCODE' }));
  await allowed('new code: register again', () => setDoc(doc(good.db, 'members', good.uid), { code: 'NEWCODE' }));
  await allowed('new code: list open hangouts', () => getDocs(openHangouts(good.db)));
}

await ctx.cleanup();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (!EMULATOR) console.log('Note: delete the pending "[TEST] security script" proposal in admin.html.');
process.exit(failed ? 1 : 0);
