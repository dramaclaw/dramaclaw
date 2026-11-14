// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { materializeFixtures } from './generationFixtures';
import { invalidFields } from './generationValidationFixtures';
import { wire } from './imageGenerationFixtures';

it('serves all generation operations and phases with an empty environment', async () => {
  await fs.mkdir('/tmp/c3b', { recursive: true });
  const outDir = await fs.mkdtemp('/tmp/c3b/generation-bundle-');
  try {
    await build({ configFile: path.resolve('vite.canvas-server.config.ts'), build: { outDir } });
    const entry = path.join(outDir, 'canvas-core-worker.mjs');
    const source = await fs.readFile(entry, 'utf8');
    expect(source).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"](?!node:|\.|\/)[@a-z]/);
    const requests: unknown[] = [], expected: unknown[] = [];
    const fixtures = await materializeFixtures();
    for (const [index, fixture] of fixtures.entries()) {
      const id = String(index);
      requests.push({ id, op: fixture.op, payload: fixture.payload });
      expected.push({ id, ok: true, result: wire(await fixture.expected()) });
    }
    await fs.writeFile('/tmp/c3b/f-fixtures.json', JSON.stringify({
      parity: fixtures.map((fixture, index) => ({ name: fixture.name, op: fixture.op, payload: fixture.payload, response: expected[index] })),
      invalid_fields: invalidFields(fixtures),
      invalid_ops: [...new Set(fixtures.map(f => f.op))].map(op => ({ op, payload: {} })),
      trailing_ping: { id: 'last', op: 'ping' },
    }, (_key, value) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value, 2) + '\n');
    for (const op of [...new Set(fixtures.map(f => f.op))]) {
      const id = `invalid-${op}`;
      requests.push({ id, op, payload: {} });
      expected.push({ id, ok: false, error: { code: 'invalid_request', message: expect.any(String) } });
    }
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
    expect(stdout.trim().split('\n').map(line => JSON.parse(line))).toStrictEqual(expected);
  } finally { await fs.rm(outDir, { recursive: true, force: true }); }
}, 30000);
