# bolivia-hangouts

A small shared calendar for a short visit home. You send one private link to
your friends; they propose hangouts or join existing ones without creating an
account, and **nothing is visible to anyone until you approve it**.

Built for a trip to Cochabamba, Bolivia (14 Dec 2026 – 2 Jan 2027). The UI is in
Spanish. The code is generic enough to reuse for your own trip.

- Static HTML/CSS/vanilla JavaScript. No build step, no framework.
- Hosted on GitHub Pages (any static host works).
- Firebase on the free Spark plan: Firestore, Security Rules, and Auth.

## How it works

Each day of the trip has four slots (`manana`, `almuerzo`, `tarde`, `noche`).
A hangout is stored as a **date string plus a slot**, never a timestamp, so time
zones cannot shift anything. Slot times are Bolivia time (`America/La_Paz`) and
are used only for display and for the `.ics` export.

| Page | Who | What |
|---|---|---|
| `index.html?c=CODE` | Friends | A trip overview (one cell per day, one bar per slot), day cards with filters, a countdown, and counts of confirmed plans and free slots. Propose a plan on a free slot, join a confirmed one, share the link on WhatsApp. |
| `admin.html` | The host | Google sign-in. The same overview with pending and conflict marks; tap a day to see it and act on it. Approve, reject or edit proposals, manage confirmed hangouts and participants, see who you spend the most time with, reserve time for yourself (for example the gym on weekday mornings) or block slots, rotate the invite code, export `.ics`. |

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
  Friends can read only `hangouts` and `blocked_slots` (blocks and the host's
  own reserved time, with the label the host chose), and only the admin can
  write to them.
  Approving a proposal means the admin copies it into `hangouts`. There is no
  status field a client could flip.
- **Validated writes.** A proposal must have exactly the expected fields,
  `status == 'pending'`, a server timestamp, a valid slot, a date inside the
  trip, trimmed text within the length limits, and a slot that is not blocked.
- **Joining.** A participant document can be created only under an existing
  (approved) hangout. Its id is the lower-cased name, so a name is unique per
  hangout.
- **Rate limit.** At most 20 proposals per rolling 24 hours across all friends.
  Each proposal must bump `counters/proposals` in the same batch, and the rules
  tie the bump to that proposal's id. The form also has a hidden honeypot field.
- **Admin.** A signed-in user whose uid is a document id in `admins`. No client
  can write to `admins`, not even the admin; you add yourself once in the
  Firebase console.

Known limits: the honeypot is client-side only; anyone who has the link can
read the approved calendar and use up the daily proposal quota; and names are
self-declared. The link is meant for people you trust. Ask friends not to post
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
   npm run deploy:rules
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
npm run test:rules                      # full rules suite in the Firestore emulator
INVITE_CODE=xxx npm run test:live       # same checks against the live project
```

The live run uses only the public config and anonymous sign-in, exactly like a
friend's browser, and proves that direct reads and writes fail, a wrong code
fails, pending proposals never come back, a proposal cannot be created as
approved, and a pending proposal cannot be joined. It leaves one pending
`[TEST]` proposal for you to delete.

The emulator needs Java 21 or newer with current `firebase-tools`; with Java
11–17 use `npm run test:rules:java17` and `npm run test:e2e:java17`.

Browser tests use `playwright-core` with the Edge or Chrome already on your
machine (`npm i --no-save playwright-core`):

```
npm run test:e2e                        # both pages against the Firestore + Auth emulators
node tests/smoke.mjs https://your.site  # start screens of a deployed site
```

The end-to-end run covers admin setup, a proposal, approval, joining, the
people summary, reserving time, the `.ics` export and invite-code rotation. For
local work, `http://localhost:5500/?emulator` points the pages at the emulators.

## License

MIT. See [LICENSE](LICENSE).
