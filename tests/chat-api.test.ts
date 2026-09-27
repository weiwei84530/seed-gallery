import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatHistoryMessage } from '../src/chat-types';

vi.mock('../src/db', () => ({ getMedia: vi.fn() }));
vi.mock('../src/runware', () => ({
  ApiError: class extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
  blobDataUri: vi.fn(async () => 'data:image/png;base64,AAAA'),
}));

import { getMedia } from '../src/db';
import {
  buildChatRequest,
  compatibilityRequest,
  providerSources,
  streamChat,
} from '../src/chat-api';
import { validateChatRequest } from '../src/chat-models';

const user = (
  content: string,
  attachments?: ChatHistoryMessage['attachments'],
): ChatHistoryMessage => ({ role: 'user', content, attachments });
const attachment = (imageIds: string[], text?: string) => ({
  id: 'a',
  name: 'note.png',
  type: 'image/png',
  size: 10,
  text,
  imageIds,
});

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

describe('chat request validation', () => {
  it('rejects unsupported search and excessive attachments without dropping history', () => {
    expect(validateChatRequest(['claude'], [user('Hi')], true)).toMatch(/搜尋/);
    expect(validateChatRequest(['glm'], [user('Look', [attachment(['x'])])], false)).toBeNull();
    expect(
      validateChatRequest(['gpt'], [user('Look', [attachment(Array(21).fill('x'))])], false),
    ).toMatch(/20/);
    expect(validateChatRequest(['gpt'], [user('x'.repeat(120001))], false)).toMatch(/12 萬/);
  });

  it('binds multiple image turns explicitly and builds per-message compatibility content', async () => {
    vi.mocked(getMedia).mockResolvedValue({
      id: 'x',
      name: 'note.png',
      blob: new Blob(['x'], { type: 'image/png' }),
    });
    const messages = [
      user('First', [attachment(['x'])]),
      { role: 'assistant' as const, content: 'A note' },
      user('Second', [attachment(['y'])]),
      user('Compare'),
    ];
    const task = await buildChatRequest('gpt', messages, false, 'id');
    expect(task.settings.systemPrompt).toContain('Images 1-1 belong to message 1');
    expect(task.settings.systemPrompt).toContain('Images 2-2 belong to message 3');
    const request = compatibilityRequest(task, messages);
    expect(request.messages[0].content).toHaveLength(2);
    expect(request.messages[1].content).toBe('A note');
    expect(request.messages[2].content).toHaveLength(2);
    expect(request.messages[3].content).toBe('Compare');
  });

  it('keeps file text and image turn association', async () => {
    vi.mocked(getMedia).mockResolvedValue({
      id: 'x',
      name: 'note.png',
      blob: new Blob(['x'], { type: 'image/png' }),
    });
    const request = await buildChatRequest(
      'gpt',
      [
        user('What is this?', [attachment(['x'], 'Caption text')]),
        { role: 'assistant', content: 'A note.' },
        user('Explain it'),
      ],
      false,
      'id',
    );
    expect(request.inputs?.images).toEqual(['data:image/png;base64,AAAA']);
    expect(request.messages[0].content).toContain('Caption text');
    expect(request.messages[2].content).toBe('Explain it');
    expect(request.settings.systemPrompt).toContain('message 1');
  });
});

describe('Runware SSE stream', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('accepts the empty Claude adapter UUID only on its dedicated response stream', async () => {
    const run = (model: 'claude' | 'gpt', id: unknown) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          body: stream([
            `data: ${JSON.stringify({ taskUUID: id, taskType: 'textInference', delta: { text: '你好' }, finishReason: 'stop', cost: 0.000189 })}\n\n`,
            'data: [DONE]\n\n',
          ]),
        })),
      );
      return streamChat({
        key: 'hidden',
        model,
        messages: [user('Hi')],
        search: false,
        taskUUID: 'expected',
        signal: new AbortController().signal,
        onUpdate: vi.fn(),
      });
    };
    await expect(run('claude', '')).resolves.toMatchObject({ text: '你好', cost: 0.000189 });
    await expect(run('claude', 'another-task')).rejects.toThrow('Runware 回應與請求不符');
    await expect(run('claude', undefined)).rejects.toThrow('Runware 回應與請求不符');
    await expect(run('gpt', '')).rejects.toThrow('Runware 回應與請求不符');
  });

  it.each(['deepseek', 'glm', 'kimi'] as const)(
    'uses the Runware compatibility stream for %s',
    async (model) => {
      const values = [
        { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { total_tokens: 12 } },
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          body: stream([
            ...values.map((value) => `data: ${JSON.stringify(value)}\n\n`),
            'data: [DONE]\n\n',
          ]),
        })),
      );
      const result = await streamChat({
        key: 'hidden',
        model,
        messages: [user('Hi')],
        search: false,
        taskUUID: 'id',
        signal: new AbortController().signal,
        onUpdate: vi.fn(),
      });
      expect(result.text).toBe('Hello');
      expect(result.cost).toBeUndefined();
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://api.runware.ai/v1/chat/completions');
      expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).messages).toEqual([
        { role: 'user', content: 'Hi' },
      ]);
    },
  );

  it('uses per-message images for Gemini while preserving the shared search option', async () => {
    vi.mocked(getMedia).mockResolvedValue({
      id: 'x',
      name: 'note.png',
      blob: new Blob(['x'], { type: 'image/png' }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        body: stream([
          'data: {"choices":[{"delta":{"content":"A photo"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      })),
    );
    await streamChat({
      key: 'hidden',
      model: 'gemini',
      messages: [user('Look', [attachment(['x'])])],
      search: true,
      taskUUID: 'id',
      signal: new AbortController().signal,
      onUpdate: vi.fn(),
    });
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/chat/completions');
    const body = JSON.parse(options!.body as string);
    expect(body.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
    expect(body.tools).toEqual([{ type: 'search' }]);
    expect(body.tool_choice).toBe('auto');
  });

  it('routes GPT-5.4 image search through native Runware with explicit image history', async () => {
    vi.mocked(getMedia).mockResolvedValue({
      id: 'x',
      name: 'photo.png',
      blob: new Blob(['x'], { type: 'image/png' }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        body: stream([
          'data: {"taskUUID":"id","taskType":"textInference","delta":{"text":"ROSE, MINT"},"finishReason":"stop"}\n\n',
          'data: [DONE]\n\n',
        ]),
      })),
    );
    await streamChat({
      key: 'hidden',
      model: 'gpt54',
      messages: [
        user('Earlier', [attachment(['x'])]),
        { role: 'assistant', content: 'ROSE' },
        user('Compare and search', [attachment(['y'])]),
      ],
      search: true,
      taskUUID: 'id',
      signal: new AbortController().signal,
      onUpdate: vi.fn(),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.runware.ai/v1');
    const [task] = JSON.parse(options!.body as string);
    expect(task.model).toBe('openai:gpt@5.4');
    expect(task.inputs.images).toHaveLength(2);
    expect(task.settings.systemPrompt).toContain('Images 2-2 belong to message 3');
    expect(task.settings.thinkingLevel).toBe('low');
    expect(task.tools).toEqual([{ type: 'search' }]);
  });

  it('handles split frames, UTF-8 text, provider sources, and final cost', async () => {
    const event1 =
      'data: ' +
      JSON.stringify({ taskUUID: 'id', taskType: 'textInference', delta: { text: '你好' } }) +
      '\r\n\r\n';
    const event2 =
      'data: ' +
      JSON.stringify({
        taskUUID: 'id',
        taskType: 'textInference',
        delta: { text: '！' },
        sources: [{ title: 'Docs', url: 'https://runware.ai/docs' }],
        finishReason: 'stop',
        cost: 0.0002,
      }) +
      '\r\n\r\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        body: stream([
          event1.slice(0, 17),
          event1.slice(17) + event2.slice(0, 8),
          event2.slice(8) + 'data: [DONE]\r\n\r\n',
        ]),
      })),
    );
    const onUpdate = vi.fn();
    const result = await streamChat({
      key: 'hidden',
      model: 'gpt',
      messages: [user('Hi')],
      search: false,
      taskUUID: 'id',
      signal: new AbortController().signal,
      onUpdate,
    });
    expect(result).toEqual({
      text: '你好！',
      sources: [{ title: 'Docs', url: 'https://runware.ai/docs' }],
      cost: 0.0002,
    });
    expect(onUpdate).toHaveBeenCalledTimes(2);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body[0].deliveryMethod).toBe('stream');
    expect(body[0].includeCost).toBe(true);
  });

  it('does not invent sources from response text and leaves missing cost unknown', async () => {
    const event =
      'data: ' +
      JSON.stringify({
        taskUUID: 'id',
        taskType: 'textInference',
        delta: { text: 'See https://example.com' },
        finishReason: 'stop',
      }) +
      '\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, body: stream([event, 'data: [DONE]\n\n']) })),
    );
    const result = await streamChat({
      key: 'hidden',
      model: 'gemini',
      messages: [user('Hi')],
      search: false,
      taskUUID: 'id',
      signal: new AbortController().signal,
      onUpdate: vi.fn(),
    });
    expect(result.sources).toEqual([]);
    expect(result.cost).toBeUndefined();
  });

  it('rejects missing DONE and provider errors', async () => {
    const event =
      'data: ' +
      JSON.stringify({ taskUUID: 'id', taskType: 'textInference', delta: { text: 'partial' } }) +
      '\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, body: stream([event]) })),
    );
    const options = {
      key: 'hidden',
      model: 'gpt' as const,
      messages: [user('Hi')],
      search: false,
      taskUUID: 'id',
      signal: new AbortController().signal,
      onUpdate: vi.fn(),
    };
    await expect(streamChat(options)).rejects.toThrow(/提前中斷/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        body: stream(['data: {"errors":[{"code":"streamingError"}]}\n\n']),
      })),
    );
    await expect(streamChat(options)).rejects.toThrow('streamingError');
  });
});

it('accepts only provider supplied source URLs', () => {
  expect(
    providerSources({
      citations: [{ title: 'Source', url: 'https://example.com' }, { url: 'javascript:alert(1)' }],
    }),
  ).toEqual([{ title: 'Source', url: 'https://example.com/' }]);
  expect(
    providerSources({
      choices: [
        {
          delta: {
            annotations: [
              {
                type: 'url_citation',
                url_citation: { title: 'Docs', url: 'https://runware.ai/docs' },
              },
            ],
          },
        },
      ],
    }),
  ).toEqual([{ title: 'Docs', url: 'https://runware.ai/docs' }]);
});
