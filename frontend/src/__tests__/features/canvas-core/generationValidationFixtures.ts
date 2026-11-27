// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { Fixture } from './generationFixtures';

// Opaque node data and response bodies are owned by the pure functions.
const opaque = new Set(['node_data', 'final_node_data', 'latest_node_data', 'result', 'output', 'body', 'actual', 'expected', 'data', 'patch']);
export function invalidFields(fixtures: Fixture[]) {
  const invalid: { name: string; op: string; payload: unknown }[] = [];
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    function walk(value: unknown, path: (string | number)[]) {
      const field = String(path[path.length - 1]);
      if (path.length && !['actual', 'expected', 'body', 'video', 'image'].includes(field)) {
        const key = `${fixture.op}:${fixture.payload.phase ?? ''}:${path.join('.')}:${typeof value}:${value === null}`;
        if (!seen.has(key)) {
          seen.add(key);
          const payload = structuredClone(fixture.payload);
          let target: unknown = payload;
          for (const part of path.slice(0, -1)) target = (target as Record<string, unknown>)[part];
          // A wrong primitive type also catches omitted optional fields without depending on messages.
          (target as Record<string, unknown>)[field] = typeof value === 'string' ? 17 : typeof value === 'number' ? Infinity : typeof value === 'boolean' ? 'yes' : value === undefined ? 17 : value === null ? true : [];
          if (Array.isArray(value)) (target as Record<string, unknown>)[field] = {};
          invalid.push({ name: key, op: fixture.op, payload });
        }
      }
      if (opaque.has(field) || field === 'video' || field === 'image') return;
      if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
        if (field === 'media_durations_ms') { walk(child, [...path, key]); continue; }
        walk(child, [...path, Array.isArray(value) ? Number(key) : key]);
      }
    }
    walk(fixture.payload, []);
  }
  return invalid;
}
