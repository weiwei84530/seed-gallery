import { test, expect, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import type { Route } from '@playwright/test';

type Request = {
  model: string;
  messages: { role: string; content: string | { type: string; text?: string }[] }[];
  inputs?: { images: string[] };
  taskUUID: string;
  taskType: string;
  tools?: unknown[];
};
async function setup(page: Page, hidden = false) {
  const requests: Request[] = [];
  await page.route('https://api.runware.ai/**', async (route) => {
    const body = route.request().postDataJSON();
    const task = (Array.isArray(body) ? body[0] : body) as Request;
    if (task.taskType === 'authentication') return route.fulfill({ json: { data: [] } });
    if (task.taskType === 'accountManagement')
      return route.fulfill({ json: { data: [{ balance: 12.34 }] } });
    requests.push(task);
    const answer = `Answer from ${task.model}\n\n${'A useful response. '.repeat(60)}\nLAST LINE`;
    const event = task.taskType
      ? {
          taskUUID: task.taskUUID,
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
  await expect(page.locator('.chat-model-option.selected')).toHaveCount(3);
  return requests;
}
async function send(page: Page, text: string) {
  await page.getByLabel('輸入聊天訊息').fill(text);
  await page.getByLabel('送出給所有 AI').click();
  await expect(page.getByRole('button', { name: '全部停止', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('輸入聊天訊息')).toHaveValue('');
}

test('three equal panels, isolated history, expand, fork, edit and responsive composer', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests = await setup(page, true);
  await expect(page.locator('.chat-model-option').last()).toBeDisabled();
  await page.getByRole('button', { name: '開始對話 · 3 個 AI' }).click();
  await expect(page.locator('.chat-preview')).toHaveCount(3);
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
    expect(shell.width).toBe(width);
    const composer = (await page.locator('.chat-composer').boundingBox())!;
    expect(composer.y + composer.height).toBeLessThanOrEqual(845);
    expect(composer.y + composer.height).toBeGreaterThanOrEqual(843);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: info.outputPath(`chat-${width}.png`) });
  }
  await send(page, 'First question');
  await expect(page.locator('.chat-preview').first()).toContainText('LAST LINE');
  await expect.poll(() => requests.length).toBe(3);
  await page.screenshot({ path: info.outputPath('chat-answers.png') });
  await page.getByLabel('放大 GPT-5.4 Mini').click();
  await expect(page.locator('.chat-transcript')).toContainText('Answer from openai:');
  await expect(page.locator('.chat-workspace')).not.toContainText('US$');
  await send(page, 'Follow up');
  await expect.poll(() => requests.length).toBe(6);
  for (const request of requests.slice(3)) {
    expect(request.messages[1].content).toContain(request.model);
    expect(request.messages).toHaveLength(3);
  }
  await page.getByRole('button', { name: '從這裡開新對話', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '建立新對話', exact: true }).click();
  await expect(page.locator('.chat-preview')).toHaveCount(3);
  expect(requests).toHaveLength(6);
  await page.getByLabel('放大 GPT-5.4 Mini').click();
  await expect(page.locator('.chat-transcript')).toContainText('First question');
  await expect(page.locator('.chat-transcript')).not.toContainText('Follow up');
  await send(page, 'Branch question');
  await expect.poll(() => requests.length).toBe(9);
  for (const request of requests.slice(6))
    expect(request.messages[1].content).toContain('openai:gpt');
  await page.getByRole('button', { name: '修改並建立分支' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '建立新對話', exact: true }).click();
  await expect(page.getByLabel('輸入聊天訊息')).toHaveValue('Branch question');
  expect(requests).toHaveLength(9);
  await page.reload();
  await expect(page.getByLabel('輸入聊天訊息')).toHaveValue('Branch question');
  expect(errors).toEqual([]);
});

test('streaming permits drafting, waits for all models, preserves partial failures, and retries versions safely', async ({
  page,
}) => {
  await setup(page);
  await page.getByRole('button', { name: '開始對話 · 3 個 AI' }).click();
  await page.evaluate(() => {
    const original = window.fetch;
    const state = window as unknown as { finishChat: () => void };
    const streams: {
      task: { taskUUID: string; model: string };
      controller: ReadableStreamDefaultController<Uint8Array>;
    }[] = [];
    window.fetch = async (input, init) => {
      const tasks = typeof init?.body === 'string' ? JSON.parse(init.body) : [];
      const task = tasks[0];
      if (task?.taskType !== 'textInference') return original(input, init);
      return new Response(
        new ReadableStream({
          start(controller) {
            streams.push({ task, controller });
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ taskUUID: task.taskUUID, taskType: 'textInference', delta: { text: `Partial ${task.model}` } })}\n\n`,
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
        const event = task.model.startsWith('anthropic')
          ? { errors: [{ code: 'streamingError' }] }
          : {
              taskUUID: task.taskUUID,
              taskType: 'textInference',
              delta: {},
              finishReason: 'stop',
              cost: 0.002,
            };
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
  await page.getByLabel('放大 Gemini 3.1 Flash Lite').click();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByLabel('送出給所有 AI')).toBeVisible();
  await expect(page.getByLabel('輸入聊天訊息')).toHaveValue('Next draft');
  await expect(page.locator('.chat-transcript')).toContainText('Partial google');
  await page.getByLabel('切換放大的 AI').selectOption('claude');
  await expect(page.locator('.chat-inline-error')).toBeVisible();
  await page.getByRole('button', { name: '重新回答', exact: true }).click();
  await expect(page.locator('.chat-versions')).toContainText('2 / 2');
  await page.getByLabel('上一個回答版本').click();
  await expect(page.locator('.chat-transcript')).toContainText('Partial anthropic');
  await page.getByLabel('下一個回答版本').click();
  await send(page, 'After retry');
  await page.getByLabel('上一個回答版本').click();
  await expect(page.locator('.chat-turn').first()).toContainText('Partial anthropic');
  await page.reload();
  await page.getByLabel('放大 Claude Haiku 4.5').click();
  await expect(page.locator('.chat-turn').first()).toContainText('Answer from anthropic');
});

test('scanned PDF, DOCX table, original downloads and removal never submit', async ({
  page,
  browser,
}) => {
  const requests = await setup(page);
  await page.getByRole('button', { name: '開始對話 · 3 個 AI' }).click();
  const printer = await browser.newPage();
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
  await expect.poll(() => requests.length).toBe(3);
  expect(
    requests.every(
      (request) =>
        Array.isArray(request.messages[0].content) &&
        request.messages[0].content.filter((part) => part.type === 'image_url').length === 1,
    ),
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
  await expect.poll(() => requests.length).toBe(6);
  expect(requests[3].messages.at(-1)!.content).toContain('Cell A | Cell B');
  expect(Array.isArray(requests[3].messages[0].content)).toBe(true);
  await page
    .getByLabel('加入聊天附件')
    .setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('Saved note') });
  await expect(page.locator('.chat-composer .chat-attachment')).toHaveCount(1);
  await expect(page.getByLabel('加入聊天附件')).toBeEnabled();
  await page.getByLabel('輸入聊天訊息').fill('Do not send');
  await page.getByLabel('移除 note.txt').click();
  await expect(page.locator('.chat-composer .chat-attachment')).toHaveCount(0);
  expect(requests).toHaveLength(6);
});

test('Runware compatibility model works in browser and unsupported search is blocked', async ({
  page,
}) => {
  const requests = await setup(page);
  for (const name of ['GPT-5.4 Mini', 'Gemini 3.1 Flash Lite', 'Claude Haiku 4.5'])
    await page.locator('.chat-model-option').filter({ hasText: name }).click();
  await page.locator('.chat-model-option').filter({ hasText: 'GLM-5.3 Flash' }).click();
  await page.getByRole('button', { name: '開始對話 · 1 個 AI' }).click();
  await page.getByRole('button', { name: '搜尋', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('不支援搜尋');
  await expect(page.getByRole('button', { name: '搜尋', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await send(page, 'Hello');
  await expect(page.locator('.chat-transcript')).toContainText('Answer from zai:glm');
  expect(requests).toHaveLength(1);
});

test('another tab observes the active lock and recovers after the streaming tab closes without replay', async ({
  page,
  context,
}) => {
  await setup(page);
  await page.getByRole('button', { name: '開始對話 · 3 個 AI' }).click();
  const pending: Route[] = [];
  await page.route('https://api.runware.ai/v1', async (route) => {
    const [task] = route.request().postDataJSON();
    if (task.taskType === 'textInference') {
      pending.push(route);
      return;
    }
    await route.fallback();
  });
  await page.getByLabel('輸入聊天訊息').fill('Keep this question');
  await page.getByLabel('送出給所有 AI').click();
  await expect.poll(() => pending.length).toBe(3);
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
  await expect(second.locator('.chat-preview').first()).toContainText('連線中斷');
  await second.reload();
  await expect(second.locator('.chat-preview').first()).toContainText('連線中斷');
  expect(replayed).toBe(0);
});
