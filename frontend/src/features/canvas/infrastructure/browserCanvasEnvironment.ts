// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 这里取的是 i18next 默认实例（`@/i18n` 初始化的就是它）。不 import `@/i18n`
// 本身，是因为那个模块会顺带拉进 react-i18next / HttpBackend，把它塞进这条被
// 到处 import 的底层链路上，会让所有 mock 掉 react-i18next 的测试在 import 期炸掉。
import i18n from 'i18next';

import { resetStyleNodeSyncStates } from '../application/styleNodeSync';
import { videoReferenceEnvelopeForNode } from '../application/videoReferenceEnvelope';
import { cancelVideoCrop } from '../application/videoCrop/videoCropInFlight';
import type { CanvasEnvironment } from '../core/environment';
import { browserNodeDataDefaults } from './browserNodeDataDefaults';
import { uuidGenerator } from './idGenerator';

export const browserCanvasEnvironment: CanvasEnvironment = {
  ids: uuidGenerator,
  translate: (key, options) => i18n.t(key, options),
  onCanvasReplaced: resetStyleNodeSyncStates,
  onNodeDeleted: cancelVideoCrop,
  // Both read browser state at call time: the video model catalog the app fetched,
  // and the video model the user picked last.
  videoReferenceEnvelope: (videoNode) => videoReferenceEnvelopeForNode(videoNode),
  lastVideoModel: () => browserNodeDataDefaults.lastVideoModel(),
};
