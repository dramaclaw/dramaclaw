// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import en from '../../../../public/locales/en/translation.json';
import { browserCanvasEnvironment } from '@/features/canvas/infrastructure/browserCanvasEnvironment';
import { useCanvasStore } from '@/stores/canvasStore';
import { applyCanvasChatCommands } from '@/features/freezone/canvasChatCommands';
import { buildSavePayload } from '@/features/freezone/canvasSyncCore';
import { parityBatches, initialCanvas, deterministicIds } from './parityFixtures';
import { compareParity } from './parityComparison';

beforeEach(async () => {
  localStorage.clear();
  vi.spyOn(browserCanvasEnvironment.ids, 'next').mockImplementation(deterministicIds().next);
  vi.spyOn(Date, 'now').mockReturnValue(1730000000000);
  vi.useFakeTimers();
  vi.setSystemTime(1730000000000);
  await i18next.init({ lng: 'en', resources: { en: { translation: en } }, initAsync: false });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it.each(parityBatches)('browser matches the shared snapshot: $name', batch => {
  const canvas = initialCanvas();
  useCanvasStore.getState().setCanvasData(canvas.nodes, canvas.edges);
  const result = applyCanvasChatCommands(batch.commands);
  expect(result.errors).toEqual([]);
  const state = useCanvasStore.getState();
  const saved = buildSavePayload({
    canvasId: 'parity', nodes: state.nodes, edges: state.edges,
    baseRevision: null, clientSaveId: 'parity-save',
    decision: { kind: 'send', saveSource: 'autosave', allowEmptyOverwrite: false },
  });
  compareParity(batch.name, saved, 'layout' in batch && batch.layout, process.env.UPDATE_CANVAS_PARITY === '1');
});
