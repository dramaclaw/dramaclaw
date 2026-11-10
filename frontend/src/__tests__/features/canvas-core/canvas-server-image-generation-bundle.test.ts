// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import { expect, it } from 'vitest';
import * as pure from '@/features/canvas/application/generationRequests';
import { compileMetadata, outcomeInput, outcomePayload, outcomes, requestContext, requestPayload, task, wire } from './imageGenerationFixtures';

it('serves pure image generation requests and patches from a standalone worker with an empty environment', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-image-generation-'));
  try {
    await build({ configFile: path.resolve('vite.canvas-server.config.ts'), build: { outDir } });
    const entry = path.join(outDir, 'canvas-core-worker.mjs');
    const source = await fs.readFile(entry, 'utf8');
    expect(source).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"](?:react|react-dom)(?:['"/])/);
    expect(source).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"](?!node:|\.|\/)[@a-z]/);
    const requests: unknown[] = [{ id: 'ping', op: 'ping' }];
    const expected: unknown[] = [{ id: 'ping', ok: true, result: { pong: true } }];
    const add = (id: string, op: string, payload: unknown, result: unknown) => {
      requests.push({ id, op, payload });
      expected.push({ id, ok: true, result: wire(result) });
    };
    for (const withReference of [false, true]) {
      const input = requestPayload(withReference);
      const context = requestContext(input);
      const compile_input = pure.imagePromptCompileInput(context);
      add(`request-${withReference}`, 'image_generation_request', input, {
        compile_input, request: pure.buildImageGenerationRequest({ ...context, prompt: compile_input.fallbackPrompt }),
      });
    }
    add('start', 'image_generation_patch', { phase: 'start', started_at_ms: 123 }, pure.imageGenerationStartPatch(123));
    add('submit', 'image_generation_patch', { phase: 'submit', started_at_ms: 456 }, pure.imageGenerationSubmitPatch(456));
    add('accepted', 'image_generation_patch', { phase: 'accepted', task }, pure.imageGenerationAcceptedPatch(task));
    add('metadata', 'image_generation_patch', { phase: 'compile_metadata', metadata: compileMetadata, compiled_at: 'caller-time' },
      pure.imagePromptCompileMetadataPatch(compileMetadata, 'caller-time'));
    for (const [index, outcome] of outcomes.entries()) {
      const input = outcomePayload(outcome, index % 2 ? 'zh' : 'en');
      add(`outcome-${index}`, 'image_generation_patch', input, pure.imageGenerationOutcomePatch(await outcomeInput(input)));
    }
    for (const op of ['image_generation_request', 'image_generation_patch']) {
      const id = `invalid-${op}`;
      requests.push({ id, op, payload: {} });
      expected.push({ id, ok: false, error: { code: 'invalid_request', message: expect.any(String) } });
    }
    // Invalid input must not prevent the next request from completing.
    requests.push({ id: 'last', op: 'ping' });
    expected.push({ id: 'last', ok: true, result: { pong: true } });
    const child = spawn(process.execPath, [entry], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const timer = setTimeout(() => child.kill(), 20000);
    try {
      child.stdin.end(requests.map(request => JSON.stringify(request)).join('\n') + '\n');
      expect(await exit, stderr).toBe(0);
    } finally { clearTimeout(timer); }
    expect(stderr).toBe('');
    expect(stdout.trim().split('\n').map(line => JSON.parse(line))).toEqual(expected);
  } finally { await fs.rm(outDir, { recursive: true, force: true }); }
}, 30000);
