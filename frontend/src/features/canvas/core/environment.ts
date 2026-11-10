// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { IdGenerator } from '@/features/canvas/application/ports';

/**
 * Everything the canvas core needs from its host. The browser implementation
 * lives in `infrastructure/browserCanvasEnvironment.ts`; the canvas core never
 * reaches for browser globals or app singletons directly.
 */
export interface CanvasEnvironment {
  /** Issues ids for nodes the core creates. */
  ids: IdGenerator;
  /** Resolves UI copy the core writes into node data, such as default group names. */
  translate(key: string, options?: Record<string, unknown>): string;
  /** A canvas was loaded or cleared; per-canvas bookkeeping kept outside the store is stale. */
  onCanvasReplaced(): void;
  /** A node left the canvas; work still running against it should stop. */
  onNodeDeleted(nodeId: string): void;
}
