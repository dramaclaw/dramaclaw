// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { toolFixtures } from './toolFixtures';
import { invalidToolFields, malformedToolUnions } from './toolValidationFixtures';

it('serves every tool op and phase with an empty environment', async () => {
  await fs.mkdir('/tmp/c3b', { recursive: true });
  const outDir = await fs.mkdtemp('/tmp/c3b/tool-bundle-');
  try {
    await build({ configFile: path.resolve('vite.canvas-server.config.ts'), build: { outDir } });
    const entry = path.join(outDir, 'canvas-core-worker.mjs');
    expect(await fs.readFile(entry, 'utf8')).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"](?!node:|\.|\/)[@a-z]/);
    const fixtures = await toolFixtures();
    const requests: unknown[] = [], expected: unknown[] = [];
    const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    for (const [index, fixture] of fixtures.entries()) {
      const id = String(index);
      requests.push({ id, op: fixture.op, payload: fixture.payload });
      expected.push({ id, ok: true, result: wire(await fixture.expected()) });
    }
    const invalid = [...new Set(fixtures.map(f => f.op))].map(op => ({ op, payload: {} }));
    for (const [index, fixture] of [...invalid, ...invalidToolFields(fixtures), ...malformedToolUnions].entries()) {
      const id = `invalid-${index}`;
      requests.push({ id, ...fixture });
      expected.push({ id, ok: false, error: { code: 'invalid_request', message: expect.any(String) } });
    }
    requests.push({ id: 'unknown', op: 'unknown' });
    expected.push({ id: 'unknown', ok: false, error: { code: 'invalid_request', message: expect.stringContaining('image_tool_request, image_tool_patch, image_tool_place, audio_translate_request, audio_translate_patch, world_generation_request, world_generation_patch') } });
    requests.push({ id: 'last', op: 'ping' });
    expected.push({ id: 'last', ok: true, result: { pong: true } });
    await fs.writeFile('/tmp/c3b/g3-fixture-counts.json', JSON.stringify({
      parity: Object.fromEntries([...new Set(fixtures.map(f => f.op))].map(op => [op, fixtures.filter(f => f.op === op).length])),
      invalid_fields: invalidToolFields(fixtures).length, malformed_unions: malformedToolUnions.length,
      invalid_ops: invalid.length, response_lines: requests.length,
    }, null, 2));
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
    const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
    for (const response of responses) {
      if (response.ok && response.result?.node?.type === 'exportImageNode') {
        expect(response.result.node.data.createdAt).toEqual(expect.any(Number));
        response.result.node.data.createdAt = 123;
      }
    }
    expect(responses).toStrictEqual(expected);
  } finally { await fs.rm(outDir, { recursive: true, force: true }); }
}, 30000);
