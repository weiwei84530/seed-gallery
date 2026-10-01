import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addJobs, clearWorks, database, removeWork, saveWork } from '../src/db';
import { exportBackup, importBackup } from '../src/backup';
import {
  buildInspirationRequest,
  fetchInspiration,
  parseIdeas,
  preferenceExamples,
  promptRecords,
  inspirationResponsesRequest,
} from '../src/inspiration';
import { newDraft, newVideoDraft, type Job } from '../src/types';

const job = (patch: Partial<Job> = {}): Job => ({
  id: crypto.randomUUID(),
  workId: crypto.randomUUID(),
  batchId: crypto.randomUUID(),
  model: 'banana',
  status: 'failed',
  createdAt: 1,
  keyTag: '',
  draft: { ...newDraft(), prompt: '水彩花園裡的一隻貓' },
  ...patch,
});
const ideas = {
  ideas: Array.from({ length: 4 }, (_, i) => ({
    title: `靈感 ${i}`,
    prompt: `不同的創作方向 ${i}`,
  })),
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearWorks();
});

describe('adopted prompt history', () => {
  it('counts batches once, keeps failed intentions and separates image and video', () => {
    const first = job();
    const jobs = [
      first,
      { ...first, id: crypto.randomUUID(), model: 'gptSunburst' as const },
      job({ createdAt: 3 }),
      job({ createdAt: 4, model: 'kling', draft: { ...newVideoDraft(), prompt: '花朵隨風搖曳' } }),
    ];
    expect(promptRecords(jobs, 'image')).toHaveLength(2);
    expect(promptRecords(jobs, 'image')[0].createdAt).toBe(3);
    expect(promptRecords(jobs, 'video').map((r) => r.prompt)).toEqual(['花朵隨風搖曳']);
    expect(preferenceExamples(promptRecords(jobs, 'image'))).toEqual([
      { prompt: first.draft.prompt, uses: 2 },
    ]);
  });

  it('retains full adopted records through backup and removes them when works are deleted', async () => {
    const workId = crypto.randomUUID();
    await saveWork({
      id: workId,
      title: 'Test',
      createdAt: 1,
      updatedAt: 1,
      draft: { ...newDraft(), prompt: '這是還沒採用的草稿' },
    });
    expect(promptRecords(await (await database).getAll('jobs'), 'image')).toEqual([]);
    await addJobs([job({ workId })]);
    const backup = await exportBackup();
    await removeWork(workId);
    expect(promptRecords(await (await database).getAll('jobs'), 'image')).toEqual([]);
    await importBackup(new File([backup], 'test.zip', { type: 'application/zip' }));
    expect(
      promptRecords(await (await database).getAll('jobs'), 'image').map((r) => r.prompt),
    ).toEqual(['水彩花園裡的一隻貓']);
  });

  it('bounds transmitted history without altering saved records', () => {
    const records = Array.from({ length: 70 }, (_, i) => ({
      batchId: String(i),
      prompt: `${i}${'花'.repeat(3000)}`,
      createdAt: 70 - i,
    }));
    const selected = preferenceExamples(records);
    expect(selected.length).toBeLessThanOrEqual(24);
    expect(selected.reduce((sum, r) => sum + r.prompt.length, 0)).toBeLessThanOrEqual(12000);
    expect(selected[0].prompt.startsWith('0')).toBe(true);
    expect(records[0].prompt.length).toBeGreaterThan(3000);
  });
});

describe('inspiration requests', () => {
  it('uses Luna Responses with photos, strict schema, no server storage and reported cost', async () => {
    const draft = { ...newDraft(), prompt: 'Use a playful voice', refs: ['photo'] };
    const task = buildInspirationRequest('id', draft, [], ['data:image/png;base64,test']);
    expect(inspirationResponsesRequest(task)).toMatchObject({
      model: 'openai:gpt@6-luna',
      store: false,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', strict: true } },
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text' },
            { type: 'input_image', image_url: 'data:image/png;base64,test' },
          ],
        },
      ],
    });
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).not.toHaveProperty('temperature');
      return new Response(
        JSON.stringify({
          model: body.model,
          status: 'completed',
          usage: { cost: 0.0004 },
          output: [
            { type: 'reasoning', summary: [] },
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(ideas) }] },
          ],
        }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    expect(await fetchInspiration('fake', newDraft(), [])).toEqual({
      ideas: ideas.ideas,
      cost: 0.0004,
    });
    expect(fetch.mock.calls[0][0]).toBe('https://api.runware.ai/v1/responses');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('sends all photos, existing text, video constraints and previous ideas in one completion', () => {
    const draft = {
      ...newVideoDraft(),
      prompt: '保留杯子與花朵，鏡頭靠近',
      refs: ['photo'],
      duration: 4,
      audio: false,
    };
    const payload = buildInspirationRequest(
      'task',
      draft,
      [],
      ['data:image/png;base64,test'],
      ideas.ideas,
    );
    expect(payload.numberResults).toBe(1);
    expect(payload.inputs?.images).toHaveLength(1);
    expect(payload.model).toBe('openai:gpt@6-luna');
    expect(JSON.parse(payload.messages[0].content)).toMatchObject({
      currentPrompt: draft.prompt,
      kind: 'video',
      durationSeconds: 4,
      audio: false,
      historyNewestFirst: [],
      previousSuggestions: ideas.ideas.map((i) => i.prompt),
    });
    expect(() => buildInspirationRequest('task', draft, [], [])).toThrow('參考照片不完整');
  });

  it('does not submit a paid request when a reference is missing', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      fetchInspiration('fake', { ...newDraft(), refs: ['missing'] }, []),
    ).rejects.toThrow('參考照片已遺失');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed, duplicate, truncated and mismatched results without retries', async () => {
    expect(parseIdeas(JSON.stringify(ideas))).toHaveLength(4);
    expect(() => parseIdeas('not json')).toThrow();
    expect(() => parseIdeas(JSON.stringify({ ideas: Array(4).fill(ideas.ideas[0]) }))).toThrow();
    for (const mismatch of [false, true]) {
      const fetch = vi.fn(async (_url: string, init: RequestInit) => {
        const task = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            model: mismatch ? 'other' : task.model,
            status: mismatch ? 'completed' : 'incomplete',
            output: [
              { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(ideas) }] },
            ],
          }),
        );
      });
      vi.stubGlobal('fetch', fetch);
      await expect(fetchInspiration('fake', newDraft(), [])).rejects.toThrow('完整靈感');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});
