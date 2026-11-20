// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fetchFreezoneAudioReferences } from '@/api/ops';
import { browserNodeDataDefaults } from '@/features/canvas/infrastructure/browserNodeDataDefaults';
import { executeHtmlNodeReadAction } from '@/features/html-artifacts/readNode';
import { readHtmlArtifact, listHtmlVersions } from '@/features/html-artifacts/api';
import { useAuthStore } from '@/stores/auth-store';
import type { CanvasContextPorts } from './chatNodeReferences';

export function createBrowserCanvasContextPorts(
  project: string,
  loadMainlineProjectionAssets?: CanvasContextPorts['loadMainlineProjectionAssets'],
): Omit<CanvasContextPorts, 'loadMainlineProjectionAssets'> & Pick<Partial<CanvasContextPorts>, 'loadMainlineProjectionAssets'> {
  return {
    nodeDataDefaults: browserNodeDataDefaults,
    username: useAuthStore.getState().username ?? null,
    loadAudioReferences: () => fetchFreezoneAudioReferences(project),
    readHtmlNode: options => executeHtmlNodeReadAction({ ...options, ports: { readHtmlArtifact, listHtmlVersions } }),
    ...(loadMainlineProjectionAssets ? { loadMainlineProjectionAssets } : {}),
  };
}
