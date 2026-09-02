// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 脱离 React 的模块（纯函数、能力表、派生逻辑）需要把 `t` 当参数传进去。
 * 这里只约束调用形状，不依赖 react-i18next 的具体类型，单测里可以直接塞一个假的。
 */
export type TFn = (key: string, options?: Record<string, unknown>) => string;
