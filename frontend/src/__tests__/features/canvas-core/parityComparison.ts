// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { getNodeSize } from '@/features/canvas/application/autoLayout';
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';

type SavedCanvas = { nodes: CanvasNode[]; edges: CanvasEdge[] };
export function compareParity(name: string, actual: { nodes: unknown[]; edges: unknown[] }, layout = false, update = false) {
  const file = path.resolve(__dirname, '__parity__', `${name}.json`);
  const json: SavedCanvas = JSON.parse(JSON.stringify(actual));
  if (update) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  }
  const expected: SavedCanvas = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(json.edges).toEqual(expected.edges);
  expect(json.nodes.map(n => n.id)).toEqual(expected.nodes.map(n => n.id));
  json.nodes.forEach((node, index) => {
    const reference = expected.nodes[index];
    if (layout) {
      const { width, height } = getNodeSize({ ...reference, measured: undefined, width: undefined, height: undefined, style: undefined });
      expect(Math.abs(node.position.x - reference.position.x)).toBeLessThanOrEqual(width);
      expect(Math.abs(node.position.y - reference.position.y)).toBeLessThanOrEqual(height);
      expect({ ...node, position: reference.position }).toEqual(reference);
    } else expect(node).toEqual(reference);
  });
}
