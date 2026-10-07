import { test, expect, type Page } from '@playwright/test';

async function mockService(page: Page, reject = false) {
  const authentications: string[] = [];
  await page.route('https://api.runware.ai/v1', async (route) => {
    const [task] = route.request().postDataJSON();
    if (task.taskType === 'authentication') authentications.push(task.apiKey);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        task.taskType === 'authentication'
          ? reject
            ? { errors: [{ code: 'invalidApiKey' }] }
            : { data: [] }
          : { data: [{ balance: 12.34 }] },
      ),
    });
  });
  return authentications;
}

test('key link authenticates once, removes credentials and remembers the device', async ({
  page,
}) => {
  const calls = await mockService(page);
  await page.goto('/?costs=hidden#key=fake-link-key');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('img-generator.key')))
    .toBe('fake-link-key');
  expect(new URL(page.url()).hash).toBe('');
  expect(new URL(page.url()).search).toBe('?costs=hidden');
  expect(calls).toEqual(['fake-link-key']);
  await expect(page.getByLabel('重新查詢餘額')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: '設定服務', exact: true })).toHaveCount(0);
  expect(calls).toHaveLength(1);
});

test('different saved key requires confirmation and can be kept', async ({ page }) => {
  const calls = await mockService(page);
  await page.addInitScript(() => localStorage.setItem('img-generator.key', 'fake-original-key'));
  await page.goto('/#key=fake-link-key');
  await expect(page.getByRole('heading', { name: '更換服務 Key？' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(calls).toEqual([]);
  await page.getByRole('button', { name: '保留原本的 Key' }).click();
  expect(await page.evaluate(() => localStorage.getItem('img-generator.key'))).toBe(
    'fake-original-key',
  );
  expect(calls).toEqual([]);
});

test('confirmed replacement is validated before saving', async ({ page }) => {
  const calls = await mockService(page);
  await page.addInitScript(() => localStorage.setItem('img-generator.key', 'fake-original-key'));
  await page.goto('/#key=fake-link-key');
  await page.getByRole('button', { name: '更換 Key', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('img-generator.key')))
    .toBe('fake-link-key');
  expect(calls).toEqual(['fake-link-key']);
});

test('failed replacement preserves the saved key and allows retry without pasting', async ({
  page,
}) => {
  const calls = await mockService(page, true);
  await page.addInitScript(() => localStorage.setItem('img-generator.key', 'fake-original-key'));
  await page.goto('/#key=fake-link-key');
  await page.getByRole('button', { name: '更換 Key', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('無法完成設定');
  await expect(page.getByLabel('Runware API Key', { exact: true })).toHaveValue('fake-link-key');
  expect(await page.evaluate(() => localStorage.getItem('img-generator.key'))).toBe(
    'fake-original-key',
  );
  expect(new URL(page.url()).hash).toBe('');
  await mockService(page);
  await page.getByRole('button', { name: '驗證並更換 Key' }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('img-generator.key')))
    .toBe('fake-link-key');
  expect(calls).toHaveLength(1);
});

test('same saved key proceeds automatically and unrelated fragments stay unchanged', async ({
  page,
}) => {
  await mockService(page);
  await page.addInitScript(() => localStorage.setItem('img-generator.key', 'fake-link-key'));
  await page.goto('/#key=fake-link-key&section=help');
  await expect(page.getByRole('heading', { name: '更換服務 Key？' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '正在確認服務' })).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('#section=help');
});
