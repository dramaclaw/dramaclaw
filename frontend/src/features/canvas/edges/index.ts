// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { EdgeTypes } from '@xyflow/react';

import { DisconnectableEdge } from './DisconnectableEdge';
import { DefaultCanvasEdge } from './DefaultCanvasEdge';

export const edgeTypes: EdgeTypes = {
  default: DefaultCanvasEdge,
  disconnectableEdge: DisconnectableEdge,
};
