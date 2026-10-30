// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import ky from 'ky';
import { server } from '@/__mocks__/msw/server';
import { AudioNode } from '@/features/canvas/nodes/AudioNode';
import { AudioOperationsPanel } from '@/features/canvas/nodes/AudioOperationsPanel';
import { AssetBoardAudioGenForm } from '@/features/canvas/ui/asset-board/AssetBoardAudioGenForm';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import {
  CANVAS_NODE_TYPES,
  type AudioNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

// Node fetch needs absolute fixture URLs; response parsing remains the production code.
vi.mock('@/api/client', async (original) => {
  const client = ky.create({ baseUrl: 'http://localhost:3000/api/v1/' });
  return {
    ...(await original<typeof import('@/api/client')>()),
    apiClient: client,
    apiCall: async <T,>(
      path: string,
      options?: Parameters<typeof client>[1],
    ): Promise<T> => (await client(path, options).json<{ data: T }>()).data,
  };
});
vi.mock('@/api/tasks', async (original) => ({
  ...(await original<typeof import('@/api/tasks')>()),
  awaitTaskCompletion: vi.fn(async () => {}),
}));
vi.mock('@/lib/api', () => ({
  api: ky.create({ baseUrl: 'http://localhost:3000/' }),
  handleSessionExpired: vi.fn(),
}));
vi.mock('@/lib/model-task-access', () => ({
  useModelTaskAccess: () => ({
    blocked: false,
    denialReason: null,
    message: null,
  }),
}));
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));
vi.mock('@/lib/url-params', async (original) => ({
  ...(await original<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: 'demo', canvas: 'default' }),
}));

const base = 'http://localhost:3000/api/v1/projects/demo';
const oldRef = {
  scope: 'user_custom',
  voiceId: 'fv_old',
} satisfies NonNullable<AudioNodeData['voiceRef']>;
const text = '今天的天气很好，我们沿着河边慢慢走回家。';
let available: Array<{
  scope: 'user_custom';
  voice_id: string;
  label: string;
}> = [];
let calls: unknown[] = [];
let speechCalls: unknown[] = [];
let failGeneration = false;
let failSave = false;
let generation = 0;
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  available = [];
  calls = [];
  speechCalls = [];
  generation = 0;
  failGeneration = false;
  failSave = false;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:preview'),
      revokeObjectURL: vi.fn(),
    }),
  );
  server.use(
    http.get(`${base}/freezone/jobs/:kind/:id/result`, () =>
      HttpResponse.json({ ok: true, data: { url: '/fixture-speech.mp3' } }),
    ),
    http.post(`${base}/freezone/audio/speech`, async ({ request }) => {
      speechCalls.push(await request.json());
      return HttpResponse.json({
        ok: true,
        data: {
          task_type: 'freezone_audio_speech',
          task_key: 'fixture-speech',
          job_id: 'fixture-speech',
        },
      });
    }),
    http.get(`${base}/freezone/audio/references`, () =>
      HttpResponse.json({ ok: true, data: { available } }),
    ),
    http.get(`${base}/voice-design/quote`, () =>
      HttpResponse.json({
        ok: true,
        data: { cost: 7, display: '7', unit: 'call', quantity: 1 },
      }),
    ),
    http.post(`${base}/voice-design/candidates`, async ({ request }) => {
      const body = await request.json();
      calls.push(body);
      generation++;
      if (failGeneration)
        return HttpResponse.json(
          {
            ok: false,
            code: 'content_rejected',
            error: '请修改描述',
            retryable: false,
            request_id: crypto.randomUUID(),
          },
          { status: 422 },
        );
      if (!body || typeof body !== 'object' || !('request_id' in body))
        throw new Error('invalid fixture input');
      return HttpResponse.json(
        {
          ok: true,
          data: { candidate_id: body.request_id, status: 'generating' },
        },
        { status: 202 },
      );
    }),
    http.get(`${base}/voice-design/candidates/:id`, ({ params }) =>
      HttpResponse.json({
        ok: true,
        data: {
          candidate_id: params.id,
          status: 'ready',
          description: '温柔',
          preview_text: text,
          language: 'zh',
          preview_url: `/api/v1/projects/demo/voice-design/candidates/${params.id}/audio`,
          mime_type: 'audio/mpeg',
          duration_seconds: 3,
          sha256: 'a'.repeat(64),
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        },
      }),
    ),
    http.get(
      `${base}/voice-design/candidates/:id/audio`,
      () =>
        new HttpResponse(new Uint8Array([1, 2]), {
          headers: { 'Content-Type': 'audio/mpeg' },
        }),
    ),
    http.post(
      `${base}/freezone/audio/voices/save-generated`,
      async ({ request }) => {
        const body = await request.json();
        calls.push(body);
        if (failSave)
          return HttpResponse.json(
            {
              ok: false,
              code: 'save_failed',
              error: '保存失败，请重试',
              retryable: true,
              request_id: crypto.randomUUID(),
            },
            { status: 500 },
          );
        if (!body || typeof body !== 'object' || !('name' in body))
          throw new Error('invalid fixture input');
        const name = String(body.name);
        available = [
          ...available,
          { scope: 'user_custom', voice_id: 'fv_generated', label: name },
        ];
        return HttpResponse.json({
          ok: true,
          data: {
            ...available[available.length - 1],
            name,
            path: '_account/voice.mp3',
            url: '/voice.mp3',
            exists: true,
            sha256: 'a'.repeat(64),
            duration_ms: 3000,
            mime_type: 'audio/mpeg',
            created_at: 'now',
            updated_at: 'now',
            source_filename: 'candidate.mp3',
          },
        });
      },
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Entry = 'node' | 'panel' | 'asset';
function mount(entry: Entry) {
  const data: AudioNodeData = {
    audioUrl: null,
    audioKind: 'speech',
    text: '朗读文本：欢迎来到这里。',
    workflowCatalog: { recipeId: 'drama-shot-voice' },
    speechMode: 'clone',
    voiceAvailable: true,
    voicePolicyConfirmed: true,
    voiceRef: oldRef,
    voiceLabel: '原有音色',
  };
  useCanvasStore.getState().setCanvasData(
    [
      {
        id: 'audio-1',
        type: CANVAS_NODE_TYPES.audio,
        position: { x: 0, y: 0 },
        data,
      },
    ],
    [],
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ReactFlowProvider>
        {entry === 'node' ? (
          <AudioNode
            id="audio-1"
            data={data}
            selected={false}
            type="audio"
            dragging={false}
            zIndex={0}
            isConnectable
            positionAbsoluteX={0}
            positionAbsoluteY={0}
            draggable
            selectable
            deletable
          />
        ) : entry === 'panel' ? (
          <AudioOperationsPanel nodeId="audio-1" data={data} />
        ) : (
          <AssetBoardAudioGenForm nodeId="audio-1" data={data} />
        )}
      </ReactFlowProvider>
    </QueryClientProvider>,
  );
  if (entry === 'node')
    act(() => {
      dispatchNodeAction({
        nodeId: 'audio-1',
        action: 'open_voice_picker',
        parameters: { initialTab: 'mine' },
      });
    });
  else {
    if (entry === 'panel')
      fireEvent.click(screen.getByRole('button', { name: '音色设置' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: entry === 'panel' ? '选择声线' : '更换自定义声线',
      }),
    );
  }
}
const current = () =>
  useCanvasStore.getState().nodes.find((n) => n.id === 'audio-1')?.data;
async function generate() {
  fireEvent.click(screen.getByRole('button', { name: '按描述生成' }));
  fireEvent.change(screen.getByLabelText('音色描述', { exact: true }), {
    target: { value: '温柔，明亮的青年声音' },
  });
  fireEvent.change(screen.getByLabelText('试听文本', { exact: true }), {
    target: { value: text },
  });
  await screen.findByText('本次生成：7 积分 / 次');
  fireEvent.click(screen.getByRole('button', { name: '生成试听' }));
  await screen.findByText('3.0 秒', { exact: true });
}

const entries: Entry[] = ['node', 'panel', 'asset'];
it.each(
  entries.flatMap((entry) => [true, false].map((empty) => ({ entry, empty }))),
)(
  'opens shared voice design from $entry (empty=$empty) and explicitly selects after save',
  async ({ entry, empty }) => {
    if (!empty)
      available = [
        { scope: 'user_custom', voice_id: 'fv_old', label: '原有音色' },
      ];
    mount(entry);
    await generate();
    expect(calls[0]).toMatchObject({ surface: 'canvas' });
    fireEvent.click(screen.getByRole('button', { name: '播放试听' }));
    await waitFor(() =>
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled(),
    );
    expect(generation).toBe(1);
    fireEvent.change(screen.getByLabelText('音色名称', { exact: true }), {
      target: { value: '新生成音色' },
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '保存到我的音色' }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '保存到我的音色' }));
    await screen.findByText('新生成音色', { exact: true });
    expect(current()?.voiceRef).toEqual(oldRef);
    expect(current()?.voiceLabel).toBe('原有音色');
    fireEvent.click(screen.getByRole('button', { name: '选择' }));
    expect(current()).toMatchObject({
      speechMode: 'clone',
      voiceRef: { scope: 'user_custom', voiceId: 'fv_generated' },
      voiceLabel: '新生成音色',
    });
    if (entry === 'node')
      act(() => {
        dispatchNodeAction({ nodeId: 'audio-1', action: 'generate_audio' });
      });
    else fireEvent.click(screen.getByRole('button', { name: '生成' }));
    await waitFor(() => expect(speechCalls).toHaveLength(1));
    await waitFor(() =>
      expect(current()?.audioUrl).toBe('/fixture-speech.mp3'),
    );
    expect(speechCalls[0]).toMatchObject({
      speech_mode: 'clone',
      voice_ref: { scope: 'user_custom', voice_id: 'fv_generated' },
    });
  },
);

it('preserves inputs, previous preview and selected reference when regeneration or save fails', async () => {
  available = [{ scope: 'user_custom', voice_id: 'fv_old', label: '原有音色' }];
  mount('panel');
  await generate();
  failGeneration = true;
  fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
  await screen.findByText('请修改描述', { exact: true });
  expect(screen.getByLabelText('音色描述', { exact: true })).toHaveValue(
    '温柔，明亮的青年声音',
  );
  expect(screen.getByLabelText('试听文本', { exact: true })).toHaveValue(text);
  expect(screen.getByText('3.0 秒', { exact: true })).toBeTruthy();
  expect(current()?.voiceRef).toEqual(oldRef);
  fireEvent.change(screen.getByLabelText('音色名称', { exact: true }), {
    target: { value: '重试音色' },
  });
  failSave = true;
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '保存到我的音色' }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: '保存到我的音色' }));
  await screen.findByText('保存失败，请重试', { exact: true });
  expect(current()?.voiceRef).toEqual(oldRef);
  expect(screen.getByLabelText('音色名称', { exact: true })).toHaveValue(
    '重试音色',
  );
  const first = calls[calls.length - 1];
  failSave = false;
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '保存到我的音色' }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: '保存到我的音色' }));
  await screen.findByText('重试音色', { exact: true });
  expect(calls[calls.length - 1]).toEqual(first);
  expect(current()?.voiceRef).toEqual(oldRef);
});
