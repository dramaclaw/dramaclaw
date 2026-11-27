// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { IdGenerator } from '../application/ports';
import type { CanvasCommandEnvironment } from '../core/commands/executor';
import type { CanvasEnvironment } from '../core/environment';
import {
  videoReferenceEnvelopeInCatalog,
  type VideoReferenceCatalogModel,
} from '../domain/videoReferenceLimits';
import { uuidGenerator } from './idGenerator';

type Translate = CanvasEnvironment['translate'];

export interface NodeCanvasEnvironmentOptions {
  /** Resolves UI copy written into node data; Node has no loaded locale of its own. */
  translate: Translate;
  /** Defaults to random UUIDs, as in the browser. */
  ids?: IdGenerator;
  now?: () => number;
  /** Video model catalog for reference limits; without one the default limits apply. */
  videoModels?: readonly VideoReferenceCatalogModel[];
  /** Video model new video nodes start from; without one they use the default model. */
  lastVideoModel?: string | null;
}

/** Canvas store environment for a host with no browser, such as a server-side worker. */
export function createNodeCanvasEnvironment(
  options: NodeCanvasEnvironmentOptions,
): CanvasEnvironment {
  const videoModels = options.videoModels ?? [];
  return {
    ids: options.ids ?? uuidGenerator,
    now: options.now,
    translate: options.translate,
    // No bookkeeping or running work lives outside the store on this host.
    onCanvasReplaced: () => {},
    onNodeDeleted: () => {},
    videoReferenceEnvelope: (videoNode) => videoReferenceEnvelopeInCatalog(videoNode, videoModels),
    lastVideoModel: () => options.lastVideoModel ?? null,
  };
}

export interface NodeCanvasCommandEnvironmentOptions
  extends Partial<Pick<CanvasCommandEnvironment, 'landSceneEdit' | 'onNodeDataUpdated' |
    'removeProjection'>> {
  translate: Translate;
  /** Command validation is required: nothing is applied without it. */
  validate: CanvasCommandEnvironment['validate'];
}

/** Command executor environment for a host with no browser. */
export function createNodeCanvasCommandEnvironment(
  options: NodeCanvasCommandEnvironmentOptions,
): CanvasCommandEnvironment {
  return {
    translate: options.translate,
    validate: options.validate,
    // Nothing is rendered, so no measured sizes ever arrive; layout keeps its first pass.
    afterNodesMeasured: () => {},
    removeProjection: options.removeProjection ?? (() => {}),
    landSceneEdit: options.landSceneEdit ?? (() => {
      throw new Error('previz scene edits are not available on this host');
    }),
    onNodeDataUpdated: options.onNodeDataUpdated ?? (() => {}),
  };
}
