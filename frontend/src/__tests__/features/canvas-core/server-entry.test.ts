// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';
import {
  buildCanvasCommandToolResultPayload,
  extractCanvasChatCommandEnvelopes,
  getCanvasImageModelCatalog,
  getCanvasVideoModelCatalog,
  normalizeCanvasChatCommandEnvelopesForValidation,
  validateCanvasChatCommandEnvelopes,
  withCanvasModelCatalogs,
  type ModelOption,
} from '@/features/canvas/serverEntry';

const image: ModelOption = {
  id: 'server-only-image',
  apiModel: 'server-only-image',
  label: 'Server image',
  providerId: 'newapi',
};

function imageCommand() {
  return normalizeCanvasChatCommandEnvelopesForValidation(extractCanvasChatCommandEnvelopes([{
    schema_version: 'canvas_chat_commands.v1',
    commands: [{ type: 'create_node', node_type: 'imageGenNode', data: { model: image.id } }],
  }]), []);
}

describe('server canvas entry', () => {
  it('validates a model available only in the host catalog', () => {
    const envelopes = imageCommand();
    expect(envelopes).toHaveLength(1);
    expect(validateCanvasChatCommandEnvelopes(envelopes, [], []).ok).toBe(false);
    const validation = withCanvasModelCatalogs({ image: [image], video: [] }, () => {
      expect(validateCanvasChatCommandEnvelopes(envelopes, [], [])).toEqual({ ok: true, issues: [] });
      expect(getCanvasImageModelCatalog()).toEqual({
        models: [image], isLoading: false, isFallback: false, error: null,
      });
      expect(getCanvasVideoModelCatalog().models).toEqual([]);
      return validateCanvasChatCommandEnvelopes(envelopes, [], []);
    });
    expect(validation.ok).toBe(true);
    expect(validateCanvasChatCommandEnvelopes(envelopes, [], []).ok).toBe(false);
  });

  it('restores nested catalogs even when validation throws', () => {
    expect(getCanvasImageModelCatalog().isFallback).toBe(true);
    withCanvasModelCatalogs({ image: [image], video: [] }, () => {
      expect(() => withCanvasModelCatalogs({ image: [], video: [] }, () => {
        expect(getCanvasImageModelCatalog().models).toEqual([]);
        throw new Error('validation failed');
      })).toThrow('validation failed');
      expect(getCanvasImageModelCatalog().models).toEqual([image]);
    });
    expect(getCanvasImageModelCatalog().isFallback).toBe(true);
    expect(getCanvasVideoModelCatalog().isFallback).toBe(true);
  });

  it('builds an applied receipt with a host translator', () => {
    const receipt = buildCanvasCommandToolResultPayload({
      bridgeKey: 'server-command',
      translate: (key) => key,
      result: {
        applied: 1,
        openedUiActions: 0,
        createdNodeIds: ['image-1'],
        errors: [],
        commandResults: [{ commandIndex: 0, type: 'create_node', status: 'success', label: 'Image' }],
      },
    });
    expect(receipt).toMatchObject({
      canvas_apply_status: 'applied', applied: true, tool_call_status: 'completed',
      background_execution_status: 'succeeded', created_node_ids: ['image-1'],
    });
  });

  it('uses the host translator for pending receipts', () => {
    const receipt = buildCanvasCommandToolResultPayload({
      translate: (key) => key,
      result: {
        applied: 0, openedUiActions: 0, createdNodeIds: [], errors: [],
        commandResults: [{ commandIndex: 0, type: 'run_workflow', status: 'pending', label: 'Workflow' }],
      },
    });
    expect(receipt.canvas_apply_status).toBe('pending');
    expect(receipt.user_message).toBe('freezone.chat.workflowOutputSyncPendingMessage');
    expect(receipt.message).toBe(receipt.user_message);
  });
});
