// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import { AnnouncementEntry } from "@/components/login/cinematic/AnnouncementEntry";

// 用真实译文跑，而不是 mock 掉 react-i18next —— 正文里的 <time>/<hl> 标记是文案的一部分，
// 只有真 i18next 解析才能验出「高亮标签写漏了」这类改文案时最容易犯的错。
beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: "zh",
    resources: {
      zh: { translation: JSON.parse(readFileSync("public/locales/zh/translation.json", "utf8")) },
    },
  });
});

// 已读状态落在 localStorage 里，用例之间不清就会互相串。
beforeEach(() => {
  window.localStorage.clear();
});

const DIALOG = { name: "公告中心" };

async function openCenter() {
  const user = userEvent.setup();
  render(<AnnouncementEntry />);
  const trigger = screen.getByRole("button", { name: "查看公告" });
  await user.click(trigger);
  return { user, trigger, dialog: await screen.findByRole("dialog", DIALOG) };
}

describe("AnnouncementEntry", () => {
  it("keeps the red dot on the trigger even after everything was marked read", async () => {
    const { user, trigger } = await openCenter();

    await user.click(screen.getByRole("button", { name: "全部已读" }));
    await user.click(screen.getByRole("button", { name: "确认" }));

    // 公告是拿来拦人的：全部已读了，顶栏这颗也不熄。
    expect(trigger.querySelector("span")).not.toBeNull();
  });

  it("lists each announcement as its own card and closes from the confirm button", async () => {
    const { user, dialog } = await openCenter();

    const items = within(dialog).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(within(items[0]).getByRole("heading")).toHaveTextContent("渠道版本更新");
    expect(items[0]).toHaveTextContent("渠道版本即将上线");

    await user.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => expect(screen.queryByRole("dialog", DIALOG)).not.toBeInTheDocument());
  });

  it("renders the subject and the time window as separate highlight spans", async () => {
    await openCenter();

    // 高亮片段各自成元素，说明 <time>/<hl> 真的被 Trans 换成了带样式的 span，
    // 而不是当成纯文本原样打在正文里。
    expect(screen.getByText("渠道版本").tagName).toBe("SPAN");
    expect(screen.getByText("18:00-19:00").tagName).toBe("SPAN");
  });

  it("expands and collapses a single announcement", async () => {
    const { user } = await openCenter();

    const toggle = screen.getByRole("button", { name: "展开这条公告" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    const collapse = await screen.findByRole("button", { name: "收起这条公告" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    // 展开的那段正文得真的被按钮指向，否则读屏用户不知道展开的是哪一块。
    const bodyId = collapse.getAttribute("aria-controls");
    expect(bodyId).toBeTruthy();
    expect(document.getElementById(bodyId!)).toHaveTextContent("渠道版本即将上线");

    await user.click(collapse);
    expect(await screen.findByRole("button", { name: "展开这条公告" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("clears a card's unread dot once it is expanded, and remembers it across mounts", async () => {
    const { user, dialog } = await openCenter();

    expect(within(dialog).getByText("1 条未读")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开这条公告" }));

    await waitFor(() => expect(screen.queryByText("1 条未读")).not.toBeInTheDocument());
    // 已读要落盘，否则刷一次登录页所有公告又变回未读。
    expect(window.localStorage.getItem("dramaclaw.login.announcements.read")).toContain(
      "channel-release-2026-08",
    );
  });

  it("marks everything read from the footer", async () => {
    const { user } = await openCenter();

    const markAll = screen.getByRole("button", { name: "全部已读" });
    expect(markAll).toBeEnabled();

    await user.click(markAll);

    await waitFor(() => expect(screen.queryByText("1 条未读")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "全部已读" })).toBeDisabled();
  });

  it("traps focus in the dialog and hands it back to the trigger on close", async () => {
    const { user, trigger, dialog } = await openCenter();

    // 回归用例：手搓 portal 的那版没有焦点管理，Tab 会直接跑到弹窗背后的页面上。
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard("{Tab}");
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => expect(screen.queryByRole("dialog", DIALOG)).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes the dialog on Escape", async () => {
    const { user } = await openCenter();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", DIALOG)).not.toBeInTheDocument());
  });
});
