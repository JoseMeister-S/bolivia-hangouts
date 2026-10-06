// Measures how long the friends' page takes to show the timetable.
//
//   INVITE_CODE=xxx node tests/timing.mjs https://your.site
//
// "first visit" is a fresh browser profile (new anonymous sign-in, nothing
// cached); "return visit" reloads in the same profile. Read-only.
import { chromium } from 'playwright-core';

const base = (process.argv[2] || 'http://localhost:5500').replace(/\/$/, '');
const code = process.env.INVITE_CODE;
if (!code) { console.error('Set INVITE_CODE'); process.exit(2); }
const RUNS = 3;
const url = `${base}/?c=${encodeURIComponent(code)}`;
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
const FRESH = '#calendar[aria-busy="false"]';
const first = [];
const shown = [];
const again = [];
for (let i = 0; i < RUNS; i++) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  let t = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForSelector(FRESH, { timeout: 30000 });
  first.push(Date.now() - t);
  // Let the page finish its background refresh, so the return visit starts clean.
  await page.waitForTimeout(2500);
  t = Date.now();
  await page.reload({ waitUntil: 'commit' });
  await page.waitForSelector('.tt-row[id^="d-"]', { timeout: 30000 });
  shown.push(Date.now() - t);          // timetable on screen (saved copy)
  await page.waitForSelector(FRESH, { timeout: 30000 });
  again.push(Date.now() - t);          // and refreshed with current data
  await context.close();
}
await browser.close();
console.log(`first visit : ${first.join(', ')} ms (median ${median(first)})`);
console.log(`return visit, timetable on screen: ${shown.join(', ')} ms (median ${median(shown)})`);
console.log(`return visit, data refreshed    : ${again.join(', ')} ms (median ${median(again)})`);
