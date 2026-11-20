// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The canvas core: a store built from a host environment and the executor that
 * applies agent canvas commands to it. Nothing here needs a browser; hosts supply
 * their side through `CanvasEnvironment` and `CanvasCommandEnvironment`.
 */
export { createCanvasStore } from './canvasStore';
export type { CanvasState, CanvasStoreApi } from './canvasStore';
export type { CanvasEnvironment } from './environment';
export {
  applyCanvasCommands,
  applyCanvasCommandsAsync,
  applyCanvasCommandsNow,
  normalizeCanvasCommandEnvelopes,
} from './commands/executor';
export type {
  CanvasCommandEnvironment,
  CanvasCommandExecution,
  CanvasCommandHandler,
  CanvasCommandHandlerContext,
  CanvasCommandHandlers,
  HostCanvasCommandType,
} from './commands/executor';
export { CANVAS_CHAT_COMMANDS_SCHEMA_VERSION } from './commands/types';
export type {
  CanvasChatCommand,
  CanvasChatCommandApplyResult,
  CanvasChatCommandApplyStep,
  CanvasChatCommandEnvelope,
} from './commands/types';
