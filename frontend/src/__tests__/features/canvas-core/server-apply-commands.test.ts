// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCommands } from '@/features/canvas/server/applyCommands';
import { getCanvasImageModelCatalog, withCanvasModelCatalogsAsync } from '@/features/canvas/domain/canvasModelCatalogs';
import { createServerTranslate } from '@/features/canvas/server/i18n';
import { normalizeCanvasChatCommandEnvelopesForValidation, validateCanvasChatCommandEnvelopes } from '@/features/canvas/serverEntry';
import { structuralEnvelopes } from './structuralEnvelopes';
import { envelope, initialCanvas, deterministicIds } from './parityFixtures';

const env = () => ({ locale: 'en', catalogs: {}, ids: deterministicIds(), now: () => 1730000000000 });

describe('server applyCommands', () => {
  it('applies structural commands and returns the browser receipt', async () => {
    const result = await applyCommands({ nodes: [], edges: [] }, structuralEnvelopes(), env());
    expect(result.status).toBe('applied');
    expect(result.changes.created_node_ids).toEqual(['parity-1', 'parity-2', 'parity-3']);
    expect(result.receipt.canvas_apply_status).toBe('applied');
    expect(result.receipt.applied_count).toBe(6);
    expect(result.receipt).not.toHaveProperty('turn_id');
    expect(result.receipt).not.toHaveProperty('bridge_key');
  });

  it('invalidates downstream generated results and reports indirect updates', async () => {
    const canvas = initialCanvas();
    const before = structuredClone(canvas);
    const result = await applyCommands(canvas, envelope([{ type: 'update_node_data', node_id: 'source', data: { content: 'Changed' } }]), env());
    expect(result.canvas.nodes.find(n => n.id === 'generated')?.data).toMatchObject({ workflowResultStale: true, workflowInvalidatedAt: new Date(1730000000000).toISOString(), workflowInvalidationReason: 'upstream_input_changed' });
    expect(result.changes.updated_node_ids).toContain('generated');
    expect(canvas).toEqual(before);
  });

  it('defers an entire batch containing a host command', async () => {
    const result = await applyCommands(initialCanvas(), envelope([
      { type: 'clear_canvas' }, { type: 'run_workflow', scope: 'canvas' },
    ]), env());
    expect(result.status).toBe('host_required');
    expect(result.host_command_types).toEqual(['run_workflow']);
    expect(result.canvas.nodes.map(n => n.id)).toEqual(['source', 'generated', 'spare']);
    expect(Object.values(result.changes).every(ids => ids.length === 0)).toBe(true);
    expect(result.receipt.applied).toBe(false);
  });

  it('returns the same validation messages and failed result shape as the browser', async () => {
    const commands = envelope([{ type: 'update_node_data', node_id: 'missing', data: { content: 'No' } }]);
    const validation = validateCanvasChatCommandEnvelopes(normalizeCanvasChatCommandEnvelopesForValidation(commands, []), [], []);
    const browser = fs.readFileSync(path.resolve(__dirname, '../../../features/freezone/canvasCommandValidationFailure.ts'), 'utf8');
    const prefix = browser.match(/CANVAS_COMMAND_VALIDATION_FAILURE_MESSAGE = "([^"]+)"/)![1];
    const label = browser.match(/type: "validate",\s*status: "error",\s*label: "([^"]+)"/)![1];
    const errors = [prefix, ...validation.issues.map(i => `${i.path}: ${i.message}`)];
    const result = await applyCommands({ nodes: [], edges: [] }, commands, env());
    expect(result.status).toBe('validation_failed');
    expect(result.receipt.errors).toEqual(errors);
    expect(result.receipt.command_results).toEqual([{ commandIndex: -1, type: 'validate', status: 'error', label, error: errors.join('; ') }]);
    expect(result.canvas).toEqual({ nodes: [], edges: [] });
  });

  it('uses raw host model catalogs through async execution and restores them between calls', async () => {
    const commands = envelope([{ type: 'create_node', node_type: 'imageGenNode', data: { model: 'injected-image', prompt: 'Sea' } }]);
    const result = await applyCommands({ nodes: [], edges: [] }, commands, { ...env(), catalogs: { image: { models: [{ id: 'injected-image', model: 'injected-api', provider: 'newapi', label: 'Injected' }] } } });
    expect(result.status).toBe('applied');
    expect(result.canvas.nodes[0].data.model).toBe('injected-image');
    expect((await applyCommands({ nodes: [], edges: [] }, commands, env())).status).toBe('validation_failed');
  });

  it('retains catalog overrides across awaits and restores them on rejection', async () => {
    const before = getCanvasImageModelCatalog();
    const image = { id: 'async-image', apiModel: 'async-image', label: 'Async', providerId: 'newapi' as const };
    await expect(withCanvasModelCatalogsAsync({ image: [image], video: [] }, async () => {
      await Promise.resolve();
      expect(getCanvasImageModelCatalog().models).toEqual([image]);
      throw new Error('scope failed');
    })).rejects.toThrow('scope failed');
    expect(getCanvasImageModelCatalog()).toEqual(before);
  });

  it('serializes concurrent direct callers without leaking catalogs', async () => {
    const commands = envelope([{ type: 'create_node', node_type: 'imageGenNode', data: { model: 'concurrent-image' } }]);
    const [injected, fallback] = await Promise.all([
      applyCommands({ nodes: [], edges: [] }, commands, { ...env(), catalogs: { image: { models: [{ id: 'concurrent-image', model: 'concurrent-image', provider: 'newapi' }] } } }),
      applyCommands({ nodes: [], edges: [] }, commands, env()),
    ]);
    expect(injected.status).toBe('applied');
    expect(fallback.status).toBe('validation_failed');
  });

  it('preserves view fields and sanitizes previews using the browser save shape', async () => {
    const canvas = initialCanvas();
    canvas.nodes[0] = { ...canvas.nodes[0], selected: true, dragging: true, measured: { width: 999, height: 888 } };
    const result = await applyCommands(canvas, envelope([{ type: 'select_nodes', node_ids: ['generated'], focus: true }]), env());
    expect(result.canvas.nodes[0]).toMatchObject({ selected: false, dragging: true, measured: { width: 999, height: 888 } });
    expect(result.canvas.nodes[1].selected).toBe(true);
    expect(result.changes.updated_node_ids).toEqual(['source', 'generated', 'spare']);
    expect(result.canvas.nodes[1].data.previewImageUrl).toBe('/output/sea.png');
    expect(result.changes.created_node_ids).toEqual([]);
  });

  it('uses private bundled translations and normalizes locales', async () => {
    const zh = await createServerTranslate('zh');
    const unknown = await createServerTranslate('unknown');
    const en = await createServerTranslate('en-US');
    expect(unknown('node.menu.uploadImage')).toBe(zh('node.menu.uploadImage'));
    expect(en('node.menu.uploadImage')).not.toBe(zh('node.menu.uploadImage'));
  });
});
