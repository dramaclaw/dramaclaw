// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasChatCommandApplyResult } from '@/features/canvas/core/commands/types';

export const CANVAS_COMMAND_VALIDATION_FAILURE_MESSAGE = "画布命令预校验失败，前端未展示确认卡，也未执行。";

export function canvasCommandValidationFailureResult(errors: string[]): CanvasChatCommandApplyResult {
  return {
    applied: 0,
    openedUiActions: 0,
    createdNodeIds: [],
    errors,
    commandResults: [
      {
        commandIndex: -1,
        type: "validate",
        status: "error",
        label: "校验画布命令",
        error: errors.join("; "),
      },
    ],
  };
}

