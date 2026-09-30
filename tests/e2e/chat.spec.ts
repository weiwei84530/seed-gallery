import { test, expect, chromium, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import type { Route } from '@playwright/test';
type Request = {
  model: string;
  messages: { role: string; content: string | { type: string; text?: string }[] }[];
  inputs?: { images: string[] };
  taskUUID?: string;
  taskType: string;
  tools?: { type: string }[];
};
async function setup(page: Page, hidden = false) {
  const requests: Request[] = [];
  await page.route('https://api.runware.ai/**', async (route) => {
    const body = route.request().postDataJSON();
    const raw = (Array.isArray(body) ? body[0] : body) as Request & { input?: Request['messages'] };
    const task: Request = raw.input ? { ...raw, taskType: 'responses', messages: raw.input } : raw;
    if (task.taskType === 'authentication') return route.fulfill({ json: { data: [] } });
    if (task.taskType === 'accountManagement')
      return route.fulfill({ json: { data: [{ balance: 12.34 }] } });
    requests.push(task);
    const answer = `Answer from ${task.model}\n\n${'A useful response. '.repeat(60)}\nLAST LINE`;
    const event =
      task.taskType === 'responses'
        ? {
            type: 'response.completed',
            response: {
              model: task.model,
              status: 'completed',
              usage: { cost: 0.001 },
              output: [
                ...(task.tools?.some((tool) => tool.type === 'web_search')
                  ? [{ type: 'web_search_call', status: 'completed' }]
                  : []),
                { type: 'message', content: [{ type: 'output_text', text: answer }] },
              ],
            },
          }
        : task.taskType
          ? {
              taskUUID: task.model.includes('haiku') ? '' : task.taskUUID,
              taskType: task.taskType,
              delta: { text: answer },
              finishReason: 'stop',
              cost: 0.001,
            }
          : { choices: [{ delta: { content: answer }, finish_reason: 'stop' }] };
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
    });
  });
  await page.goto(hidden ? '/?costs=hidden' : '/');
  await page.getByLabel('Runware API Key', { exact: true }).fill('test-key-never-real');
  await page.getByRole('button', { name: '連線，開始創作' }).click();
  await page
    .getByRole('dialog', { name: '首頁導覽' })
    .getByRole('button', { name: '知道了' })
    .click();
  await page.getByRole('button', { name: /聊天問答/ }).click();
  await expect(page.locator('.chat-model-option.selected')).toHaveCount(2);
  return requests;
}
async function send(page: Page, text: string) {
  await page.getByLabel('輸入聊天訊息').fill(text);
  await page.getByLabel('送出給所有 AI').click();
  await expect(page.getByRole('button', { name: '全部停止', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('輸入聊天訊息')).toHaveValue('');
}

test('two equal panels, isolated history, expand, fork, edit and responsive composer', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests = await setup(page, true);
  await expect(page.locator('.chat-model-option')).toHaveCount(5);
  await expect(page.locator('.chat-preview')).toHaveCount(0);
  await send(page, 'First question');
  await expect(page.locator('.chat-preview')).toHaveCount(2);
  for (const width of [320, 390, 1200]) {
    await page.setViewportSize({ width, height: 844 });
    const boxes = await page.locator('.chat-preview').evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { height: box.height, width: box.width, y: box.y };
      }),
    );
    expect(
      Math.max(...boxes.map((box) => box.height)) - Math.min(...boxes.map((box) => box.height)),
    ).toBeLessThan(2);
    const shell = (await page.locator('.chat-shell').boundingBox())!;
    expect(shell.width).toBe(Math.min(width, 600));
    expect(shell.x).toBe((width - shell.width) / 2);
    const composer = (await page.locator('.chat-composer').boundingBox())!;
    expect(composer.y + composer.height).toBeLessThanOrEqual(845);
    expect(composer.y + composer.height).toBeGreaterThanOrEqual(843);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: info.outputPath(`chat-${width}.png`) });
  }
  await expect(page.locator('.chat-preview').first()).toContainText('LAST LINE');
  await expect.poll(() => requests.length).toBe(2);
  await page.screenshot({ path: info.outputPath('chat-answers.png') });
  await page.getByLabel('放大 GPT-6 Sol').click();
  await expect(page.locator('.chat-expanded .chat-transcript')).toContainText(
    'Answer from openai:',
  );
  await expect(page.locator('.chat-workspace')).not.toContainText('US$');
  await send(page, 'Follow up');
  await expect.poll(() => requests.length).toBe(4);
  for (const request of requests.slice(2)) {
    expect(request.messages[1].content).toContain(request.model);
    expect(request.messages).toHaveLength(3);
  }
  await expect(page.locator('.chat-expanded')).toHaveCount(0);
  await page.getByLabel('放大 GPT-6 Sol').click();
  await page.getByRole('button', { name: '從這裡開新對話', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '建立新對話', exact: true }).click();
  await expect(page.locator('.chat-preview')).toHaveCount(2);
  expect(requests).toHaveLength(4);
  await page.getByLabel('放大 GPT-6 Sol').click();
  await expect(page.locator('.chat-expanded .chat-transcript')).toContainText('First question');
  await expect(page.locator('.chat-expanded .chat-transcript')).not.toContainText('Follow up');
  await send(page, 'Branch question');
  await expect.poll(() => requests.length).toBe(6);
  for (const request of requests.slice(4))
    expect(request.messages[1].content).toContain('openai:gpt');
  await page.getByLabel('放大 GPT-6 Sol').click();
  await page.getByRole('button', { name: '修改並建立分支' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '建立新對話', exact: true }).click();
  await expect(page.getByLabel('輸入聊天訊息')).toHaveValue('Branch question');
  expect(requests).toHaveLength(6);
  await page.reload();
  await expect(page.getByLabel('輸入聊天訊息')).toHaveValue('Branch question');
  expect(errors).toEqual([]);
});

test('streaming permits drafting, waits for all models, preserves partial failures, and retries versions safely', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const original = window.fetch;
    const state = window as unknown as { finishChat: () => void };
    const streams: {
      task: { taskUUID?: string; model: string; taskType?: string; input?: unknown };
      controller: ReadableStreamDefaultController<Uint8Array>;
    }[] = [];
    window.fetch = async (input, init) => {
      const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : [];
      const task = Array.isArray(payload) ? payload[0] : payload;
      if (task?.taskType !== 'textInference' && !task?.input && !task?.messages)
        return original(input, init);
      return new Response(
        new ReadableStream({
          start(controller) {
            streams.push({ task, controller });
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(
                  task.input
                    ? { type: 'response.output_text.delta', delta: `Partial ${task.model}` }
                    : task.taskType === 'textInference'
                      ? {
                          taskUUID: task.taskUUID,
                          taskType: 'textInference',
                          delta: { text: `Partial ${task.model}` },
                        }
                      : { choices: [{ delta: { content: `Partial ${task.model}` } }] },
                )}\n\n`,
              ),
            );
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    state.finishChat = () => {
      window.fetch = original;
      for (const { task, controller } of streams) {
        if (task.model.startsWith('google')) continue;
        const event = task.input
          ? {
              type: 'response.failed',
              response: {
                model: task.model,
                status: 'failed',
                error: { code: 'streamingError' },
                output: [],
              },
            }
          : { errors: [{ code: 'streamingError' }] };
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`),
        );
        controller.close();
      }
    };
  });
  await page.getByLabel('輸入聊天訊息').fill('Streaming question');
  await page.getByLabel('送出給所有 AI').click();
  await expect(page.locator('.chat-preview').first()).toContainText('Partial');
  await page.getByLabel('輸入聊天訊息').fill('Next draft');
  await expect(page.getByLabel('送出給所有 AI')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { finishChat: () => void }).finishChat());
  await expect(page.getByRole('button', { name: '全部停止', exact: true })).toBeVisible();
  await page.getByLabel('放大 Gemini 3.8 Flash').click();
  await page.getByRole('button', { name: '停止此 AI', exact: true }).click();
  await expect(page.getByLabel('送出給所有 AI')).toBeVisible();
  await expect(page.getByLabel('輸入聊天訊息')).toHaveValue('Next draft');
  await expect(page.locator('.chat-expanded .chat-transcript')).toContainText('Partial google');
  await page.getByLabel('縮回 Gemini 3.8 Flash').click();
  await page.getByLabel('放大 GPT-6 Sol').click();
  await expect(page.locator('.chat-expanded .chat-inline-error')).toBeVisible();
  await page.getByRole('button', { name: '重新回答', exact: true }).click();
  await expect(page.locator('.chat-expanded .chat-versions')).toContainText('2 / 2');
  await page.getByLabel('上一個回答版本').click();
  await expect(page.locator('.chat-expanded .chat-transcript')).toContainText('Partial openai');
  await page.getByLabel('下一個回答版本').click();
  await send(page, 'After retry');
  await page.getByLabel('放大 GPT-6 Sol').click();
  await page.getByLabel('上一個回答版本').click();
  await expect(page.locator('.chat-expanded .chat-turn').first()).toContainText('Partial openai');
  await page.reload();
  await page.getByLabel('放大 GPT-6 Sol').click();
  await expect(page.locator('.chat-expanded .chat-turn').first()).toContainText(
    'Answer from openai',
  );
});

test('scanned PDF, DOCX table, original downloads and removal never submit', async ({
  page,
  browser,
}) => {
  const requests = await setup(page);
  const printerBrowser =
    browser.browserType().name() === 'chromium' ? browser : await chromium.launch();
  const printer = await printerBrowser.newPage();
  const image = await printer.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 300;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white';
    context.fillRect(0, 0, 600, 300);
    context.fillStyle = 'black';
    context.font = '40px sans-serif';
    context.fillText('SCAN CHART', 40, 60);
    context.fillStyle = 'green';
    context.fillRect(60, 100, 80, 100);
    context.fillStyle = 'blue';
    context.fillRect(180, 100, 80, 150);
    return canvas.toDataURL('image/png');
  });
  await printer.setContent(`<img src="${image}">`);
  const pdf = await printer.pdf();
  await printer.close();
  if (printerBrowser !== browser) await printerBrowser.close();
  await page
    .getByLabel('加入聊天附件')
    .setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: pdf });
  await expect(page.locator('.chat-composer .chat-attachment')).toHaveCount(1);
  await expect(page.getByLabel('加入聊天附件')).toBeEnabled();
  await page.getByLabel('輸入聊天訊息').fill('Describe the chart');
  const download = page.waitForEvent('download');
  await page.locator('.chat-composer').getByTitle('下載原始附件').click();
  expect((await download).suggestedFilename()).toBe('scan.pdf');
  expect(requests).toHaveLength(0);
  await page.getByLabel('送出給所有 AI').click();
  await expect.poll(() => requests.length).toBe(2);
  expect(
    requests.every((request) => {
      const content = request.messages.find((message) => message.role === 'user')?.content;
      return (
        Array.isArray(content) &&
        content.filter((part) => part.type === 'image_url' || part.type === 'input_image')
          .length === 1
      );
    }),
  ).toBe(true);
  const docx = zipSync({
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/document.xml': strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word note</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    ),
  });
  await page.getByLabel('加入聊天附件').setInputFiles({
    name: 'table.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(docx),
  });
  await expect(page.locator('.chat-composer .chat-attachment')).toHaveCount(1);
  await expect(page.getByLabel('加入聊天附件')).toBeEnabled();
  await send(page, 'Read the table');
  await expect.poll(() => requests.length).toBe(4);
  const lastContent = requests[2].messages.at(-1)!.content;
  expect(
    typeof lastContent === 'string' ? lastContent : lastContent.map((part) => part.text).join(''),
  ).toContain('Cell A | Cell B');
  expect(
    Array.isArray(requests[2].messages.find((message) => message.role === 'user')?.content),
  ).toBe(true);
  await page
    .getByLabel('加入聊天附件')
    .setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('Saved note') });
  await expect(page.locator('.chat-composer .chat-attachment')).toHaveCount(1);
  await expect(page.getByLabel('加入聊天附件')).toBeEnabled();
  await page.getByLabel('輸入聊天訊息').fill('Do not send');
  await page.getByLabel('移除 note.txt').click();
  await expect(page.locator('.chat-composer .chat-attachment')).toHaveCount(0);
  expect(requests).toHaveLength(4);
});

test('only GPT-6 Sol offers search in new conversations', async ({ page }) => {
  const requests = await setup(page);
  await expect(page.locator('.chat-model-option')).toHaveCount(5);
  await expect(
    page.locator('.chat-model-option').filter({ hasText: '可查詢網路資料' }),
  ).toHaveCount(1);
  await page.locator('.chat-model-option').filter({ hasText: 'Gemini 3.8 Flash' }).click();
  await page.getByRole('button', { name: '搜尋網路', exact: true }).click();
  await expect(page.getByRole('button', { name: '搜尋網路', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await send(page, 'Hello');
  await expect(page.locator('.chat-expanded .chat-transcript')).toContainText(
    'Answer from openai:gpt@6-sol',
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].tools).toEqual([{ type: 'web_search' }]);
});

test('selects three new models and sends the first question directly', async ({ page }) => {
  const requests = await setup(page);
  await page.locator('.chat-model-option.selected').first().click();
  await page.locator('.chat-model-option.selected').first().click();
  for (const name of ['MiniMax M3', 'DeepSeek V4.1 Flash', 'Claude Opus 5.5']) {
    await page.locator('.chat-model-option').filter({ hasText: name }).click();
  }
  await expect(page.locator('.chat-model-option.selected')).toHaveCount(3);
  await expect(page.locator('.chat-model-option.selected img')).toHaveCount(3);
  await send(page, 'Compare your answers');
  await expect(page.locator('.chat-preview')).toHaveCount(3);
  await expect.poll(() => requests.length).toBe(3);
  expect(requests.map((request) => request.model).sort()).toEqual([
    'anthropic:claude@opus-5.5',
    'deepseek:v4.1@flash',
    'minimax:m3@0',
  ]);
});

test('compact picker, independent scroll positions, fixed composer and six-line input', async ({
  page,
}, info) => {
  await setup(page);
  await expect(page.locator('.chat-model-price')).toHaveCount(5);
  for (const width of [320, 390, 1200]) {
    await page.setViewportSize({ width, height: 844 });
    const option = (await page.locator('.chat-model-option').first().boundingBox())!;
    expect(option.height).toBeGreaterThanOrEqual(88);
    expect(option.width).toBeLessThanOrEqual(460);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: info.outputPath(`picker-${width}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.chat-model-option').filter({ hasText: 'MiniMax M3' }).click();
  await send(page, 'Scroll test');
  const cards = page.locator('.chat-preview:visible');
  await expect(cards).toHaveCount(3);
  await expect(cards.first().locator('.chat-preview-footer')).toContainText('0.001');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const feed = cards.first().locator('.chat-transcript');
  await feed.evaluate((node) => {
    node.scrollTop = 25;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => feed.evaluate((node) => node.scrollTop)).toBe(25);
  const composer = await page.locator('.chat-composer').boundingBox();
  await page.getByLabel('放大 GPT-6 Sol').click();
  await expect(page.locator('.chat-card:visible')).toHaveCount(1);
  expect((await page.locator('.chat-composer').boundingBox())!.y).toBe(composer!.y);
  await page.locator('.chat-expanded .chat-transcript').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await page.getByLabel('縮回 GPT-6 Sol').click();
  await expect.poll(() => feed.evaluate((node) => node.scrollTop)).toBe(25);
  await expect(cards.first().getByText('你', { exact: true })).toHaveCount(0);
  await expect(cards.first().getByRole('button', { name: '複製', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('three-cards.png') });
  const input = page.getByLabel('輸入聊天訊息');
  const shortHeight = (await input.boundingBox())!.height;
  await input.fill('A line\n'.repeat(4));
  expect((await input.boundingBox())!.height).toBeGreaterThan(shortHeight);
  await input.fill('A line\n'.repeat(12));
  expect((await input.boundingBox())!.height).toBeLessThanOrEqual(164);
  expect(await input.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await input.fill('Short again');
  expect((await input.boundingBox())!.height).toBe(shortHeight);
  await page.getByLabel('放大 GPT-6 Sol').click();
  await page.screenshot({ path: info.outputPath('expanded-card.png') });
  await send(page, 'Send from expanded');
  await expect(page.locator('.chat-preview:visible')).toHaveCount(3);
  await page.getByLabel('展開歷史對話').click();
  await page.screenshot({ path: info.outputPath('sidebar.png'), animations: 'disabled' });
  for (const width of [390, 1200]) {
    await page.setViewportSize({ width, height: 844 });
    const sidebar = (await page.locator('.chat-sidebar').boundingBox())!;
    const shell = (await page.locator('.chat-shell').boundingBox())!;
    const header = (await page.locator('.topbar').boundingBox())!;
    expect(sidebar.x).toBe(shell.x);
    expect(sidebar.y).toBeCloseTo(header.y + header.height, 0);
    await page.screenshot({
      path: info.outputPath(`sidebar-${width}.png`),
      animations: 'disabled',
    });
  }
  await page.locator('.chat-sidebar').getByLabel('收起歷史對話').click();
  await page.setViewportSize({ width: 390, height: 450 });
  await input.fill('Keyboard line\n'.repeat(12));
  expect((await input.boundingBox())!.height).toBeLessThanOrEqual(92);
  const shortComposer = (await page.locator('.chat-composer').boundingBox())!;
  expect(shortComposer.y + shortComposer.height).toBeLessThanOrEqual(450);
  await expect(page.getByLabel('送出給所有 AI')).toBeVisible();
  const shortCards = await cards.evaluateAll((nodes) =>
    nodes.map((node) => ({
      top: node.getBoundingClientRect().top,
      bottom: node.getBoundingClientRect().bottom,
    })),
  );
  expect(shortCards[1].top).toBeGreaterThanOrEqual(shortCards[0].bottom);
  expect(shortCards[2].top).toBeGreaterThanOrEqual(shortCards[1].bottom);
  await page.screenshot({ path: info.outputPath('short-viewport.png') });
});

test('system prompt applies on next send in existing chats and prices follow the display preference', async ({
  page,
}) => {
  const requests = await setup(page, true);
  await expect(page.locator('.chat-model-price')).toHaveCount(0);
  await send(page, 'Before preferences');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByText('聊天偏好', { exact: true }).click();
  await page
    .getByLabel('系統提示詞', { exact: true })
    .fill('Use short Traditional Chinese answers.');
  await page.getByText('顯示偏好', { exact: true }).click();
  await page.getByRole('switch', { name: /顯示餘額與費用/ }).check();
  await page.getByRole('dialog').getByRole('button', { name: '關閉', exact: true }).click();
  await send(page, 'After preferences');
  for (const request of requests.slice(2)) {
    expect(request.messages[0]).toEqual({
      role: 'system',
      content: 'Use short Traditional Chinese answers.',
    });
  }
  await page.reload();
  await page.locator('.chat-toolbar').getByRole('button', { name: '新對話', exact: true }).click();
  await expect(page.locator('.chat-model-price')).toHaveCount(5);
  await send(page, 'Persisted preferences');
  for (const request of requests.slice(4))
    expect(request.messages[0].content).toBe('Use short Traditional Chinese answers.');
});

test('legacy models retain their identity and Claude accepts the provider empty UUID', async ({
  page,
}) => {
  const requests = await setup(page);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('img-generator');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('chats', 'readwrite');
        tx.objectStore('chats').add({
          id: crypto.randomUUID(),
          title: 'Legacy conversation',
          models: ['gpt', 'gemini', 'claude'],
          createdAt: 1,
          updatedAt: 1,
          seed: [],
          turns: [],
          draft: '',
          draftAttachments: [],
          search: false,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  });
  await page.reload();
  await page.getByLabel('展開歷史對話').click();
  await page
    .locator('.chat-history-item > button')
    .filter({ hasText: 'Legacy conversation' })
    .click();
  await expect(page.locator('.chat-legacy-note')).toBeVisible();
  await expect(page.locator('.chat-preview')).toHaveCount(3);
  await send(page, 'Hello again');
  await expect.poll(() => requests.length).toBe(3);
  expect(requests.map((r) => r.model).sort()).toEqual([
    'anthropic:claude@haiku-4.5',
    'google:gemini@3.1-flash-lite',
    'openai:gpt@5.4-mini',
  ]);
  await page.getByLabel('放大 Claude Haiku 4.5').click();
  await expect(page.locator('.chat-expanded .chat-transcript')).toContainText(
    'Answer from anthropic',
  );
  await expect(page.locator('.chat-inline-error')).toHaveCount(0);
  await page.getByRole('button', { name: '從這裡開新對話', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.chat-model-option')).toHaveCount(5);
  await page.getByRole('dialog').getByRole('button', { name: '建立新對話', exact: true }).click();
  await expect(page.locator('.chat-preview')).toHaveCount(2);
  await expect(page.locator('.chat-legacy-note')).toHaveCount(0);
  expect(requests).toHaveLength(3);
});

test('another tab observes the active lock and recovers after the streaming tab closes without replay', async ({
  page,
  context,
}) => {
  await setup(page);
  const pending: Route[] = [];
  await page.route('https://api.runware.ai/**', async (route) => {
    const payload = route.request().postDataJSON();
    const task = Array.isArray(payload) ? payload[0] : payload;
    if (task.taskType === 'textInference' || task.input || task.messages) {
      pending.push(route);
      return;
    }
    await route.fallback();
  });
  await page.getByLabel('輸入聊天訊息').fill('Keep this question');
  await page.getByLabel('送出給所有 AI').click();
  await expect.poll(() => pending.length).toBe(2);
  const second = await context.newPage();
  let replayed = 0;
  await second.route('https://api.runware.ai/**', async (route) => {
    const body = route.request().postDataJSON();
    const task = Array.isArray(body) ? body[0] : body;
    if (!['authentication', 'accountManagement'].includes(task.taskType)) replayed++;
    await route.fulfill({ json: { data: [{ balance: 12.34 }] } });
  });
  await second.goto('/');
  await second.getByRole('button', { name: /聊天問答/ }).click();
  await second.getByLabel('展開歷史對話').click();
  await second.locator('.chat-history-item > button').first().click();
  await expect(second.getByRole('button', { name: '全部停止', exact: true })).toBeVisible();
  await expect(second.getByLabel('送出給所有 AI')).toHaveCount(0);
  await page.close();
  await second.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(second.getByLabel('送出給所有 AI')).toBeVisible();
  await expect(second.locator('.chat-preview').first()).toContainText('連線已中斷');
  await second.reload();
  await expect(second.locator('.chat-preview').first()).toContainText('連線已中斷');
  expect(replayed).toBe(0);
});
