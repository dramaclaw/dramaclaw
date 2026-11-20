// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { Fixture } from './toolFixtures';

export function invalidToolFields(fixtures: Fixture[]) {
  const cases: { name: string; op: string; payload: unknown }[] = [];
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    function visit(value: unknown, path: string[]) {
      const field = path[path.length - 1];
      if (field && !['image_models', 'body'].includes(field) && (field !== 'result' || fixture.payload.phase === 'output_resolution')) {
        const key = `${fixture.op}:${fixture.payload.phase ?? ''}:${path.join('.')}:${typeof value}:${value === null}`;
        if (!seen.has(key)) {
          seen.add(key);
          const payload = structuredClone(fixture.payload);
          let target: unknown = payload;
          for (const part of path.slice(0, -1)) target = (target as Record<string, unknown>)[part];
          (target as Record<string, unknown>)[field] = typeof value === 'string' ? 7 : typeof value === 'number' ? Infinity
            : typeof value === 'boolean' ? 'yes' : Array.isArray(value) ? {} : value === null || value === undefined ? 7 : [];
          cases.push({ name: key, op: fixture.op, payload });
        }
      }
      if (['data', 'node_data', 'image_models', 'body', 'current_sources'].includes(field)) return;
      if (field === 'result' && fixture.payload.phase !== 'output_resolution') return;
      if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
    visit(fixture.payload, []);
  }
  return cases;
}
export const malformedToolUnions = [
  { op: 'image_tool_request', payload: { action: 'unknown' } },
  { op: 'image_tool_patch', payload: { phase: 'other' } },
  { op: 'image_tool_patch', payload: { phase: 'success', action: 'unknown', url: '' } },
  { op: 'image_tool_patch', payload: { phase: 'action_result', message: '', action: 'run_outpaint_tool' } },
  { op: 'image_tool_patch', payload: { phase: 'action_result', action: 'run_scene360_tool', child_node_id: 'child', url: '', task: { task_key: '', task_type: '', job_id: '' } } },
  { op: 'image_tool_patch', payload: { phase: 'output_resolution', task: { task_key: '', task_type: '', job_id: '' }, result: { output_url: 7 } } },
  { op: 'audio_translate_patch', payload: { phase: 'other' } },
  { op: 'audio_translate_patch', payload: { phase: 'action_result', text: '', error: '' } },
  { op: 'audio_translate_patch', payload: { phase: 'action_result' } },
  { op: 'world_generation_patch', payload: { phase: 'other' } },
  { op: 'world_generation_patch', payload: { phase: 'failure', outcome: { kind: 'unknown' } } },
  { op: 'world_generation_patch', payload: { phase: 'failure', outcome: { kind: 'poll_timeout', message: '' } } },
  { op: 'world_generation_patch', payload: { phase: 'action_result', error: '', output: {} } },
  { op: 'world_generation_patch', payload: { phase: 'source_kind', source_node: null, visible_source_kind: 'reverse' } },
];
