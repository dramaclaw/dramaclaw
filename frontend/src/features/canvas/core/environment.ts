// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { IdGenerator } from '@/features/canvas/application/ports';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { NodeDataDefaults } from '@/features/canvas/domain/nodeRegistry';
import type { VideoReferenceEnvelope } from '@/features/canvas/domain/videoReferenceLimits';

/**
 * Everything the canvas core needs from its host. The browser implementation
 * lives in `infrastructure/browserCanvasEnvironment.ts` and the Node one in
 * `infrastructure/nodeCanvasEnvironment.ts`; the canvas core never reaches for
 * browser globals or app singletons directly.
 */
export interface CanvasEnvironment extends NodeDataDefaults {
  /** Issues ids for nodes the core creates. */
  ids: IdGenerator;
  /** Resolves UI copy the core writes into node data, such as default group names. */
  translate(key: string, options?: Record<string, unknown>): string;
  /** A canvas was loaded or cleared; per-canvas bookkeeping kept outside the store is stale. */
  onCanvasReplaced(): void;
  /** A node left the canvas; work still running against it should stop. */
  onNodeDeleted(nodeId: string): void;
  /** Reference limits of the model a video node has selected, from the host's model catalog. */
  videoReferenceEnvelope(videoNode: CanvasNode): VideoReferenceEnvelope;
}
