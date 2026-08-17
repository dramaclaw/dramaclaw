// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
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
const queryMocks = vi.hoisted(() => ({ useUserSearch: vi.fn() }));

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
}));

vi.mock("@/lib/queries/projects", () => ({
  useProjectGrants: () => ({ data: { data: [] } }),
  useUserSearch: (...args: unknown[]) => {
    queryMocks.useUserSearch(...args);
    return { data: { data: [] } };
  },
  useAddProjectGrant: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateProjectGrant: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteProjectGrant: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
});
