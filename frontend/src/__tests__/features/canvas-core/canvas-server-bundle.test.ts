// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { envelope, initialCanvas } from './parityFixtures';
import { structuralEnvelopes } from './structuralEnvelopes';

it('bundles a standalone React-free worker and serves sequential NDJSON requests with an empty environment', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-server-'));
  try {
    await build({ configFile: path.resolve('vite.canvas-server.config.ts'), build: { outDir } });
    const entry = path.join(outDir, 'canvas-core-worker.mjs');
    const source = await fs.readFile(entry, 'utf8');
    expect(source).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"](?:react|react-dom)(?:['"/])/);
    expect(source).not.toMatch(/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"](?!node:|\.|\/)[@a-z]/);
    const child = spawn(process.execPath, [entry], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const unknownNode = { id: 'unknown', type: 'futureCustomNode', position: { x: 4, y: 5 }, data: { custom: 'preserve me' }, selected: false, customField: 'retained' };
    const knownNode = initialCanvas().nodes[0];
    const unknownEdge = { id: 'extension-edge', source: knownNode.id, target: unknownNode.id, customField: 'retained' };
    child.stdin.end([
      JSON.stringify({ id: 'ping', op: 'ping', payload: {} }),
      'not json',
      JSON.stringify({ id: 'apply', op: 'apply_commands', payload: { canvas: { nodes: [], edges: [] }, envelopes: structuralEnvelopes(), env: { locale: 'en', catalogs: {} } } }),
      JSON.stringify({ id: 'preview', op: 'apply_commands', payload: { canvas: initialCanvas(), envelopes: [], env: { locale: 'en', catalogs: {} } } }),
      JSON.stringify({ id: 'empty', op: 'apply_commands', payload: { canvas: { nodes: [], edges: [] }, envelopes: [], env: { locale: 'en', catalogs: {} } } }),
      JSON.stringify({ id: 'bad-op', op: 'unknown' }),
      JSON.stringify({ id: 'bad-payload', op: 'apply_commands', payload: {} }),
      JSON.stringify({ id: 'last', op: 'ping' }),
      JSON.stringify({ id: 'unknown-node', op: 'apply_commands', payload: { canvas: { nodes: [knownNode, unknownNode], edges: [unknownEdge] }, envelopes: envelope([{ type: 'create_node', node_type: 'textAnnotationNode', data: { content: 'New' } }]), env: { locale: 'en', catalogs: {} } } }),
    ].join('\n') + '\n');
    const timer = setTimeout(() => child.kill(), 20000);
    try { expect(await exit, stderr).toBe(0); } finally { clearTimeout(timer); }
    const lines = stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(9);
    expect(lines[0]).toEqual({ id: 'ping', ok: true, result: { pong: true } });
    expect(lines[1]).toMatchObject({ id: null, ok: false, error: { code: 'invalid_json', message: expect.any(String) } });
    expect(lines[2]).toMatchObject({ id: 'apply', ok: true, result: { status: 'applied', canvas: { nodes: expect.any(Array) }, receipt: { canvas_apply_status: 'applied' } } });
    expect(lines[2].result.canvas.nodes).toHaveLength(3);
    expect(lines[3]).toMatchObject({ id: 'preview', ok: true });
    expect(stderr).toContain('stripped base64 previewImageUrl');
    expect(lines[4].result.canvas.nodes).toEqual([]);
    expect(lines[5]).toMatchObject({ id: 'bad-op', ok: false, error: { code: 'invalid_request' } });
    expect(lines[6]).toMatchObject({ id: 'bad-payload', ok: false, error: { code: 'invalid_request' } });
    expect(lines[7]).toEqual({ id: 'last', ok: true, result: { pong: true } });
    expect(lines[8]).toMatchObject({ id: 'unknown-node', ok: true, result: { status: 'applied' } });
    expect(lines[8].result.canvas.nodes).toHaveLength(3);
    expect(lines[8].result.canvas.nodes.find((node: { id: string }) => node.id === unknownNode.id)).toEqual(unknownNode);
    expect(lines[8].result.canvas.edges).toEqual([unknownEdge]);
    expect(lines[8].result.changes.updated_node_ids).toEqual([]);
  } finally { await fs.rm(outDir, { recursive: true, force: true }); }
}, 30000);
