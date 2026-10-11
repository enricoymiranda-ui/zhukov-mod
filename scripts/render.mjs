#!/usr/bin/env node
// Usage: node render.mjs <file.html> <outdir> [--video] [--size WxH]
// Writes frames at 0/2.5/5/7.5/9.9 s (frame-<t>.png), errors.txt, and with --video a 10 s loop.mp4.
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--size');
const [file, outdir] = positional;
if (!file || !outdir) {
  console.error('usage: render.mjs <file.html> <outdir> [--video] [--size WxH]');
  process.exit(2);
}
const [W, H] = (val('--size') || '960x540').split('x').map(Number);
const video = flag('--video');

function loadPlaywright() {
  const bases = [process.env.PW_PATH, process.cwd(), '/opt/node-tools'].filter(Boolean);
  for (const b of bases) {
    for (const p of [join(b, 'package.json'), join(b, 'node_modules', 'x.js'), join(b, 'x.js')]) {
      try { return createRequire(p)('playwright'); } catch {}
    }
  }
  console.error('playwright not found (tried $PW_PATH, cwd, /opt/node-tools)');
  process.exit(3);
}

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
}

const { chromium } = loadPlaywright();
const out = resolve(outdir);
mkdirSync(out, { recursive: true });
const errors = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  ...(video ? { recordVideo: { dir: out, size: { width: W, height: H } } } : {}),
});
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(pathToFileURL(resolve(file)).href);
const start = Date.now();
for (const t of [0, 2.5, 5, 7.5, 9.9]) {
  const wait = t * 1000 - (Date.now() - start);
  if (wait > 0) await page.waitForTimeout(wait);
  await page.screenshot({ path: join(out, `frame-${t}s.png`) });
}
const overflow = await page.evaluate(() => ({
  x: document.documentElement.scrollWidth > innerWidth,
  y: document.documentElement.scrollHeight > innerHeight,
}));
if (overflow.x) errors.push(`layout: horizontal overflow at ${W}x${H}`);
if (overflow.y) errors.push(`layout: vertical overflow at ${W}x${H}`);

await ctx.close();
await browser.close();

if (video) {
  const webm = readdirSync(out).find((f) => f.endsWith('.webm'));
  if (webm) {
    const r = spawnSync('ffmpeg', ['-y', '-i', join(out, webm), '-t', '10', '-pix_fmt', 'yuv420p', join(out, 'loop.mp4')], { stdio: 'ignore' });
    if (r.status !== 0) errors.push('ffmpeg: failed to convert video');
  } else errors.push('video: no webm recorded');
}

writeFileSync(join(out, 'errors.txt'), errors.length ? errors.join('\n') + '\n' : '(no errors)\n');
console.log(`wrote ${out} (${errors.length} error(s))`);
