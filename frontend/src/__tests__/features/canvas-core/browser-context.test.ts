// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, expect, it, vi } from 'vitest';
import { buildCanvasContextRequestResponses, extractCanvasContextRequestEnvelopes } from '@/features/freezone/chatNodeReferences';
import { createBrowserCanvasContextPorts } from '@/features/freezone/browserCanvasContextPorts';
import { buildCanvasContextToolResultBody } from '@/features/freezone/context/canvasContextResult';
import { buildCanvasOntologyContext } from '@/features/canvas/ontology/canvasOntology';
import { combineMainlineProjectionAssets } from '@/features/canvas/domain/mainlineProjectionAssets';
import { getFreezoneImageModelsSnapshot } from '@/features/canvas/hooks/useFreezoneImageModels';
import { getFreezoneVideoModelsSnapshot } from '@/features/canvas/hooks/useFreezoneVideoModels';
import { useAuthStore } from '@/stores/auth-store';
import { contextCanvas, contextEnvelopes, contextEnv, contextHostData } from './contextParityFixtures';
import { compareContextParity } from './contextParityComparison';

vi.mock('@/api/ops', async () => {
  const { contextCatalogs, contextHostData } = await import('./contextParityFixtures');
  const { coerceAudioReferences } = await import('@/features/canvas/domain/audioReferences');
  const { coerceModelList, coerceVideoModelList } = await import('@/features/canvas/domain/modelCatalogPayload');
  return {
    fetchFreezoneImageModels: vi.fn(async () => coerceModelList(contextCatalogs.image)),
    fetchFreezoneVideoModels: vi.fn(async () => coerceVideoModelList(contextCatalogs.video)),
    fetchFreezoneAudioReferences: vi.fn(async () => coerceAudioReferences(contextHostData.audio_references)),
  };
});
vi.mock('@/features/html-artifacts/api', async () => {
  const { contextHostData } = await import('./contextParityFixtures');
  return {
    readHtmlArtifact: vi.fn(async (_project, _id, version) => version === 1 ? contextHostData.html_artifacts['page@1'] : contextHostData.html_artifacts['page@latest']),
    listHtmlVersions: vi.fn(async () => contextHostData.html_versions.page),
  };
});

beforeEach(async () => {
  window.history.replaceState({}, '', '/projects/fixture/freezone');
  useAuthStore.setState({ username: contextEnv.username });
  getFreezoneImageModelsSnapshot(contextEnv.project);
  getFreezoneVideoModelsSnapshot(contextEnv.project);
  await vi.waitFor(() => {
    expect(getFreezoneImageModelsSnapshot(contextEnv.project).isLoading).toBe(false);
    expect(getFreezoneVideoModelsSnapshot(contextEnv.project).isLoading).toBe(false);
  });
});

async function browserAnswer(selectedNodeIds: string[] = []) {
  const responses = await buildCanvasContextRequestResponses({
    project: contextEnv.project, canvasId: contextEnv.canvasId,
    nodes: contextCanvas.nodes, edges: contextCanvas.edges, canvasMetadata: contextCanvas.metadata,
    selectedNodeIds, ontologyContext: buildCanvasOntologyContext(contextCanvas.nodes, contextCanvas.edges, { canvasId: contextEnv.canvasId, selectedNodeIds }),
    envelopes: extractCanvasContextRequestEnvelopes(contextEnvelopes()),
    ports: createBrowserCanvasContextPorts(contextEnv.project, async () => combineMainlineProjectionAssets(
      contextHostData.project_assets, contextHostData.characters,
    )),
  });
  return buildCanvasContextToolResultBody({ projectId: contextEnv.project, canvasId: contextEnv.canvasId, responses: responses ?? [] });
}

it('browser reads match the shared snapshot with no selection and live catalog snapshots', async () => {
  expect(getFreezoneImageModelsSnapshot().models.map(model => model.id)).toEqual(['image-fixture']);
  expect(getFreezoneVideoModelsSnapshot().models.map(model => model.id)).toEqual(['video-fixture']);
  compareContextParity(await browserAnswer(), process.env.UPDATE_CONTEXT_PARITY === '1');
});
it('browser selection_detail contains selected nodes; the server default is empty', async () => {
  const empty = await browserAnswer();
  const selected = await browserAnswer(['text']);
  expect(empty.responses.find(item => item.type === 'selection_detail')?.data).toBeNull();
  expect(selected.responses.find(item => item.type === 'selection_detail')?.data).toMatchObject({ nodes: [{ node_id: 'text' }] });
});
