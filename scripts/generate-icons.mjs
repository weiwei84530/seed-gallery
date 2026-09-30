import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const publicDirectory = new URL('../public/', import.meta.url);
const source = await readFile(new URL('favicon.svg', publicDirectory), 'utf8');
const definitions = source.match(/<defs>[\s\S]*?<\/defs>/)[0];
const artwork = source.match(/<g fill="url\(#gold\)"[^>]*>([\s\S]*?)<\/g>/)[1];

// Installed icons use an opaque square so the OS can apply its own icon mask.
function installedIcon(maskable) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
    ${definitions}
    <rect width="300" height="300" fill="url(#background)"/>
    <g fill="url(#gold)"${maskable ? ' transform="translate(30 30) scale(0.8)"' : ''}>${artwork}</g>
  </svg>`;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, size, svg] of [
    ['icon-192.png', 192, source],
    ['icon-512.png', 512, source],
    ['apple-touch-icon.png', 180, installedIcon(false)],
    ['icon-maskable-512.png', 512, installedIcon(true)],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`);
    await page.screenshot({ path: fileURLToPath(new URL(name, publicDirectory)), omitBackground: true });
    console.log(`Generated ${name} (${size} x ${size})`);
  }
} finally {
  await browser.close();
}
