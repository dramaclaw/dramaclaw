// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 产品配额。后端目前对这两项都没有上限（画布保存走 PUT，不数个数；grants 也不
 * 数人头），所以这里是唯一的拦截点 —— 它挡的是误操作，不是恶意调用。真要设成
 * 安全边界，得在 `put_canvas` 和 grants 端点各加一次服务端校验。
 */

/** 单个用户在一个项目里能创建的画布数上限（只算本人手动新建的空白画布）。 */
export const MAX_USER_CREATED_CANVASES_PER_PROJECT = 25;

/** 一个项目最多能分享给多少人（不含所有者本人）。 */
export const MAX_PROJECT_GRANTS = 25;
