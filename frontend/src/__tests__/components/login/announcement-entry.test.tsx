// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import { AnnouncementEntry } from "@/components/login/cinematic/AnnouncementEntry";
import styles from "@/components/login/login.module.css";

// 用真实译文跑，而不是 mock 掉 react-i18next —— 界面词也是文案的一部分，
// 只有真 i18next 才能验出「新加的 key 忘了补翻译」。
beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: "zh",
    resources: {
      zh: { translation: JSON.parse(readFileSync("public/locales/zh/translation.json", "utf8")) },
    },
  });
});

// 公告内容来自 OSS 上的 JSON。仓库里 public/announcements.json 就是要传上去的那份，
// 直接拿它当夹具：既测组件，也顺手验这份 JSON 的形状能过 schema。
const SHIPPED_PAYLOAD = JSON.parse(readFileSync("public/announcements.json", "utf8"));

function stubFetch(impl: () => unknown) {
  const fetchMock = vi.fn(async () => impl() as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

// 已读状态落在 localStorage 里，用例之间不清就会互相串。
beforeEach(() => {
  window.localStorage.clear();
  stubFetch(() => jsonResponse(SHIPPED_PAYLOAD));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DIALOG = { name: "公告中心" };

function findAnnouncementDot(trigger: HTMLElement) {
  return trigger.querySelector(`.${styles.announcementDot}`);
}

async function openCenter() {
  const user = userEvent.setup();
  render(<AnnouncementEntry />);
  const trigger = screen.getByRole("button", { name: "查看公告" });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", DIALOG);
  return { user, trigger, dialog };
}

async function openLoadedCenter() {
  const opened = await openCenter();
  await waitFor(() =>
    expect(within(opened.dialog).queryAllByRole("listitem").length).toBeGreaterThan(0),
  );
  return opened;
}

describe("AnnouncementEntry", () => {
  it("pulls the announcements from the OSS json instead of a bundled list", async () => {
    const fetchMock = stubFetch(() => jsonResponse(SHIPPED_PAYLOAD));

    await openLoadedCenter();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // 直连 OSS，不是 `media.ts` 那个 CDN 前缀：CDN 有 30 天边缘缓存，且查询串被过滤出缓存键，
    // 挂时间戳也刷不动，改完公告一个月才见效。这行钉住域名，防止有人顺手"统一"回 cdn()。
    expect(url).toBe("https://nfg-web.cdnfg.com/dramaclaw/announcements.json");
    // 登录页是未登录状态下打开的，别把 cookie 带去 OSS。
    expect(init).toMatchObject({ credentials: "omit", cache: "no-cache" });
  });

  it("clears the trigger dot after the announcement center is opened", async () => {
    const { trigger, dialog } = await openLoadedCenter();

    await waitFor(() => expect(findAnnouncementDot(trigger)).toBeNull());
    expect(within(dialog).queryByText("1 条未读")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("dramaclaw.login.announcements.read")).toContain(
      "channel-release-2026-08",
    );
  });

  it("preserves read ids that are not in the current remote payload", async () => {
    window.localStorage.setItem(
      "dramaclaw.login.announcements.read",
      JSON.stringify(["retired-announcement"]),
    );

    await openLoadedCenter();

    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem("dramaclaw.login.announcements.read") ?? "[]",
      ) as string[];
      expect(stored).toEqual(
        expect.arrayContaining(["retired-announcement", "channel-release-2026-08"]),
      );
    });
  });

  it("lists each announcement as its own card and closes from the confirm button", async () => {
    const { user, dialog } = await openLoadedCenter();

    const items = within(dialog).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(within(items[0]).getByRole("heading")).toHaveTextContent("渠道版本更新");
    expect(items[0]).toHaveTextContent("渠道版本即将上线");

    await user.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => expect(screen.queryByRole("dialog", DIALOG)).not.toBeInTheDocument());
    expect(window.localStorage.getItem("dramaclaw.login.announcements.read")).toContain(
      "channel-release-2026-08",
    );
  });

  it("renders the subject and the time window as separate highlight spans", async () => {
    await openLoadedCenter();

    // 高亮片段各自成元素，说明 <time>/<hl> 真的被换成了带样式的 span，
    // 而不是当成纯文本原样打在正文里。
    expect(screen.getByText("渠道版本").tagName).toBe("SPAN");
    expect(screen.getByText("18:00-19:00").tagName).toBe("SPAN");
  });

  it("prints any other markup in the remote copy as literal text", async () => {
    stubFetch(() =>
      jsonResponse({
        announcements: [
          {
            id: "escape-check",
            publishedAt: "2026-08-24T10:00:00+08:00",
            i18n: { zh: { title: "转义", body: "先看 <img src=x onerror=alert(1)> 再看正文" } },
          },
        ],
      }),
    );

    const { dialog } = await openLoadedCenter();

    // 远端文案是不受信任的输入：认识的只有 <hl>/<time>，别的标签只能当字面量。
    expect(dialog).toHaveTextContent("先看 <img src=x onerror=alert(1)> 再看正文");
    expect(dialog.querySelector("img")).toBeNull();
  });

  it("falls back to another language when the current one is missing from the json", async () => {
    stubFetch(() =>
      jsonResponse({
        announcements: [
          {
            id: "en-only",
            publishedAt: "2026-08-24T10:00:00+08:00",
            i18n: { en: { title: "English only", body: "Body in English" } },
          },
        ],
      }),
    );

    const { dialog } = await openLoadedCenter();

    // 少一种翻译不该让整条公告消失 —— 显示成另一种语言至少信息还在。
    expect(within(dialog).getByRole("heading", { name: "English only" })).toBeInTheDocument();
  });

  it("sorts pinned announcements first, then newest", async () => {
    stubFetch(() =>
      jsonResponse({
        announcements: [
          {
            id: "old",
            publishedAt: "2026-08-01T10:00:00+08:00",
            i18n: { zh: { title: "旧公告", body: "旧" } },
          },
          {
            id: "new",
            publishedAt: "2026-08-20T10:00:00+08:00",
            i18n: { zh: { title: "新公告", body: "新" } },
          },
          {
            id: "pinned",
            publishedAt: "2026-07-01T10:00:00+08:00",
            pinned: true,
            i18n: { zh: { title: "置顶公告", body: "顶" } },
          },
        ],
      }),
    );

    const { dialog } = await openLoadedCenter();

    // 顺序由数据层定，JSON 里怎么排都不影响展示。
    const titles = within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((node) => node.textContent);
    expect(titles).toEqual(["置顶公告", "新公告", "旧公告"]);
  });

  it("shows the complete announcement without an expand control", async () => {
    const { dialog } = await openLoadedCenter();

    expect(dialog).toHaveTextContent("渠道版本即将上线");
    expect(screen.queryByRole("button", { name: "展开这条公告" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "收起这条公告" })).not.toBeInTheDocument();
  });

  it("disables mark-all after opening has acknowledged the visible list", async () => {
    await openLoadedCenter();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "全部已读" })).toBeDisabled(),
    );
  });

  it("keeps the trigger but drops the dot and the list when the json cannot be loaded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(() => {
      throw new Error("network down");
    });

    const { dialog, trigger } = await openCenter();

    // 拉不到就是「没有公告」：喇叭照常在，只是不打红点、点开是空的。
    // 不摆「重新加载」——刷新登录页本来就会重来一次。
    await waitFor(() => expect(findAnnouncementDot(trigger)).toBeNull());
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(dialog).getByRole("button", { name: "全部已读" })).toBeDisabled();
  });

  it("treats a malformed payload as no announcements rather than half a card", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(() =>
      jsonResponse({ announcements: [{ id: "broken", publishedAt: "not-a-date", i18n: {} }] }),
    );

    const { dialog, trigger } = await openCenter();

    await waitFor(() => expect(findAnnouncementDot(trigger)).toBeNull());
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("traps focus in the dialog and hands it back to the trigger on close", async () => {
    const { user, trigger, dialog } = await openLoadedCenter();

    // 回归用例：手搓 portal 的那版没有焦点管理，Tab 会直接跑到弹窗背后的页面上。
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard("{Tab}");
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => expect(screen.queryByRole("dialog", DIALOG)).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes the dialog on Escape", async () => {
    const { user } = await openLoadedCenter();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", DIALOG)).not.toBeInTheDocument());
  });
});
