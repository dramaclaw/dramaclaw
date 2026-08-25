// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareProjectDialog } from "@/components/projects/share-project-dialog";
import type { ProjectSummary } from "@/types/project";

const SHARE_DIALOG_ZH: Record<string, string> = {
  "project.shareDialog.title": "共享项目",
  "project.shareDialog.descriptionWithOwner": "{{name}} · {{owner}}",
  "project.shareDialog.descriptionFallback": "管理项目成员",
  "project.shareDialog.currentUserFallback": "当前用户",
  "project.shareDialog.addMember": "添加成员",
  "project.shareDialog.addMemberHint": "输入用户名，选择权限后加入项目。",
  "project.shareDialog.copyLink": "复制链接",
  "project.shareDialog.searchPlaceholder": "搜索用户名",
  "project.shareDialog.alreadyInProject": "已在项目中",
  "project.shareDialog.add": "添加",
  "project.shareDialog.members": "成员",
  "project.shareDialog.owner": "所有者",
  "project.shareDialog.projectOwner": "项目所有者",
  "project.shareDialog.loadingMembers": "加载成员",
  "project.shareDialog.removeMember": "移除成员",
  "project.shareDialog.roleViewer": "只读查看",
  "project.shareDialog.roleEditor": "可编辑与运行任务",
  "project.shareDialog.roleAdmin": "可管理共享成员",
  "project.shareDialog.inactive": "已失效",
  "project.shareDialog.inactiveScopeChanged": "用户作用域已变化",
  "common.close": "关闭",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let value = SHARE_DIALOG_ZH[key] ?? key;
      if (options) {
        for (const [optKey, optValue] of Object.entries(options)) {
          value = value.split(`{{${optKey}}}`).join(String(optValue));
        }
      }
      return value;
    },
  }),
}));

const runtimeState = vi.hoisted(() => ({ isCeRuntime: false }));
const queryMocks = vi.hoisted(() => ({
  grants: [] as Array<Record<string, unknown>>,
  deleteGrant: vi.fn(),
  useUserSearch: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
}));

vi.mock("@/lib/queries/projects", () => ({
  useProjectGrants: () => ({
    data: { data: queryMocks.grants },
    isLoading: false,
  }),
  useUserSearch: (...args: unknown[]) => {
    queryMocks.useUserSearch(...args);
    return { data: { data: [] } };
  },
  useAddProjectGrant: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateProjectGrant: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteProjectGrant: () => ({
    mutateAsync: queryMocks.deleteGrant,
    isPending: false,
  }),
}));

const project = {
  id: "p1",
  name: "Demo",
  ownerUsername: "alice",
  effectiveRole: "owner",
} as ProjectSummary;

function renderDialog() {
  return render(
    <ShareProjectDialog project={project} open onOpenChange={() => {}} />,
  );
}

describe("ShareProjectDialog (edition gating)", () => {
  beforeEach(() => {
    runtimeState.isCeRuntime = false;
    queryMocks.grants = [];
    queryMocks.deleteGrant.mockReset();
    queryMocks.useUserSearch.mockClear();
  });

  it("renders the share dialog in EE runtime", () => {
    renderDialog();
    expect(screen.getByText("共享项目")).toBeInTheDocument();
    expect(queryMocks.useUserSearch).toHaveBeenCalledWith("p1", "");
  });

  it("renders nothing in CE runtime", () => {
    runtimeState.isCeRuntime = true;
    const { container } = renderDialog();
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("共享项目")).not.toBeInTheDocument();
  });

  it("marks scope-invalid grants inactive while keeping removal available", () => {
    queryMocks.grants = [
      {
        id: "g1",
        project_id: "p1",
        principal_type: "user",
        principal_id: "u9",
        principal_username: "dev09",
        role: "editor",
        effective: false,
        inactive_reason: "principal_scope_changed",
      },
    ];

    renderDialog();

    expect(screen.getByText("已失效")).toBeInTheDocument();
    expect(screen.getByText("用户作用域已变化")).toBeInTheDocument();
    const memberRow = screen.getByText("dev09").parentElement?.parentElement;
    expect(memberRow).toBeInstanceOf(HTMLElement);
    expect(within(memberRow as HTMLElement).getByRole("combobox")).toBeDisabled();
    expect(
      within(memberRow as HTMLElement).getByRole("button", { name: "移除成员" }),
    ).toBeEnabled();
  });

  it("treats grants without effective as active during rolling deploys", () => {
    queryMocks.grants = [
      {
        id: "g1",
        project_id: "p1",
        principal_type: "user",
        principal_id: "u9",
        principal_username: "dev09",
        role: "editor",
      },
    ];

    renderDialog();

    expect(screen.queryByText("已失效")).not.toBeInTheDocument();
    const memberRow = screen.getByText("dev09").parentElement?.parentElement;
    expect(memberRow).toBeInstanceOf(HTMLElement);
    expect(within(memberRow as HTMLElement).getByRole("combobox")).toBeEnabled();
  });
});
