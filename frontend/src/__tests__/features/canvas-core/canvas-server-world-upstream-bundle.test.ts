// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { selectWorldGenerationUpstream } from '@/features/canvas/application/generationRequests';
import { workerWorldUpstreamFixtures, invalidWorldUpstreamPayloads, worldId } from './worldUpstreamFixtures';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
it('serves upstream selection with an empty environment', async () => {
  await fs.mkdir('/tmp/c3b', { recursive: true });
  const outDir = await fs.mkdtemp('/tmp/c3b/world-upstream-bundle-');
  try {
    await build({ configFile: path.resolve('vite.canvas-server.config.ts'), build: { outDir } });
    const entry = path.join(outDir, 'canvas-core-worker.mjs');
    expect(await fs.readFile(entry, 'utf8')).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"](?!node:|\.|\/)[@a-z]/);
    const requests: unknown[] = [], expected: unknown[] = [];
    for (const [i, { canvas }] of workerWorldUpstreamFixtures.entries()) {
      const id = String(i);
      requests.push({ id, op: 'world_generation_upstream', payload: { canvas, node_id: worldId, ...(i % 2 ? { env: { locale: 'zh' } } : {}) } });
      expected.push({ id, ok: true, result: JSON.parse(JSON.stringify(selectWorldGenerationUpstream({ ...canvas, nodeId: worldId }))) });
    }
    for (const [i, payload] of invalidWorldUpstreamPayloads.entries()) {
      const id = `invalid-${i}`;
      requests.push({ id, op: 'world_generation_upstream', payload });
      expected.push({ id, ok: false, error: { code: 'invalid_request', message: expect.any(String) } });
    }
    requests.push({ id: 'last', op: 'ping' });
    expected.push({ id: 'last', ok: true, result: { pong: true } });
    const fetchGuard = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => { throw new Error("Unexpected fetch"); };');
    const child = spawn(process.execPath, ['--import', fetchGuard, entry], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
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
