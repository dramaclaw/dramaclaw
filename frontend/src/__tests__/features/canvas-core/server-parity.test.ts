// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { it, expect } from 'vitest';
import { applyCommands } from '@/features/canvas/server/applyCommands';
import { parityBatches, initialCanvas, deterministicIds } from './parityFixtures';
import { compareParity } from './parityComparison';

it.each(parityBatches)('Node matches the browser snapshot: $name', async batch => {
  const result = await applyCommands(initialCanvas(), batch.commands, { locale: 'en', catalogs: {}, ids: deterministicIds(), now: () => 1730000000000 });
  expect(result.status).toBe('applied');
  expect(result.receipt.errors).toEqual([]);
  compareParity(batch.name, result.canvas, 'layout' in batch && batch.layout);
});
