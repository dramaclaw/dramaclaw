// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useState } from "react";

/**
 * 登录页公告中心的数据层。
 *
 * 目前是前端静态清单：条目的元数据（id / 发布时间 / 是否置顶）写在下面的
 * `ANNOUNCEMENTS` 里，标题和正文走 i18n
 * （`loginCinematic.announcement.items.<id>.title` / `.body`），
 * 改文案只动翻译文件，不用碰这里。
 *
 * 加一条公告 = 在 `ANNOUNCEMENTS` 里加一项 + 在 zh/en 两个 translation.json 的
 * `items` 下按同一个 id 补 title/body。正文支持 <hl>…</hl> 标重点、<time>…</time>
 * 标时间窗，两个标记由 `<Trans>` 换成带样式的 span。
 *
 * 之后要换成后端下发，只需要把 `loadAnnouncements()` 换成一个请求，
 * `Announcement` 的形状保持不变，UI 层一行都不用改。
 */
export type Announcement = {
  /**
   * 已读状态的主键。它会被写进 localStorage，所以**改 id 等于让这条公告对
   * 所有人重新变成未读** —— 想让一条旧公告重新弹到人眼前时，这是唯一的手段。
   */
  id: string;
  /** ISO 8601。渲染时按用户当前语言本地化，不在这里存已经格式化好的字符串。 */
  publishedAt: string;
  /** 置顶的排在最前面，且带一枚「置顶」角标。 */
  pinned?: boolean;
};

const ANNOUNCEMENTS: readonly Announcement[] = [
  { id: "channel-release-2026-08", publishedAt: "2026-08-24T10:00:00+08:00" },
];

/**
 * 置顶优先，其余按发布时间倒序。排序放在数据层而不是组件里，是为了让「换成
 * 后端下发」那天，前后端对顺序的定义只有一处。
 */
export function loadAnnouncements(): Announcement[] {
  return [...ANNOUNCEMENTS].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    return Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
  });
}

const READ_STORAGE_KEY = "dramaclaw.login.announcements.read";

function loadReadIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(READ_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    // 隐私模式、存储被策略禁掉、或者上一版写坏了格式：一律当成「没读过」。
    // 公告是拿来拦人的，读不出状态时宁可多提醒一次，也不要静默地当成已读。
    return [];
  }
}

export type AnnouncementReadState = {
  isRead: (id: string) => boolean;
  markRead: (id: string) => void;
  markAllRead: (ids: readonly string[]) => void;
  unreadCount: (ids: readonly string[]) => number;
};

export function useAnnouncementReadState(): AnnouncementReadState {
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(() => new Set(loadReadIds()));

  const persist = useCallback((next: ReadonlySet<string>) => {
    setReadIds(next);
    try {
      window.localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // 存不下就只在本次会话里生效，不影响这一次的交互。
    }
  }, []);

  const markRead = useCallback(
    (id: string) => {
      setReadIds((current) => {
        if (current.has(id)) return current;
        const next = new Set(current).add(id);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const markAllRead = useCallback(
    (ids: readonly string[]) => {
      persist(new Set(ids));
    },
    [persist],
  );

  return {
    isRead: useCallback((id: string) => readIds.has(id), [readIds]),
    markRead,
    markAllRead,
    unreadCount: useCallback(
      (ids: readonly string[]) => ids.filter((id) => !readIds.has(id)).length,
      [readIds],
    ),
  };
}
