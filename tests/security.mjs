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

// What the friends' page asks for: only hangouts the admin marked open.
const openHangouts = (db) => query(collection(db, 'hangouts'), where('open', '==', true));

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
      await setDoc(doc(db, 'hangouts', 'h1'), { date: '2026-12-16', slot: 'noche', title: 'Open plan', place: 'Cafe', proposer_name: 'Ana', note: '', open: true, created_at: Timestamp.now() });
      await setDoc(doc(db, 'hangouts', 'h1', 'participants', 'ana'), { name: 'Ana', created_at: Timestamp.now() });
      await setDoc(doc(db, 'hangouts', 'h2'), { date: '2026-12-19', slot: 'noche', title: 'SECRET private party', place: 'Somewhere', proposer_name: 'Jose', note: '', open: false, created_at: Timestamp.now() });
      await setDoc(doc(db, 'hangouts', 'h2', 'participants', 'eva'), { name: 'SECRET Eva', created_at: Timestamp.now() });
      await setDoc(doc(db, 'blocked_slots', '2026-12-19_noche'), { date: '2026-12-19', slot: 'noche', label: '', kind: 'busy' });
      await setDoc(doc(db, 'reservations', '2026-12-15_manana'), { date: '2026-12-15', slot: 'manana', label: 'SECRET gym', kind: 'personal', open: false });
      await setDoc(doc(db, 'blocked_slots', '2026-12-15_manana'), { date: '2026-12-15', slot: 'manana', label: '', kind: 'personal' });
      await setDoc(doc(db, 'receipts', 'p-known'), { status: 'approved' });
      await setDoc(doc(db, 'proposals', 'p1'), { date: '2026-12-17', slot: 'noche', title: 'SECRET pending', place: 'Cafe', proposer_name: 'Luis', note: '', status: 'pending', created_at: Timestamp.now() });
      await setDoc(doc(db, 'proposals', 'p2'), { date: '2026-12-17', slot: 'tarde', title: 'SECRET rejected', place: 'Cafe', proposer_name: 'Luis', note: '', status: 'rejected', created_at: Timestamp.now() });
    });
    return {
      code: 'GOODCODE',
      good: { db: env.authenticatedContext('good').firestore(), uid: 'good' },
      bad: { db: env.authenticatedContext('bad').firestore(), uid: 'bad' },
      stranger: { db: env.authenticatedContext('stranger').firestore(), uid: 'stranger' },
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
for (const name of ['hangouts', 'blocked_slots', 'proposals', 'members', 'settings', 'admins', 'counters', 'reservations', 'receipts']) {
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
await denied('friend cannot write a reservation', () => setDoc(doc(good.db, 'reservations', '2026-12-20_tarde'), { label: 'x' }));
console.log('--- A friend with the right code (continued)');
await denied('friend cannot list proposals (pending/rejected)', () => getDocs(collection(good.db, 'proposals')));
await denied('friend cannot list members', () => getDocs(collection(good.db, 'members')));
await denied('friend cannot write a hangout directly', () => setDoc(doc(collection(good.db, 'hangouts')), { ...baseProposal(), status: 'approved' }));
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
  record(!!open && open.size === 1 && open.docs[0].id === 'h1', 'the private hangout is absent from the result');
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
  await allowed('join an approved hangout', () =>
    setDoc(doc(good.db, 'hangouts', 'h1', 'participants', 'maría'), { name: 'María', created_at: serverTimestamp() }));
  await denied('same name again (different case) is rejected', () =>
    setDoc(doc(good.db, 'hangouts', 'h1', 'participants', 'maría'), { name: 'MARÍA', created_at: serverTimestamp() }));
  await denied('join with an empty name', () =>
    setDoc(doc(good.db, 'hangouts', 'h1', 'participants', ''.padEnd(1, ' ')), { name: ' ', created_at: serverTimestamp() }));
  await denied('join with a 41-char name', () =>
    setDoc(doc(good.db, 'hangouts', 'h1', 'participants', 'x'.repeat(41)), { name: 'x'.repeat(41), created_at: serverTimestamp() }));
  await denied('join with an id that is not the lower-cased name', () =>
    setDoc(doc(good.db, 'hangouts', 'h1', 'participants', 'other'), { name: 'Pedro', created_at: serverTimestamp() }));
  await denied('friend cannot remove a participant', () => deleteDoc(doc(good.db, 'hangouts', 'h1', 'participants', 'maría')));
  await denied('friend cannot edit an approved hangout', () => updateDoc(doc(good.db, 'hangouts', 'h1'), { title: 'hacked' }));

  await seed((db) => setDoc(doc(db, 'counters', 'proposals'), { count: 20, window_start: Timestamp.now(), last_id: '' }));
  await denied('21st proposal in 24 h is rejected', () => propose(good.db));
  await seed((db) => setDoc(doc(db, 'counters', 'proposals'),
    { count: 20, window_start: Timestamp.fromMillis(Date.now() - 25 * 3600 * 1000), last_id: '' }));
  await allowed('proposal accepted again after the 24 h window', () => propose(good.db));

  await allowed('admin reads pending proposals', () => getDocs(collection(admin.db, 'proposals')));
  await allowed('admin approves (writes a hangout)', () =>
    setDoc(doc(admin.db, 'hangouts', 'p1'), { date: '2026-12-17', slot: 'noche', title: 'Now approved', place: 'Cafe', proposer_name: 'Luis', note: '', open: false, created_at: serverTimestamp() }));
  await denied('a newly approved plan is private until the admin opens it', () => getDoc(doc(good.db, 'hangouts', 'p1')));
  await allowed('admin opens the plan', () => updateDoc(doc(admin.db, 'hangouts', 'p1'), { open: true }));
  await allowed('now the friend can read it', () => getDoc(doc(good.db, 'hangouts', 'p1')));
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
