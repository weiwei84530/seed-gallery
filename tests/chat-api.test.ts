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
  responsesRequest,
  anthropicRequest,
  streamChat,
} from '../src/chat-api';
import { validateChatRequest } from '../src/chat-models';

it('carries the custom system prompt through native, compatible and Responses requests', async () => {
  const messages: ChatHistoryMessage[] = [{ role: 'user', content: 'Hello' }];
  const task = await buildChatRequest(
    'gpt6Sol',
    messages,
    false,
    'id',
    'Use concise Traditional Chinese.',
  );
  expect(task.settings.systemPrompt).toBe('Use concise Traditional Chinese.');
  expect(compatibilityRequest(task, messages).messages[0]).toEqual({
    role: 'system',
    content: 'Use concise Traditional Chinese.',
  });
  expect(responsesRequest(task, messages).input[0]).toEqual({
    role: 'system',
    content: 'Use concise Traditional Chinese.',
  });
  const empty = await buildChatRequest('gpt6Sol', messages, false, 'id', '  ');
  expect(empty.settings.systemPrompt).toBeUndefined();
  expect(compatibilityRequest(empty, messages).messages).toEqual(messages);
});

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

it('maps thinking modes without an application output cap', async () => {
  const messages = [user('Hello')];
  for (const [mode, effort] of [
    ['fast', 'low'],
    ['balanced', 'medium'],
    ['deep', 'high'],
  ] as const) {
    const gpt = await buildChatRequest('gpt6Sol', messages, false, 'id', '', mode);
    expect(responsesRequest(gpt, messages).reasoning.effort).toBe(effort);
    expect(responsesRequest(gpt, messages)).not.toHaveProperty('max_output_tokens');
    const gemini = await buildChatRequest('gemini38Flash', messages, false, 'id', '', mode);
    expect(compatibilityRequest(gemini, messages)).toMatchObject({ reasoning_effort: effort });
    expect(compatibilityRequest(gemini, messages)).not.toHaveProperty('max_completion_tokens');
    const claude = await buildChatRequest('opus55', messages, false, 'id', '', mode);
    expect(anthropicRequest(claude, messages).output_config.effort).toBe(effort);
    expect(anthropicRequest(claude, messages).max_tokens).toBe(128000);
    const pro = await buildChatRequest('deepseekPro', messages, false, 'id', '', mode);
    expect(compatibilityRequest(pro, messages)).toMatchObject({
      model: 'deepseek:v4@pro',
      reasoning_effort: mode === 'fast' ? 'none' : 'high',
    });
    expect(compatibilityRequest(pro, messages)).not.toHaveProperty('thinking');
    const minimax = await buildChatRequest('minimaxM3', messages, false, 'id', '', mode);
    expect(minimax.settings).not.toHaveProperty('thinkingLevel');
    expect(minimax.settings).not.toHaveProperty('maxTokens');
  }
});

it('blocks all Pro attachments while keeping historical Flash available', async () => {
  for (const file of [attachment(['x']), attachment([], 'Text file')]) {
    const messages = [
      user('Look', [file]),
      { role: 'assistant' as const, content: 'Earlier reply' },
      user('Follow up'),
    ];
    expect(validateChatRequest(['deepseekPro'], messages, false)).toMatch(/不支援上傳檔案/);
    await expect(buildChatRequest('deepseekPro', messages, false, 'id')).rejects.toThrow(
      /不支援上傳檔案/,
    );
    expect(validateChatRequest(['deepseek'], messages, false)).toBeNull();
  }
});

it('preserves Claude image positions and streams visible text and cost only', async () => {
  vi.mocked(getMedia).mockResolvedValue({
    id: 'x',
    name: 'note.png',
    blob: new Blob(['x'], { type: 'image/png' }),
  });
  const messages = [
    user('Look', [attachment(['x'])]),
    { role: 'assistant' as const, content: 'First' },
    user('Continue'),
  ];
  const task = await buildChatRequest('opus55', messages, false, 'id', 'Be concise', 'deep');
  const request = anthropicRequest(task, messages);
  expect(request.system).toContain('Be concise');
  expect(request.messages[0].content).toMatchObject([
    { type: 'text' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
  ]);
  expect(request.messages[1].content).toBe('First');
  const events = [
    { type: 'message_start', message: { usage: { cost: 0.001 } } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Private thought' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Answer' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { cost: 0.002 } },
    { type: 'message_stop' },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      body: stream(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)),
    })),
  );
  expect(
    await streamChat({
      key: 'fake',
      model: 'opus55',
      messages,
      search: false,
      chatMode: 'deep',
      taskUUID: 'id',
      signal: new AbortController().signal,
      onUpdate: vi.fn(),
    }),
  ).toEqual({ text: 'Answer', sources: [], cost: 0.002 });
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://api.runware.ai/v1/messages');
});

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

it.each(['max_tokens', undefined])(
  'rejects incomplete Claude Messages streams (%s)',
  async (reason) => {
    const events = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial answer' } },
      ...(reason ? [{ type: 'message_delta', delta: { stop_reason: reason } }] : []),
      { type: 'message_stop' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        body: stream(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)),
      })),
    );
    await expect(
      streamChat({
        key: 'fake',
        model: 'opus55',
        messages: [user('Hello')],
        search: false,
        taskUUID: 'id',
        signal: new AbortController().signal,
        onUpdate: vi.fn(),
      }),
    ).rejects.toThrow(/未.*完成/);
  },
);

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
    expect(request.messages[0].role).toBe('system');
    const conversation = request.messages.filter((message) => message.role !== 'system');
    expect(conversation[0].content).toHaveLength(2);
    expect(conversation[1].content).toBe('A note');
    expect(conversation[2].content).toHaveLength(2);
    expect(conversation[3].content).toBe('Compare');
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

  it('uses native image requests for MiniMax M3 and Claude Opus 4.8', async () => {
    vi.mocked(getMedia).mockResolvedValue({
      id: 'x',
      name: 'note.png',
      blob: new Blob(['x'], { type: 'image/png' }),
    });
    for (const model of ['minimaxM3', 'opus48'] as const) {
      let requested: Record<string, unknown> | undefined;
      const updates: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, options: RequestInit) => {
          expect(url).toBe('https://api.runware.ai/v1');
          requested = JSON.parse(String(options.body))[0];
          return {
            ok: true,
            body: stream([
              `data: ${JSON.stringify({ taskUUID: model === 'opus48' ? '' : 'id', taskType: 'textInference', delta: { text: model === 'minimaxM3' ? '<think>hidden' : 'Visible answer' } })}\n\n`,
              ...(model === 'minimaxM3'
                ? [
                    `data: ${JSON.stringify({ taskUUID: 'id', taskType: 'textInference', delta: { text: ' reasoning</think>Visible answer' }, finishReason: 'stop' })}\n\n`,
                  ]
                : [
                    `data: ${JSON.stringify({ taskUUID: '', taskType: 'textInference', finishReason: 'stop' })}\n\n`,
                  ]),
              'data: [DONE]\n\n',
            ]),
          };
        }),
      );
      const result = await streamChat({
        key: 'test',
        model,
        messages: [user('Read this', [attachment(['x'])])],
        search: false,
        taskUUID: 'id',
        signal: new AbortController().signal,
        onUpdate: (update) => updates.push(update.text),
      });
      expect(result.text).toBe('Visible answer');
      expect(updates.every((value) => !value.includes('<think>'))).toBe(true);
      expect(requested?.inputs).toEqual({ images: ['data:image/png;base64,AAAA'] });
      if (model === 'minimaxM3') expect(requested?.settings).not.toHaveProperty('splitThinking');
    }
  });

  it('uses Responses search and keeps verified source annotations', async () => {
    const completed = {
      type: 'response.completed',
      response: {
        status: 'completed',
        model: 'openai:gpt@6-sol',
        output: [
          { type: 'web_search_call', status: 'completed' },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: '最新公告',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://www.nasa.gov/news-release/test',
                    title: 'NASA',
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        body: stream([
          'data: {"type":"response.output_text.delta","delta":"最"}\n\n',
          `data: ${JSON.stringify(completed)}\n\n`,
          'data: [DONE]\n\n',
        ]),
      })),
    );
    const result = await streamChat({
      key: 'hidden',
      model: 'gpt6Sol',
      messages: [user('最新公告')],
      search: true,
      taskUUID: 'id',
      signal: new AbortController().signal,
      onUpdate: vi.fn(),
    });
    expect(result.text).toBe('最新公告');
    expect(result.sources).toEqual([
      { title: 'NASA', url: 'https://www.nasa.gov/news-release/test' },
    ]);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.runware.ai/v1/responses');
    expect(JSON.parse(options!.body as string)).toMatchObject({
      model: 'openai:gpt@6-sol',
      store: false,
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
    });
  });

  it('does not treat a Responses answer without a completed search as verified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        body: stream([
          'data: {"type":"response.completed","response":{"status":"completed","model":"openai:gpt@6-sol","output":[{"type":"message","content":[{"type":"output_text","text":"猜測答案"}]}]}}\n\n',
          'data: [DONE]\n\n',
        ]),
      })),
    );
    await expect(
      streamChat({
        key: 'hidden',
        model: 'gpt6Sol',
        messages: [user('最新公告')],
        search: true,
        taskUUID: 'id',
        signal: new AbortController().signal,
        onUpdate: vi.fn(),
      }),
    ).rejects.toThrow('尚未確認完成網路搜尋');
  });

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
    expect(
      body.messages.find((message: { role: string }) => message.role === 'user').content[1],
    ).toEqual({
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
    expect(task.settings.thinkingLevel).toBe('medium');
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
