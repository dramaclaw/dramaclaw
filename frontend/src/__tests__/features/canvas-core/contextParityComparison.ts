// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

export function compareContextParity(result: unknown, update = false) {
  const file = path.resolve(__dirname, '__parity__/context-reads.json');
  const json = JSON.parse(JSON.stringify(result));
  if (update) fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  expect(json).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
}
