// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

const BASE_PATH = "/liexiaoren";
const CDN_LOGIN_PATH = "https://nfg-web-assets.cdnfg.com/dramaclaw/login";
const LUBAN_EPISODE_VIDEO_URL =
  "https://nfg-web.oss-cn-chengdu.aliyuncs.com/dramaclaw/luban/luban-ep01.mp4";

export const liexiaorenAssets = {
  entry: {
    mainVideo: `${CDN_LOGIN_PATH}/entry-main.mp4`,
    loopVideo: `${CDN_LOGIN_PATH}/entry-loop.mp4`,
  },
  skin: {
    entryBadge: `${BASE_PATH}/skin/entry-badge.png`,
    entryBadgeVideo: `${CDN_LOGIN_PATH}/entry-badge.mp4`,
    modalFrame: `${BASE_PATH}/skin/modal-frame.png`,
    modalTitle: `${BASE_PATH}/skin/modal-title.png`,
    modalTitleVideo: `${CDN_LOGIN_PATH}/title.mp4`,
    modalPlayButton: `${BASE_PATH}/skin/modal-play-button.png`,
    modalCloseButton: `${BASE_PATH}/skin/modal-close-button.png`,
    modalPrimaryButton: `${BASE_PATH}/skin/modal-primary-button.png`,
    modalSecondaryButton: `${BASE_PATH}/skin/modal-secondary-button.png`,
    modalPreviewVideo: LUBAN_EPISODE_VIDEO_URL,
    modalPreviewPoster: `${BASE_PATH}/skin/modal-preview-poster.jpg`,
    poster: `${BASE_PATH}/skin/poster.png`,
  },
} as const;
