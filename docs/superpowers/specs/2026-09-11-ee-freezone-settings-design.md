# EE 虾画设置入口恢复设计

## 背景

当前 `staging` 的 Header 只在 CE 运行时渲染设置按钮和 `SettingsDialog`。这使 EE 用户无法进入虾画 Skills 设置。历史 `freezone-canvas` 实现曾允许 EE 打开设置，但只展示虾画 Skills，不展示 CE 本地部署专用的模型与渠道、媒体存储页面。

设置弹窗当前已经具备正确的运行时隔离：CE 默认进入模型配置并展示全部设置页；EE 默认进入虾画 Skills，并隐藏模型与渠道、媒体存储。因此回归位于 Header 的入口和弹窗挂载门控，而不是弹窗页面权限逻辑。

## 目标行为

- CE 继续显示设置按钮，并可访问模型与渠道、媒体存储、虾画 Skills。
- EE 显示同一个设置按钮，点击后打开同一个设置弹窗。
- EE 弹窗只显示虾画 Skills；Recipes 继续通过 Skills 的高级管理入口访问。
- EE 不请求 CE 专用的模型网关状态接口。
- 不改变设置按钮样式、位置和警告气泡逻辑。

## 实现方案

移除 `frontend/src/components/layout/header.tsx` 中设置按钮外层的 `ceRuntime` 条件渲染，并始终挂载 `SettingsDialog`。保留 `frontend/src/components/settings/settings-dialog.tsx` 现有的运行时页面过滤和查询门控，不复制 EE 专用弹窗，也不回放整个历史提交，以免覆盖 `staging` 后续的 Header 演进。

## 测试策略

在 Header 组件测试中 mock `SettingsDialog`，新增 EE 回归用例：运行时为 EE 时设置按钮存在，点击后弹窗打开。继续运行设置弹窗的现有用例，确认 EE 隐藏模型与渠道、媒体存储且默认显示虾画 Skills；同时执行前端类型检查/生产构建。

## 非目标

- 不向 EE 暴露 CE 的模型与渠道或媒体存储配置。
- 不调整设置弹窗的视觉设计或文案。
- 不修改后端 API、鉴权或组织权限。
