# bolivia-hangouts

A small shared calendar for a short visit home. You send one private link to
your friends; they propose hangouts without creating an account. **Nothing is
visible to anyone until you approve it, and what you approve stays private
unless you mark it open**: friends see that a slot is taken, not what you are
doing or with whom.

Built for a trip to Cochabamba, Bolivia (14 Dec 2026 – 2 Jan 2027). The UI is in
Spanish. The code is generic enough to reuse for your own trip.

- Static HTML/CSS/vanilla JavaScript. No build step, no framework. `lib.js`
  holds the pure logic (dates, text, what friends may see, the `.ics` file),
  `common.js` the Firebase setup and DOM helpers, `index.js` and `admin.js`
  the two pages.
- Hosted on GitHub Pages (any static host works).
- Firebase on the free Spark plan: Firestore, Security Rules, and Auth.

## How it works

Each day of the trip has four slots (`manana`, `almuerzo`, `tarde`, `noche`).
A hangout is stored as a **date string plus a slot**, never a timestamp, so time
zones cannot shift anything. Slot times are Bolivia time (`America/La_Paz`) and
are used only for display and for the `.ics` export.

| Page | Who | What |
|---|---|---|
| `index.html?c=CODE` | Friends | The trip as a timetable, one week (at most 7 days) on screen, the other weeks a swipe away: a row per day, a column per slot. A friend sees free slots, slots that are taken ("Ocupado"), the plans you marked open, and their own proposals. Tap a free slot to propose a plan, tap an open plan to join it. The name is asked for once, in the first form that needs it. |
| `admin.html` | The host | Google sign-in. The same timetable with pending proposals and clashes marked. Tap a slot to approve, reject or edit what is in it, manage who is coming, switch an item between private and open, or reserve the slot for yourself (for example the gym on weekday mornings, in one step) and choose who sees it. Below it: the queue to confirm, who you spend the most time with, your reservations, the invite link and code rotation, and the `.ics` export. |

### Limits and places

- **How many people.** A plan can have a limit: the size of the whole
  gathering, Jose included (a board-game night for 6 is Jose and 5 friends).
  The proposer sets it, and Jose can set or change it. While a plan has room,
  friends who are not in it see it outlined with a "+" and the places left.
  Once it is full, everyone who is not in it sees a plain "Ocupado", exactly
  like a private plan; the people in it still see it as theirs.
- **Where.** A plan can carry a place: paste a link from Google Maps, Apple
  Maps or OpenStreetMap (or "lat, lng") and the pin drops on its own, or tap
  the map and drag the pin. Short share links (`maps.app.goo.gl/...`) carry
  no coordinates, so the form keeps the link and asks for a tap on the map.
  The map is [Leaflet](https://leafletjs.com) with OpenStreetMap tiles, and
  has buttons to open the pin in Google Maps or Apple Maps. Only Jose and the
  people in the plan see the pin and the links; everyone else sees at most
  the place name.

## Design

Six colors, each with one job: alabaster is the page, obsidian the ink, mahogany
a confirmed plan, slate the host's own time, pewter time that is not available,
bronze a proposal that waits for confirmation. One typeface, [Bricolage
Grotesque](https://github.com/ateliertriay/bricolage) (SIL Open Font License,
self-hosted in `fonts/`, no request to a font service): condensed in the
timetable cells and the title, regular width for reading. Light and dark follow
the system setting.

## Loading

- The pages use Firestore Lite: plain HTTPS requests, no streaming channel.
  With the full SDK the first load took several seconds longer. An import map
  in each page maps `firebase/app`, `firebase/auth` and
  `firebase/firestore/lite` to the CDN, so the Firebase version is written
  only in the two HTML files.
- The friends' page asks for the settings, the taken slots, the open plans,
  the plans this device joined and its own receipts at the same time; only
  the names of who is coming and the places wait for the plans.
- Leaflet (from jsDelivr) and the map tiles load only when a map is shown.
- The friends' page keeps the last timetable it loaded in the browser and
  shows it at once on the next visit, then replaces it with fresh data. The
  copy holds only what that friend was allowed to read.
- A device that already registered the invite code skips that write.
- While the scripts load, one of three small animated animals (a blue
  lobster, a frog, an owl) is picked at random. They are SVG drawn by
  `critters.js`, a small plain script that runs before the modules arrive,
  with CSS animation; they stand still when the system asks for reduced
  motion. Their eyes keep their colors in light and dark.
- A wrong address gets `404.html` (GitHub Pages serves it at any depth): an
  animal, a link, and after 10 seconds a redirect to the calendar, or to the
  panel when the address mentions "admin". The query string goes along, so
  an invite code in the link still works.

## Security model

The repository is public; the data and the link are not. All enforcement is in
[`firestore.rules`](firestore.rules). The page only ever holds the public
Firebase web config.

- **Invite code.** A friend's browser signs in anonymously (no prompt, no
  account) and writes the code from the link to `members/{uid}`. The rules
  refuse that write unless the code equals `settings/main.invite_code`. Every
  read then checks that the registered code is still the current one, so
  rotating the code locks out every old link at once.
- **Pending is invisible.** Proposals go to the `proposals` collection. Friends
  can create documents there but can never read them, not even their own.
  Approving a proposal means the admin copies it into `hangouts`, under a new
  id. There is no status field a client could flip.
- **The note stays with the host.** A friend who may read a hangout reads all
  of its fields, so a hangout never holds the note to the host. The note lives
  in `hangout_private`, which only the admin can read; the rules refuse a
  hangout with a `note` field.
- **Private unless opened.** Every hangout has an `open` flag, false by
  default. The rules let a friend read a hangout, and the names of who is
  coming, only when `open == true`; a query that does not ask for
  `open == true` is refused outright. The host's own reservations (gym, work)
  live in `reservations`, which only the admin can read.
- **What friends get instead.** `blocked_slots` is a public projection with one
  document per taken slot. It carries a label and a kind only for items the
  host opened; anything private is `{ label: '', kind: 'busy' }`, so a friend
  cannot tell a private plan from private time, and the page shows "Ocupado".
  The rules refuse any other shape. The admin page writes the projection in
  the same batch as each change, so it never disagrees with the private data,
  and repairs it on every load. A taken slot also refuses new proposals.
- **Receipts.** `receipts/{proposalId}` holds the answer ("pending" after an
  edit, "approved" or "rejected") and the plan's current date, slot and title,
  so the proposer follows the host's edits. It can be fetched only by id, and
  only the device that sent the proposal knows the id: an approved hangout
  gets a new id, so the ids friends see on open plans never open a receipt.
  That is how a proposer sees their own plan as confirmed while everyone else
  sees "Ocupado". The device keeps its proposals until they are rejected, or
  until their day passes without an answer.
- **Validated writes.** A proposal must have exactly the expected fields,
  `status == 'pending'`, a server timestamp, a valid slot, a date inside the
  trip, trimmed text within the length limits, and a slot that is not blocked.
- **Joining.** A participant document can be created only under an open
  hangout. Its id is the lower-cased name, so a name is unique per
  hangout. In the same batch the friend's device writes
  `hangouts/{id}/joined/{uid}` and raises the plan's `going` count by exactly
  one; the rules refuse a join past the limit and require `full` to follow
  from the new count. Approving a proposal writes the proposer's `joined`
  document too.
- **Full plans.** Friends may read a hangout only if it is open and either
  not full or joined by their own device, and their query must ask for
  `open == true` and `full == false`. A device finds the full plans it is in
  with a collection-group query on `joined` that must ask for its own uid.
  The public marker of an open plan is `{ label: '', kind: 'open' }`: a slot
  that holds one still takes proposals.
- **Places.** `hangout_places/{id}` (`map_url`, `lat`, `lng`) is readable by
  the admin and by the devices that joined the plan. A stored link must be
  `http(s)://`, and a pin must be in range.
- **Rate limit.** At most 20 proposals per 24-hour window across all friends;
  the window starts with the first proposal after the previous one ended.
  Each proposal must bump `counters/proposals` in the same batch, and the rules
  tie the bump to that proposal's id. The form also has a hidden honeypot field.
- **Admin.** A signed-in user whose uid is a document id in `admins`. No client
  can write to `admins`, not even the admin; you add yourself once in the
  Firebase console.

Known limits: the honeypot is client-side only; anyone who has the link can
see which slots are taken, read the open plans, and use up the daily proposal
quota; names are self-declared; a proposer who clears their browser data
no longer sees their own private plan (they see "Ocupado" like everyone else);
and plans approved before receipts carried the plan's details (schema 2) share
their id with their receipt, so their receipt only ever says "approved" and
their proposer does not see later edits. Being in a plan is tied to a
device: on another phone, or for someone Jose added by hand, a full plan
shows "Ocupado" (with no limit nothing changes). The link is meant for people you trust. Ask friends not to post
exact addresses.

## Self-hosting

1. Create a Firebase project. Create a Firestore database in production mode.
2. In Authentication, enable the **Anonymous** and **Google** providers, and add
   your site's domain (for example `yourname.github.io`) to the authorized
   domains.
3. Add a web app in the project settings and paste its config into
   [`config.js`](config.js). Put your project id in `.firebaserc`.
4. Deploy the rules:
   ```
   npm install
   npx firebase login
   npm run deploy:firestore
   ```
5. Publish the repository root with GitHub Pages (or any static host).
6. Open `admin.html` and sign in with Google. The page shows your uid. In the
   Firebase console, create the collection `admins` with one empty document
   whose id is that uid. Reload.
7. Click **Inicializar**. This creates the invite code, the trip dates, the
   rate-limit counter and the initial blocked slots (edit `TRIP` and
   `SEED_BLOCKS` in [`admin.js`](admin.js) first for your own trip).
8. Copy the friends' link from the admin page and send it.

To run the pages locally: `npm run serve`, then open `http://localhost:5500`.

## Tests

```
npm test                                # unit tests of lib.js (no emulator, no browser)
npm run test:rules                      # full rules suite in the Firestore emulator
INVITE_CODE=xxx npm run test:live       # same checks against the live project
```

The live run uses only the public config and anonymous sign-in, exactly like a
friend's browser, and proves that direct reads and writes fail, a wrong code
fails, pending proposals never come back, a proposal cannot be created as
approved, a pending proposal cannot be joined, and private plans, their
participants and reservation labels cannot be read. It leaves one pending
`[TEST]` proposal for you to delete.

The emulator needs Java 21 or newer with current `firebase-tools`; with Java
11–17 use `npm run test:rules:java17` and `npm run test:e2e:java17`. On
Windows the older `firebase-tools` can leave the Firestore emulator running
after a run (the next one fails with "port taken"); end the `java` process
that listens on port 8080.

Browser tests use `playwright-core` with the Edge or Chrome already on your
machine (`npm i --no-save playwright-core`):

```
npm run test:e2e                        # both pages against the Firestore + Auth emulators
node tests/smoke.mjs https://your.site  # start screens of a deployed site
INVITE_CODE=xxx node tests/timing.mjs https://your.site   # time to timetable
```

The end-to-end run covers admin setup, a proposal, a private approval (other
friends see only "Ocupado"), opening it, joining, the people summary, reserving
time privately and then opening it, the `.ics` export, edits the proposer
follows, opening and closing a plan again, participants, reject, reconsider and
delete, the honeypot, removing reservations, a plan with a limit and a place
(pasted link, joinable look, full for the rest, map links, a short link and a
tap on the map), the upgrade of older data, the 404 page and invite-code
rotation. The pages run on a fixed date before the trip, so the
result does not depend on the day it runs. For local work,
`http://localhost:5500/?emulator` points the pages at the emulators.

## License

MIT. See [LICENSE](LICENSE). The font in `fonts/` has its own license,
[`fonts/OFL.txt`](fonts/OFL.txt).
