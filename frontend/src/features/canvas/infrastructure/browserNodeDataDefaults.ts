// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readLastVideoModel } from '../domain/lastVideoModel';
import type { NodeDataDefaults } from '../domain/nodeRegistry';

/** New node data in the browser starts from the video model kept in local storage. */
export const browserNodeDataDefaults: NodeDataDefaults = {
  lastVideoModel: () => readLastVideoModel(),
};
