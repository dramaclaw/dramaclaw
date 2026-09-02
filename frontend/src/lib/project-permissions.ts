// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 这里取的是 i18next 默认实例（`@/i18n` 初始化的就是它）。不 import `@/i18n`
// 本身，是因为那个模块会顺带拉进 react-i18next / HttpBackend，把它塞进这条被
// 到处 import 的底层链路上，会让所有 mock 掉 react-i18next 的测试在 import 期炸掉。
import i18n from "i18next";

import { isCeRuntime } from "@/lib/runtime-config";
import type { ProjectRole, ProjectSummary } from "@/types/project";

const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 10,
  editor: 20,
  admin: 30,
  owner: 40,
};

export function projectRole(summary: ProjectSummary): ProjectRole {
  return summary.effectiveRole ?? "owner";
}

export function roleAllows(actual: ProjectRole | undefined, required: ProjectRole): boolean {
  return ROLE_RANK[actual ?? "viewer"] >= ROLE_RANK[required];
}

export function canManageProjectGrants(summary: ProjectSummary): boolean {
  // CE 没有项目分享/grants 概念（AllowAllProjectAccess 恒返回 owner，角色门控会误显
  // EE-only 入口）。edition 门控走运行时 isCeRuntime()，与 credit-balance-badge 同机制。
  if (isCeRuntime()) return false;
  return roleAllows(projectRole(summary), "admin");
}

export function canDeleteProject(summary: ProjectSummary): boolean {
  return projectRole(summary) === "owner";
}

export function isSharedProject(summary: ProjectSummary): boolean {
  return projectRole(summary) !== "owner";
}

export function projectRoleLabel(role: ProjectRole | undefined): string {
  switch (role ?? "owner") {
    case "viewer":
      return i18n.t("project.role.viewer");
    case "editor":
      return i18n.t("project.role.editor");
    case "admin":
      return i18n.t("project.role.admin");
    case "owner":
      return i18n.t("project.role.owner");
  }
}

