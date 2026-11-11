// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAudioTranslateRequest, audioTranslateResultPatch, audioTranslateActionResult, nodeContextWireFields, textTranslateWireBody } from '@/features/canvas/application/generationRequests';
import { CANVAS_NODE_TYPES, type AudioNodeData, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { collectImportGraph } from './importGraph';

const id = 'audio-translate';
interface Fixture {
  name: string;
  data?: Partial<AudioNodeData>;
  project?: string;
  canvas?: string;
  target?: 'missing' | 'wrong_type';
  fault?: 'submit' | 'wait' | 'result';
  translated?: string;
  operation?: { projectId: string; operationId: string; generationAttemptId?: string };
}
const fixtures: Fixture[] = [
  { name: 'trimmed text and default canvas' },
  { name: 'explicit canvas', canvas: 'canvas/2' },
  { name: 'empty canvas remains empty', canvas: '' },
  { name: 'legacy segments', data: { text: undefined, segments: [{ type: 'text', value: ' first ' }, { type: 'text', value: 'second ' }] } },
  { name: 'empty string shadows legacy segments', data: { text: '', segments: [{ type: 'text', value: 'ignored' }] } },
  { name: 'whitespace text', data: { text: ' \n ' } },
  { name: 'no text or segments', data: { text: undefined } },
  { name: 'missing project wins before missing node', project: '', target: 'missing' },
  { name: 'missing node', target: 'missing' },
  { name: 'wrong node type', target: 'wrong_type' },
  { name: 'busy audio still translates', data: { isGenerating: true } },
  { name: 'empty translation is written', translated: '' },
  { name: 'translation remains untrimmed', translated: ' translated \n' },
  { name: 'operation with attempt', operation: { projectId: 'audio/project', operationId: 'operation', generationAttemptId: 'attempt' } },
  { name: 'operation without attempt omitted', operation: { projectId: 'audio/project', operationId: 'operation' } },
  { name: 'submit failure', fault: 'submit' },
  { name: 'wait failure', fault: 'wait' },
  { name: 'result failure', fault: 'result' },
];

const expected: Record<string, unknown> = {
  "trimmed text and default canvas": {
    "ok": true,
    "request": {
      "method": "POST",
      "path": "projects/audio%2Fproject/freezone/text/translate",
      "body": {
        "text": "Hello world.",
        "node_type": "audio",
        "canvas_id": "default",
        "node_id": "audio-translate"
      }
    }
  },
  "explicit canvas": {
    "ok": true,
    "request": {
      "method": "POST",
      "path": "projects/audio%2Fproject/freezone/text/translate",
      "body": {
        "text": "Hello world.",
        "node_type": "audio",
        "canvas_id": "canvas/2",
        "node_id": "audio-translate"
      }
    }
  },
  "empty canvas remains empty": {
    "ok": true,
    "request": {
      "method": "POST",
      "path": "projects/audio%2Fproject/freezone/text/translate",
      "body": {
        "text": "Hello world.",
        "node_type": "audio",
        "node_id": "audio-translate"
      }
    }
  },
  "legacy segments": {
    "ok": true,
    "request": {
      "method": "POST",
      "path": "projects/audio%2Fproject/freezone/text/translate",
      "body": {
        "text": "first second",
        "node_type": "audio",
        "canvas_id": "default",
        "node_id": "audio-translate"
      }
    }
  },
  "empty string shadows legacy segments": {
    "ok": false,
    "code": "empty_text",
    "message": "音频节点没有可翻译文本"
  },
  "whitespace text": {
    "ok": false,
    "code": "empty_text",
    "message": "音频节点没有可翻译文本"
  },
  "no text or segments": {
    "ok": false,
    "code": "empty_text",
    "message": "音频节点没有可翻译文本"
  },
  "missing project wins before missing node": {
    "ok": false,
    "code": "no_project",
    "message": "缺少项目 ID，无法翻译音频文本"
  },
  "missing node": {
    "ok": false,
    "code": "not_audio_node",
    "message": "音频节点不存在"
  },
  "wrong node type": {
    "ok": false,
    "code": "not_audio_node",
    "message": "音频节点不存在"
  },
  "busy audio still translates": {
    "ok": true,
    "request": {
      "method": "POST",
      "path": "projects/audio%2Fproject/freezone/text/translate",
      "body": {
        "text": "Hello world.",
        "node_type": "audio",
        "canvas_id": "default",
        "node_id": "audio-translate"
      }
    }
  },
  "empty translation is written": {
    "ok": true,
    "request": {
      "method": "POST",
      "path": "projects/audio%2Fproject/freezone/text/translate",
      "body": {
        "text": "Hello world.",
        "node_type": "audio",
        "canvas_id": "default",
        "node_id": "audio-translate"
      }
    }
  },
  "translation remains untrimmed": {
    "ok": true,
    "request": {
      "method": "POST",
      "path": "projects/audio%2Fproject/freezone/text/translate",
      "body": {
        "text": "Hello world.",
        "node_type": "audio",
        "canvas_id": "default",
        "node_id": "audio-translate"
      }
    }
  },
  "operation with attempt": {
    "ok": true,
    "request": {
      "method": "POST",
      "path": "projects/audio%2Fproject/freezone/text/translate",
      "body": {
        "text": "Hello world.",
        "node_type": "audio",
        "canvas_id": "default",
        "node_id": "audio-translate",
        "product_operation_id": "operation",
        "generation_attempt_id": "attempt"
      }
    }
  },
  "operation without attempt omitted": {
    "ok": true,
    "request": {
      "method": "POST",
      "path": "projects/audio%2Fproject/freezone/text/translate",
      "body": {
        "text": "Hello world.",
        "node_type": "audio",
        "canvas_id": "default",
        "node_id": "audio-translate"
      }
    }
  },
  "submit failure": {
    "ok": true,
    "request": {
      "method": "POST",
      "path": "projects/audio%2Fproject/freezone/text/translate",
      "body": {
        "text": "Hello world.",
        "node_type": "audio",
        "canvas_id": "default",
        "node_id": "audio-translate"
      }
    }
  },
  "wait failure": {
    "ok": true,
    "request": {
      "method": "POST",
      "path": "projects/audio%2Fproject/freezone/text/translate",
      "body": {
        "text": "Hello world.",
        "node_type": "audio",
        "canvas_id": "default",
        "node_id": "audio-translate"
      }
    }
  },
  "result failure": {
    "ok": true,
    "request": {
      "method": "POST",
      "path": "projects/audio%2Fproject/freezone/text/translate",
      "body": {
        "text": "Hello world.",
        "node_type": "audio",
        "canvas_id": "default",
        "node_id": "audio-translate"
      }
    }
  }
};

describe('audio translate requests', () => {
  it.each(fixtures)('$name', fixture => {
    const initial: CanvasNode = { id, type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 }, data: {
      text: '  Hello world.  ', audioKind: 'music', model: 'suno_music', musicLengthMs: 30000,
      audioUrl: null, ...fixture.data,
    } };
    const nodes: CanvasNode[] = fixture.target === 'missing' ? [] : fixture.target === 'wrong_type'
      ? [{ id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: 'wrong' } }]
      : [initial];
    const ctx = { nodes, nodeId: id, projectId: fixture.project ?? 'audio/project',
      canvasId: fixture.canvas ?? 'default', productOperation: fixture.operation ?? null };
    const before = structuredClone(ctx);
    const decision = buildAudioTranslateRequest(ctx);
    const literal = expected[fixture.name];
    expect(decision).toStrictEqual(literal);
    expect(JSON.stringify(decision)).toBe(JSON.stringify(literal));
    expect(ctx).toStrictEqual(before);
  });
  it.each([
    { text: '', expected: { text: '' } },
    { text: ' translated \n', expected: { text: ' translated \n' } },
  ])('keeps translated text "$text"', ({ text, expected }) => {
    expect(audioTranslateResultPatch(text)).toStrictEqual(expected);
  });
  it('publishes success and error unchanged', () => {
    expect(audioTranslateActionResult({ text: '' })).toStrictEqual({ status: 'success', output: { text: '' } });
    expect(audioTranslateActionResult({ error: 'Translation unavailable' })).toStrictEqual({ status: 'error', error: 'Translation unavailable' });
  });
});

describe('translation wire serialization', () => {
  it.each([
    { name: 'all falsy', input: { canvasId: '', nodeId: '', modelParams: null, productOperation: null },
      context: {}, body: { text: ' raw ', node_type: 'generic' } },
    { name: 'every field', input: { canvasId: 'canvas/2', nodeId: 'audio-translate',
      modelParams: { temperature: 0 }, productOperation: {
        projectId: 'audio/project', operationId: 'operation', generationAttemptId: 'attempt',
      } }, context: { canvas_id: 'canvas/2', node_id: 'audio-translate', model_params: { temperature: 0 },
        product_operation_id: 'operation', generation_attempt_id: 'attempt' },
      body: { text: ' raw ', node_type: 'generic', canvas_id: 'canvas/2', node_id: 'audio-translate',
        model_params: { temperature: 0 }, product_operation_id: 'operation', generation_attempt_id: 'attempt' } },
    { name: 'missing attempt', input: { canvasId: 'canvas/2', nodeId: 'audio-translate', modelParams: {},
      productOperation: { projectId: 'audio/project', operationId: 'operation' } },
      context: { canvas_id: 'canvas/2', node_id: 'audio-translate', model_params: {} },
      body: { text: ' raw ', node_type: 'generic', canvas_id: 'canvas/2', node_id: 'audio-translate', model_params: {} } },
  ])('$name', ({ input, context, body }) => {
    expect(nodeContextWireFields(input)).toStrictEqual(context);
    expect(JSON.stringify(nodeContextWireFields(input))).toBe(JSON.stringify(context));
    expect(textTranslateWireBody({ text: ' raw ', ...input })).toStrictEqual(body);
    expect(JSON.stringify(textTranslateWireBody({ text: ' raw ', ...input }))).toBe(JSON.stringify(body));
  });
  it('omits null and undefined context and an empty attempt', () => {
    expect(JSON.stringify(nodeContextWireFields({ canvasId: null, nodeId: undefined,
      productOperation: { projectId: 'audio/project', operationId: 'operation', generationAttemptId: '' },
    }))).toBe('{}');
    expect(JSON.stringify(textTranslateWireBody({ text: '', nodeType: 'video', productOperation: null })))
      .toBe('{"text":"","node_type":"video"}');
  });
  it('loads pure imports without browser dependencies', () => {
    const srcRoot = path.resolve(__dirname, '../../..');
    const graph = collectImportGraph(['audioTranslateRequest.ts', 'nodeContextWire.ts'].map(file =>
      path.join(srcRoot, 'features/canvas/application/generationRequests', file)), srcRoot);
    expect([...graph.files].map(file => path.relative(srcRoot, file)).filter(file =>
      file.endsWith('.tsx') || /^(api|lib|stores|hooks|components|routes)\//.test(file))).toStrictEqual([]);
    expect([...graph.packages.keys()].filter(name => !['i18next', 'uuid', 'zustand/vanilla'].includes(name))).toStrictEqual([]);
  });
});
