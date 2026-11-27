// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Entry for running the canvas core outside the browser: the core API plus the
 * environment for a host without a view. `node-entry-imports.test.ts` keeps its
 * import graph free of React, the DOM and the network client.
 */
export * from './core';
export {
  createNodeCanvasCommandEnvironment,
  createNodeCanvasEnvironment,
} from './infrastructure/nodeCanvasEnvironment';
export type {
  NodeCanvasCommandEnvironmentOptions,
  NodeCanvasEnvironmentOptions,
} from './infrastructure/nodeCanvasEnvironment';
