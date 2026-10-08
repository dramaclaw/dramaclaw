// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getFreezoneCanvas, getLiblibShareCanvasDetail, listFreezoneCanvases, putFreezoneCanvas } from '@/api/canvas';
import { importLiblibCanvasIntoProject } from '@/features/freezone/createProjectLiblibImport';
import { CanvasesTab } from '@/features/freezone/CanvasesTab';
import { errorFromBackendBody } from '@/lib/api-errors';
import { useAuthStore } from '@/stores/auth-store';

vi.mock('@/api/canvas', async (original) => ({
  ...await original<typeof import('@/api/canvas')>(),
  listFreezoneCanvases: vi.fn(), getFreezoneCanvas: vi.fn(), getLiblibShareCanvasDetail: vi.fn(), putFreezoneCanvas: vi.fn(),
}));
vi.mock('@/api/ops', () => ({
  fetchFreezoneImageModels: vi.fn(async () => []), fetchFreezoneVideoModels: vi.fn(async () => []),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const shareUrl = 'https://www.liblib.tv/canvas/share?spaceId=42&projectId=0123456789abcdef0123456789abcdef';
const detail = {
  projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42, name: 'Source' },
  nodeList: [{ nodeKey: 'i1', type: 2, position: { positionX: 0, positionY: 0 },
    data: JSON.stringify({ type: 'image', url: ['https://cdn.example/a.png'] }) }],
  connectionList: [],
};

it('saves the complete graph with remote URLs before any media download', async () => {
  vi.mocked(listFreezoneCanvases).mockResolvedValue([]);
  vi.mocked(getLiblibShareCanvasDetail).mockResolvedValue({
    projectMeta: { uuid: '0123456789abcdef0123456789abcdef', projectSpaceId: 42, name: 'Source' },
    nodeList: [{ nodeKey: 'i1', type: 2, position: { positionX: 0, positionY: 0 },
      data: JSON.stringify({ type: 'image', url: ['https://cdn.example/a.png'] }) }],
    connectionList: [],
  });
  vi.mocked(putFreezoneCanvas).mockResolvedValue({ saved: true, revision: 1 });
  const result = await importLiblibCanvasIntoProject({ projectId: 'new-project', shareUrl });
  expect(getLiblibShareCanvasDetail).toHaveBeenCalledWith('new-project', shareUrl, false);
  expect(putFreezoneCanvas).toHaveBeenCalledWith('new-project', result.canvasId, expect.objectContaining({
    base_revision: null,
    nodes: [expect.objectContaining({ data: expect.objectContaining({ imageUrl: 'https://cdn.example/a.png' }) })],
    metadata: expect.objectContaining({ liblib_import: expect.objectContaining({ background_localize: true }) }),
  }));
});

it('imports through the in-project form after a real structured missing-canvas response', async () => {
  useAuthStore.setState({ username: 'local', role: 'admin' });
  vi.mocked(listFreezoneCanvases).mockResolvedValue([]);
  vi.mocked(getFreezoneCanvas).mockRejectedValue(errorFromBackendBody(404, {
    detail: { code: 'canvas_not_found', message: 'Canvas not found' },
  }, 'HTTP 404'));
  vi.mocked(getLiblibShareCanvasDetail).mockResolvedValue(detail);
  vi.mocked(putFreezoneCanvas).mockResolvedValue({ saved: true, revision: 1 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(CanvasesTab, {
    project: 'p', currentCanvasId: 'default', hasPresetLabel: false,
  })));
  await waitFor(() => expect(listFreezoneCanvases).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByRole('button', { name: '切换画布' })).toHaveAttribute('aria-busy', 'false'));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '切换画布' }));
  await user.click(await screen.findByText('导入 LibTV 分享画布'));
  fireEvent.change(screen.getByPlaceholderText('粘贴 LibTV 分享画布链接'), { target: { value: shareUrl } });
  await user.click(screen.getByRole('button', { name: '导入' }));
  await waitFor(() => expect(putFreezoneCanvas).toHaveBeenCalledTimes(1));
  expect(getLiblibShareCanvasDetail).toHaveBeenCalledWith('p', shareUrl, false);
  expect(putFreezoneCanvas).toHaveBeenCalledWith('p', expect.any(String), expect.objectContaining({
    metadata: expect.objectContaining({ liblib_import: expect.objectContaining({ background_localize: true }) }),
  }));
});
