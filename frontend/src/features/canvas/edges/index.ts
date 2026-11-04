// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { EdgeTypes } from '@xyflow/react';

import { DisconnectableEdge } from './DisconnectableEdge';
import { StoryChoiceEdge } from './StoryChoiceEdge';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';

export const edgeTypes: EdgeTypes = {
  disconnectableEdge: DisconnectableEdge,
  [STORY_CHOICE_EDGE_TYPE]: StoryChoiceEdge,
};
