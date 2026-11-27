// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  project: '',
  image: vi.fn(),
  video: vi.fn(),
}));
vi.mock('@/api/ops', () => ({
  fetchFreezoneImageModels: mocks.image,
  fetchFreezoneVideoModels: mocks.video,
}));
vi.mock('@/lib/url-params', () => ({ readUrl: () => ({ project: mocks.project || null }) }));

beforeEach(() => {
  vi.resetModules();
  mocks.project = '';
  mocks.image.mockReset().mockResolvedValue([]);
  mocks.video.mockReset().mockResolvedValue([]);
});

async function browserCatalogs() {
  const image = await import('@/features/canvas/hooks/useFreezoneImageModels');
  const video = await import('@/features/canvas/hooks/useFreezoneVideoModels');
  const catalogs = await import('@/features/canvas/domain/canvasModelCatalogs');
  return { ...catalogs, image, video };
}

describe('browser canvas catalog providers', () => {
  it('loads each project lazily and shares the hook snapshots, including authoritative empty catalogs', async () => {
    const catalogs = await browserCatalogs();
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.video).not.toHaveBeenCalled();
    expect(catalogs.getCanvasImageModelCatalog().isFallback).toBe(true);
    expect(catalogs.getCanvasVideoModelCatalog().isFallback).toBe(true);
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.video).not.toHaveBeenCalled();

    mocks.project = 'project-a';
    expect(catalogs.getCanvasImageModelCatalog().isLoading).toBe(true);
    expect(catalogs.getCanvasVideoModelCatalog().isLoading).toBe(true);
    expect(catalogs.getCanvasImageModelCatalog()).toBe(catalogs.image.getFreezoneImageModelsSnapshot());
    expect(catalogs.getCanvasVideoModelCatalog()).toBe(catalogs.video.getFreezoneVideoModelsSnapshot());
    await waitFor(() => {
      expect(catalogs.getCanvasImageModelCatalog()).toEqual({ models: [], isLoading: false, isFallback: false, error: null });
      expect(catalogs.getCanvasVideoModelCatalog()).toEqual({ models: [], isLoading: false, isFallback: false, error: null });
    });
    expect(mocks.image).toHaveBeenCalledExactlyOnceWith('project-a');
    expect(mocks.video).toHaveBeenCalledExactlyOnceWith('project-a');

    catalogs.getCanvasImageModelCatalog('project-b');
    catalogs.getCanvasVideoModelCatalog('project-b');
    expect(mocks.image).toHaveBeenCalledTimes(2);
    expect(mocks.video).toHaveBeenCalledTimes(2);
    expect(catalogs.getCanvasImageModelCatalog()).toBe(catalogs.image.getFreezoneImageModelsSnapshot('project-a'));
  });

  it('gives host overrides precedence and restores browser providers afterward', async () => {
    const catalogs = await browserCatalogs();
    const fallback = catalogs.getCanvasImageModelCatalog();
    mocks.project = 'project-a';
    catalogs.withCanvasModelCatalogs({ image: [], video: [] }, () => {
      expect(catalogs.getCanvasImageModelCatalog()).toEqual({ models: [], isLoading: false, isFallback: false, error: null });
      expect(catalogs.getCanvasVideoModelCatalog().models).toEqual([]);
      expect(mocks.image).not.toHaveBeenCalled();
      expect(mocks.video).not.toHaveBeenCalled();
    });
    expect(catalogs.getCanvasImageModelCatalog().isLoading).toBe(true);
    expect(mocks.image).toHaveBeenCalledExactlyOnceWith('project-a');
    expect(catalogs.getCanvasImageModelCatalog(null)).toBe(fallback);
  });
});
