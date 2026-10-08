// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Position } from '@xyflow/react';

export const NODE_TOOLBAR_POSITION = Position.Top;
export const NODE_TOOLBAR_ALIGN = 'center' as const;
// 32px：LibTV 视频节点工具条到节点顶边的实测间距（他们同样是居中对齐）。
export const NODE_TOOLBAR_OFFSET = 32;
export const NODE_TOOLBAR_CLASS = 'pointer-events-auto';
