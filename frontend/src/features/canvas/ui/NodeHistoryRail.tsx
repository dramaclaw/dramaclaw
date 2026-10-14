// SPDX-License-Identifier: Elastic-2.0
import { NodeGenerationHistory, type NodeGenerationHistoryProps } from './NodeGenerationHistory';
import { CANVAS_NODE_OPS_PANEL_CLASS } from './nodeFrameStyles';

/** Anchored inside the operations panel so adaptive panel widths stay aligned. */
export function NodeHistoryRail(props: Omit<NodeGenerationHistoryProps, 'layout' | 'className'>) {
  return <div data-node-history-rail className={`nodrag absolute left-full top-0 z-10 ml-3 flex max-h-full w-[88px] flex-col rounded-[var(--node-radius)] px-2 py-2 ${CANVAS_NODE_OPS_PANEL_CLASS}`}
    onClick={event => event.stopPropagation()}>
    <NodeGenerationHistory {...props} layout="vertical" />
  </div>;
}
