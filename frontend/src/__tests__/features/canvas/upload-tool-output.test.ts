// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { uploadFreezoneImage, readUrl } = vi.hoisted(() => ({
  uploadFreezoneImage: vi.fn(),
  readUrl: vi.fn(),
}));

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/ops')>()),
  uploadFreezoneImage,
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-params')>()),
  readUrl,
}));

import { uploadLocalImageToBackend } from '@/features/canvas/application/uploadToolOutput';

beforeEach(() => {
  vi.resetAllMocks();
  readUrl.mockReturnValue({ project: 'p1' });
});

describe('uploadLocalImageToBackend', () => {
  it('returns the backend address for a local image', async () => {
    uploadFreezoneImage.mockResolvedValue({
      url: '/static/projects/p1/freezone/_uploads/a.png',
    });

    await expect(uploadLocalImageToBackend(
      'data:image/png;base64,iVBORw0KGgo=', 'a.png'
    )).resolves.toBe('/static/projects/p1/freezone/_uploads/a.png');
  });

  it('returns a remote address without uploading', async () => {
    await expect(uploadLocalImageToBackend(
      'https://cdn.example.com/a.png', 'a.png'
    )).resolves.toBe('https://cdn.example.com/a.png');
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  it('rejects when uploading fails', async () => {
    uploadFreezoneImage.mockRejectedValue(new Error('upload failed: 503'));

    await expect(uploadLocalImageToBackend(
      'data:image/png;base64,iVBORw0KGgo=', 'a.png'
    )).rejects.toThrow('upload failed: 503');
  });

  it('rejects without uploading when there is no project', async () => {
    readUrl.mockReturnValue({ project: null });

    await expect(uploadLocalImageToBackend(
      'data:image/png;base64,iVBORw0KGgo=', 'a.png'
    )).rejects.toThrow();
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });
});
