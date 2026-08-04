// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 虾导（AI 助手）临时下线开关 —— 功能优化完成后把这里改回 true 就整体恢复，
// 不需要动调用点。当前关闭时的表现：
// - 虾画画布：右下角虾导入口按钮和侧边聊天面板都不渲染；
// - 虾集 → 虾导：顶栏 tab 保留，页面里的聊天区换成「升级中」占位。
// 显式标注 boolean（而不是让 TS 收敛成字面量 false），否则调用点的另一分支会被
// 判成死代码，import 跟着变成「未使用」。
export const XIADAO_ENABLED: boolean = false;
