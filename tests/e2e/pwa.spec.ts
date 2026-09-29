import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'allow' });

const iphoneSafari =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const contentTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
let server: Server;
let baseUrl: string;
let workerRevision = 0;

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!pathname.startsWith('/seed-gallery/')) {
      response.writeHead(404).end();
      return;
    }
    const relative = pathname.slice('/seed-gallery/'.length) || 'index.html';
    if (relative.includes('..')) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(join(process.cwd(), 'dist', relative));
      response.setHeader(
        'Content-Type',
        contentTypes[extname(relative)] ?? 'application/octet-stream',
      );
      response.setHeader('Cache-Control', 'no-store');
      response.end(
        relative === 'sw.js'
          ? body
              .toString()
              .replace(/seed-gallery-shell-[a-f0-9]+/, (name) => `${name}-test-${workerRevision}`)
          : body,
      );
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  baseUrl = `http://127.0.0.1:${address.port}/seed-gallery/`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test('subpath install, offline saved work and explicit update keep local data', async ({
  page,
  context,
}) => {
  await page.goto(baseUrl);
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
    const url = new URL(link.href);
    return { path: url.pathname, data: await (await fetch(url)).json() };
  });
  expect(manifest.path).toBe('/seed-gallery/manifest.webmanifest');
  expect(new URL(manifest.data.start_url, `${baseUrl}manifest.webmanifest`).pathname).toBe(
    '/seed-gallery/',
  );
  expect(new URL(manifest.data.scope, `${baseUrl}manifest.webmanifest`).pathname).toBe(
    '/seed-gallery/',
  );
  expect(manifest.data.display).toBe('standalone');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  await page.getByRole('button', { name: '稍後設定 API Key' }).click();
  const tour = page.getByRole('dialog', { name: '首頁導覽' });
  if (await tour.isVisible()) await tour.getByRole('button', { name: '知道了' }).click();
  await page.getByRole('button', { name: /製作圖片/ }).click();
  await page.getByLabel('描述你的想法').fill('離線保存測試作品');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('img-generator');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const request = database.transaction('works').objectStore('works').getAll();
        return new Promise<boolean>((resolve) => {
          request.onsuccess = () =>
            resolve(request.result.some((work) => work.draft.prompt === '離線保存測試作品'));
        });
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const image = atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    );
    const bytes = Uint8Array.from(image, (character) => character.charCodeAt(0)).buffer;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('img-generator');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['works', 'media'], 'readwrite');
    const works = transaction.objectStore('works');
    const work = await new Promise<any>((resolve) => {
      const request = works.getAll();
      request.onsuccess = () => resolve(request.result[0]);
    });
    work.draft.refs = ['offline-media'];
    works.put(work);
    transaction
      .objectStore('media')
      .put({ id: 'offline-media', bytes, type: 'image/png', name: 'saved.png' });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  });
  await page.evaluate(() => localStorage.setItem('img-generator.key', 'local-test-only'));
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('目前離線。')).toBeVisible();
  await page.getByLabel('種子畫廊首頁').click();
  await page.getByRole('button', { name: /我的作品/ }).click();
  await expect(page.locator('.saved-work')).toContainText('離線保存測試作品');
  await expect
    .poll(() =>
      page.locator('.saved-work img').evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('img-generator.key'))).toBe(
    'local-test-only',
  );
  await context.setOffline(false);
  workerRevision += 1;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
  await expect(page.getByText('新版本已準備好。', { exact: false })).toBeVisible();
  await page.locator('.saved-work .work-open').click();
  await expect(page.getByRole('button', { name: '更新並重新開啟' })).toHaveCount(0);
  await page.getByLabel('種子畫廊首頁').click();
  const otherTab = await context.newPage();
  await otherTab.goto(baseUrl);
  await page.getByRole('button', { name: '更新並重新開啟' }).click();
  await expect(page.getByText('請先關閉其他已開啟的種子畫廊頁面')).toBeVisible();
  await otherTab.close();
  await page.getByRole('button', { name: '更新並重新開啟' }).click();
  await page.getByRole('button', { name: /我的作品/ }).click();
  await expect(page.locator('.saved-work')).toContainText('離線保存測試作品');
  expect(await page.evaluate(() => localStorage.getItem('img-generator.key'))).toBe(
    'local-test-only',
  );
  expect(
    await page.evaluate(async () =>
      (await caches.keys()).filter((name) => name.startsWith('seed-gallery-shell-')),
    ),
  ).toHaveLength(1);
});

test('install controls and iOS transfer guidance', async ({ page, browser }) => {
  await page.goto(baseUrl);
  await page.getByRole('button', { name: '稍後設定 API Key' }).click();
  const tour = page.getByRole('dialog', { name: '首頁導覽' });
  if (await tour.isVisible()) await tour.getByRole('button', { name: '知道了' }).click();
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: 'accepted' }>;
    };
    event.prompt = async () => {
      document.body.dataset.installPrompted = 'yes';
    };
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(event);
  });
  await page.getByRole('button', { name: '安裝 App' }).click();
  expect(await page.locator('body').getAttribute('data-install-prompted')).toBe('yes');

  const safari = await browser.newContext({
    userAgent: iphoneSafari,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const browserPage = await safari.newPage();
    await browserPage.goto(baseUrl);
    await browserPage.getByRole('button', { name: '稍後設定 API Key' }).click();
    const safariTour = browserPage.getByRole('dialog', { name: '首頁導覽' });
    if (await safariTour.isVisible())
      await safariTour.getByRole('button', { name: '知道了' }).click();
    await browserPage.getByRole('button', { name: '查看加入步驟' }).click();
    await expect(
      browserPage.getByText('iOS 主畫面 App 的資料與 Safari 分開保存。', { exact: false }),
    ).toBeVisible();
    await expect(browserPage.getByRole('button', { name: '匯出備份' })).toBeVisible();
  } finally {
    await safari.close();
  }

  const installed = await browser.newContext({
    userAgent: iphoneSafari,
    isMobile: true,
    hasTouch: true,
  });
  try {
    await installed.addInitScript(() =>
      Object.defineProperty(navigator, 'standalone', { value: true }),
    );
    const installedPage = await installed.newPage();
    await installedPage.goto(baseUrl);
    await expect(installedPage.getByRole('button', { name: '查看加入步驟' })).toHaveCount(0);
    await installedPage.getByRole('button', { name: '還原 Safari 匯出的備份' }).click();
    await expect(installedPage.getByRole('dialog', { name: '設定' })).toBeVisible();
    await expect(installedPage.getByRole('button', { name: '匯出備份' })).toBeVisible();
    await expect(installedPage.getByLabel('還原備份')).toBeAttached();
  } finally {
    await installed.close();
  }
});
