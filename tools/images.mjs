// Renders the images the pages link to, from their sources in the repo:
//   images/favicon.svg        -> images/favicon-32.png, images/apple-touch-icon.png
//   tools/social-card.html    -> images/social-card.png (the link preview card)
//
//   npm i --no-save playwright-core
//   npm run images
//
// Uses the Edge or Chrome on this machine (BROWSER_CHANNEL=chrome for Chrome).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../tests/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...parts) => path.join(root, ...parts);
const browser = await launch();

// The icon at a given size. The touch icon is square: iOS rounds it itself.
async function icon(size, file, { square = false } = {}) {
  let svg = fs.readFileSync(at('images', 'favicon.svg'), 'utf8');
  if (square) svg = svg.replace(/<rect([^>]*) rx="[\d.]+"/, '<rect$1');
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: at('images', file), omitBackground: true });
  await page.close();
}

await icon(32, 'favicon-32.png');
await icon(180, 'apple-touch-icon.png', { square: true });

const card = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await card.goto(pathToFileURL(at('tools', 'social-card.html')).href);
await card.evaluate(() => document.fonts.ready);
await card.screenshot({ path: at('images', 'social-card.png') });

await browser.close();
for (const file of ['favicon-32.png', 'apple-touch-icon.png', 'social-card.png']) {
  console.log(`images/${file}  ${(fs.statSync(at('images', file)).size / 1024).toFixed(1)} KB`);
}
