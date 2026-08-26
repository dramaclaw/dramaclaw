// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareProjectDialog } from "@/components/projects/share-project-dialog";
import { MAX_PROJECT_GRANTS } from "@/lib/limits";
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
  "project.shareDialog.inactiveAccessChanged": "用户当前无法访问此项目",
  "project.shareDialog.limitReached": "最多只能分享给 {{limit}} 人",
  "project.shareDialog.limitTitle": "分享人数已达上限",
  "project.shareDialog.quotaUnknownTitle": "还确认不了成员数量",
  "project.shareDialog.quotaUnknown": "成员列表还没加载出来，等它加载完再添加",
  "project.shareDialog.memberCount": "{{count}}/{{limit}}",
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

type NoticeOptions = { title?: string; description: string };

const alertDialogMock = vi.hoisted(() =>
  vi.fn((_options: { title?: string; description: string }) => Promise.resolve()),
);

vi.mock("@/components/confirm-dialog-host", () => ({
  alertDialog: (options: NoticeOptions) => alertDialogMock(options),
  confirmDialog: vi.fn(() => Promise.resolve(false)),
}));

const runtimeState = vi.hoisted(() => ({ isCeRuntime: false }));
const queryMocks = vi.hoisted(() => ({
  grants: [] as Array<Record<string, unknown>>,
  grantsLoading: false,
  grantsError: false,
  deleteGrant: vi.fn(),
  useUserSearch: vi.fn(),
}));
const addGrantMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
}));

vi.mock("@/lib/queries/projects", () => ({
  useProjectGrants: () =>
    queryMocks.grantsLoading
      ? { data: undefined, isLoading: true, isError: false }
      : {
          data: { data: queryMocks.grants },
          isLoading: false,
          // 刷新失败时 React Query 把上一份名单留着，status 走到 error。
          isError: queryMocks.grantsError,
        },
  useUserSearch: (...args: unknown[]) => {
    queryMocks.useUserSearch(...args);
    return { data: { data: [] } };
  },
  useAddProjectGrant: () => ({ mutateAsync: addGrantMock, isPending: false }),
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
    queryMocks.grantsLoading = false;
    queryMocks.grantsError = false;
    queryMocks.deleteGrant.mockReset();
    queryMocks.useUserSearch.mockClear();
    addGrantMock.mockClear();
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

  it("marks ineffective grants inactive while keeping removal available", () => {
    queryMocks.grants = [
      {
        id: "g1",
        project_id: "p1",
        principal_type: "user",
        principal_id: "u9",
        principal_username: "dev09",
        role: "editor",
        effective: false,
        inactive_reason: "principal_access_changed",
      },
    ];

    renderDialog();

    expect(screen.getByText("已失效")).toBeInTheDocument();
    expect(screen.getByText("用户当前无法访问此项目")).toBeInTheDocument();
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

function grantRows(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `g${index}`,
    principal_id: `u${index}`,
    principal_username: `user${index}`,
    role: "editor",
  }));
}

describe("ShareProjectDialog (share quota)", () => {
  beforeEach(() => {
    runtimeState.isCeRuntime = false;
    queryMocks.grants = [];
    queryMocks.grantsLoading = false;
    queryMocks.grantsError = false;
    addGrantMock.mockClear();
    alertDialogMock.mockClear();
  });

  it("keeps the add button usable below the limit", async () => {
    queryMocks.grants = grantRows(MAX_PROJECT_GRANTS - 1);
    renderDialog();

    await userEvent.type(screen.getByPlaceholderText("搜索用户名"), "carol");

    expect(screen.getByRole("button", { name: /添加/ })).toBeEnabled();
    expect(screen.queryByText(`最多只能分享给 ${MAX_PROJECT_GRANTS} 人`)).not.toBeInTheDocument();
  });

  it("keeps the add button clickable at the limit and explains itself in a dialog", async () => {
    queryMocks.grants = grantRows(MAX_PROJECT_GRANTS);
    renderDialog();

    await userEvent.type(screen.getByPlaceholderText("搜索用户名"), "carol");
    const addButton = screen.getByRole("button", { name: /添加/ });

    // 死按钮说不出理由，点得动才有地方解释。
    expect(addButton).toBeEnabled();
    await userEvent.click(addButton);

    expect(addGrantMock).not.toHaveBeenCalled();
    expect(alertDialogMock).toHaveBeenCalledTimes(1);
    expect(alertDialogMock.mock.calls[0][0]).toMatchObject({
      title: "分享人数已达上限",
      description: `最多只能分享给 ${MAX_PROJECT_GRANTS} 人`,
    });
    expect(screen.getByText(`最多只能分享给 ${MAX_PROJECT_GRANTS} 人`)).toBeInTheDocument();
  });

  it("refuses to add while the member list is still loading", async () => {
    // 名单没回来时手上是空的，按它放行等于把「不知道几个人」当成「一个都没有」。
    // grants 端点不数人头，这一下加进去的就是真的第 26 个。
    queryMocks.grantsLoading = true;
    renderDialog();

    await userEvent.type(screen.getByPlaceholderText("搜索用户名"), "carol");
    await userEvent.click(screen.getByRole("button", { name: /添加/ }));

    expect(addGrantMock).not.toHaveBeenCalled();
    expect(alertDialogMock).toHaveBeenCalledTimes(1);
    expect(alertDialogMock.mock.calls[0][0]).toMatchObject({
      title: "还确认不了成员数量",
      description: "成员列表还没加载出来，等它加载完再添加",
    });
  });

  it("refuses to add when the last member refresh failed", async () => {
    // 刷新失败时旧名单还在（React Query 保留 data，status 走到 error）。
    // 拿这份可能已经过期的人数继续放行，加进去的就可能是第 26 个。
    queryMocks.grants = grantRows(MAX_PROJECT_GRANTS - 1);
    queryMocks.grantsError = true;
    renderDialog();

    await userEvent.type(screen.getByPlaceholderText("搜索用户名"), "carol");
    await userEvent.click(screen.getByRole("button", { name: /添加/ }));

    expect(addGrantMock).not.toHaveBeenCalled();
    expect(alertDialogMock).toHaveBeenCalledTimes(1);
    expect(alertDialogMock.mock.calls[0][0]).toMatchObject({ title: "还确认不了成员数量" });
  });

  it("shows how many of the allowed slots are used", () => {
    queryMocks.grants = grantRows(3);
    renderDialog();

    expect(screen.getByText(`3/${MAX_PROJECT_GRANTS}`)).toBeInTheDocument();
  });
});
