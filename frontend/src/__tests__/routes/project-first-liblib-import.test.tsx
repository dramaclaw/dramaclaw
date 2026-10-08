// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { createElement, type ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  create: vi.fn(), import: vi.fn(), error: vi.fn(), navigate: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => calls.navigate,
  useRouter: () => ({ invalidate: vi.fn() }),
}));
vi.mock('@/lib/queries/projects', () => ({
  useAllProjectSummaries: () => ({ data: [], isLoading: false }),
  useProjectCounts: () => ({ active: 0, archived: 0, deleted: 0 }),
  useCreateProject: () => ({ mutateAsync: calls.create, isPending: false }),
  useArchiveProject: () => ({}), useUnarchiveProject: () => ({}),
  usePurgeProject: () => ({}), useRestoreProject: () => ({}),
  useSoftDeleteProject: () => ({}),
}));
vi.mock('@/lib/queries/product-surfaces', () => ({
  useProductSurfaces: () => ({ data: {}, isPending: false }),
  surfaceAccess: () => ({ available: true }),
}));
vi.mock('@/components/projects/share-project-dialog', () => ({ ShareProjectDialog: () => null }));
vi.mock('@/features/freezone/createProjectLiblibImport', () => ({
  importLiblibCanvasIntoProject: calls.import,
  suggestedProjectNameForLiblibShare: () => 'imported_project',
}));
vi.mock('@/lib/freezone-url', () => ({
  buildFreezoneCanvasUrl: () => null, openFreezoneProject: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: calls.error, success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/project-naming', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/project-naming')>(),
  previewLiblibProject: vi.fn(async () => ({ name: 'imported_project' })),
}));
import { Route } from '@/routes/_app/index';

const shareUrl = 'https://www.liblib.tv/canvas/share?spaceId=42&projectId=0123456789abcdef0123456789abcdef';
const recentKey = 'supertale-dashboard-recent-created-project';
const originalStorage = window.localStorage;

function useStorageFailure(failure?: string, failRead = false) {
  const storage: Storage = {
    length: 0, key: () => null, clear: vi.fn(), removeItem: vi.fn(),
    getItem: vi.fn((key) => {
      if (failRead && key === recentKey) throw new DOMException('blocked', 'SecurityError');
      return null;
    }),
    setItem: vi.fn((key) => {
      if (failure && key === recentKey) throw new DOMException('storage failure', failure);
    }),
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
}

async function submitCreate() {
  render(createElement(Route.options.component as ComponentType));
  fireEvent.click(screen.getByRole('button', { name: /新建项目|创建项目/ }));
  const input = document.getElementById('project-liblib-share-url')!;
  fireEvent.change(input, { target: { value: shareUrl } });
  await waitFor(() => expect(screen.getByRole('button', { name: '确认' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(calls.create).toHaveBeenCalledWith('imported_project'));
}

describe('first LibTV import after project creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.create.mockResolvedValue({ data: { id: 'new-project', name: 'imported_project' } });
    calls.import.mockResolvedValue({ canvasId: 'imported-canvas', skippedMediaCount: 0 });
    useStorageFailure();
  });
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'localStorage', { configurable: true, value: originalStorage });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  });

  it.each([undefined, 'QuotaExceededError', 'SecurityError'])(
    'imports once even when recent-project caching fails with %s', async (failure) => {
      useStorageFailure(failure);
      await submitCreate();
      await waitFor(() => expect(calls.import).toHaveBeenCalledTimes(1));
      expect(calls.import).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'new-project', shareUrl }));
      expect(calls.error).not.toHaveBeenCalled();
    },
  );

  it('allows creating and importing when the recent-project cache cannot be read', async () => {
    useStorageFailure('SecurityError', true);
    await submitCreate();
    await waitFor(() => expect(calls.import).toHaveBeenCalledTimes(1));
    expect(calls.error).not.toHaveBeenCalled();
  });

  it('retains the created project for retry when the import itself fails', async () => {
    calls.import.mockRejectedValueOnce(new Error('remote unavailable'));
    await submitCreate();
    await waitFor(() => expect(calls.error).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /重试导入/ }));
    await waitFor(() => expect(calls.import).toHaveBeenCalledTimes(2));
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.import.mock.calls[1][0].projectId).toBe('new-project');
  });
});
