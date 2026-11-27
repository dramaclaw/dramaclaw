// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 产品配额。画布上限由服务端创建路由 `canvases:create` 强制执行，浏览器计数仅用于
 * 请求前解释上限。grants 服务端仍不限制人数。
 */

/** 单个用户在一个项目里能创建的画布数上限（只算本人手动新建的空白画布）。 */
export const MAX_USER_CREATED_CANVASES_PER_PROJECT = 25;

/** 一个项目最多能分享给多少人（不含所有者本人）。 */
export const MAX_PROJECT_GRANTS = 25;
