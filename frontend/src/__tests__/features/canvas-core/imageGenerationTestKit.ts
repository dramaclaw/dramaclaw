// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { expect } from 'vitest';
import literals from './imageGenerationExpected.json';

export const expectedEntries: Record<string, Record<string, unknown>> = literals;

export function normalized(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) =>
    item === undefined ? '__undefined__' : item));
}

const observedFields = new Map<string, Set<string>>();

export function assertObserved(key: string, actual: Record<string, unknown>) {
  const expected = expectedEntries[key];
  expect(expected, key).toBeDefined();
  const fields = observedFields.get(key) ?? new Set<string>();
  observedFields.set(key, fields);
  for (const [field, value] of Object.entries(actual)) {
    expect(Object.prototype.hasOwnProperty.call(expected, field), `${key}/${field}`).toBe(true);
    fields.add(field);
    expect(normalized(value), `${key}/${field}`).toStrictEqual(expected[field]);
  }
}

export const translate = (key: string) => `translated:${key}`;
export const errorTranslate = (key: string, options?: Record<string, unknown>) =>
  JSON.stringify([key, options ?? null]);

// These observations belong to browser IO, guards or scheduling, not the pure protocol.
const browserOnlyFields: Record<string, string[]> = {
  'request/inline reference upload': ['upload'],
  'request/reference limit blocks submit': ['submitResult', 'submitDisabled'],
  'settle/workflow batch variants forces completed despite submitted request': ['finishedBeforeCompletion'],
  'settle/count 3 failure after success': ['albumBefore', 'albumAfter', 'waitingOutput'],
  'settle/count 3 all fail in different rejection order': ['albumBefore', 'albumAfter', 'waitingOutput'],
  'settle/all runs ignored after invalidation': ['albumBefore', 'albumAfter', 'waitingOutput'],
};

export function assertCaptureCoverage(groups: string[]) {
  for (const [key, entry] of Object.entries(expectedEntries)) {
    if (!groups.includes(key.split('/')[0])) continue;
    const asserted = [...(observedFields.get(key) ?? [])];
    expect(asserted.length, key).toBeGreaterThan(0);
    expect([...asserted, ...(browserOnlyFields[key] ?? [])].sort(), key)
      .toStrictEqual(Object.keys(entry).sort());
  }
}
