// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

/**
 * 登录页公告中心的数据层。
 *
 * 公告不再写死在前端：内容是 OSS 上的一份 JSON，运营改公告 = 覆盖那个对象，
 * 不用发版、不用动翻译文件。默认地址是 `DEFAULT_ANNOUNCEMENTS_URL`，本地或
 * 私有化部署用 `VITE_LOGIN_ANNOUNCEMENTS_URL` 覆盖（dev 下指到
 * `/announcements.json` 就会读仓库里 `frontend/public/announcements.json`
 * 那份，内容跟线上那份保持一致，改公告时两边一起改）。
 *
 * JSON 形状（`announcements` 数组，也接受最外层直接是数组）：
 *
 * ```json
 * {
 *   "announcements": [
 *     {
 *       "id": "channel-release-2026-08",
 *       "publishedAt": "2026-08-24T10:00:00+08:00",
 *       "pinned": false,
 *       "i18n": {
 *         "zh": { "title": "渠道版本更新", "body": "<hl>渠道版本</hl>即将上线…" },
 *         "en": { "title": "Channel release update", "body": "A <hl>channel release</hl>…" }
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * 正文里的 `<hl>…</hl>` 标重点、`<time>…</time>` 标时间窗，由
 * `parseAnnouncementBody` 切成 token、UI 层换成带样式的 span。**只认这两个标记**，
 * 其余尖括号一律当普通文本，所以远端文案改坏了最多是显示成字面量，注不进 HTML。
 *
 * 拉不到（对象没传上去 / 断网 / 新域名没配 CORS）时不做本地缓存也不回落写死内容，就是「没有公告」：
 * 公告是拿来传达当下状态的，宁可空着也不要拿旧的糊弄人。
 */

/** 单条公告在某一种语言下的文案。 */
export type AnnouncementText = { title: string; body: string };

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
  /** 语言码（`zh` / `en` / `zh-CN` 都行，大小写不敏感）→ 该语言的文案。 */
  i18n: Record<string, AnnouncementText>;
};

const AnnouncementTextSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
});

const AnnouncementSchema = z.object({
  id: z.string().trim().min(1),
  publishedAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)), "publishedAt 必须是可解析的 ISO 8601"),
  pinned: z.boolean().optional(),
  // 至少得有一种语言，否则这条公告渲染出来是张空卡。
  i18n: z.record(z.string(), AnnouncementTextSchema).refine((map) => Object.keys(map).length > 0),
});

// 最外层写成 `{ "announcements": [...] }` 或者直接一个数组都收 —— 传错外壳是
// 手工维护 JSON 最容易犯的错，为此让整页公告消失不值得。
const PayloadSchema = z.union([
  z.object({ announcements: z.array(AnnouncementSchema) }),
  z.array(AnnouncementSchema),
]);

/**
 * 公告故意**不**跟二维码、片花共用 `media.ts` 的 `cdn()` 前缀，而是直连 OSS。
 *
 * 那些图片视频由 `<img>`/`<video>` 加载，浏览器自己读、JS 拿不到内容，不查 CORS，
 * 而且发一次就不再变，挂在 CDN 上吃 30 天边缘缓存正合适。公告两条都反过来：
 *
 * - 它要 `fetch()` 把 JSON 交给 JS，**必须**回 `Access-Control-Allow-Origin`。少了那个头，
 *   对象本身 200、地址栏也打得开，但页面上就是静默的「没有公告」。
 * - 运营改完要尽快见效，而 CDN 那层 30 天的边缘缓存（`X-Swift-CacheTime: 2592000`）会把
 *   旧公告钉在边缘节点上：源站改了也不回源，且**挂 query 绕不开** —— 这个 CDN 把查询串
 *   从缓存键里过滤掉了，`?t=<时间戳>` 照样命中同一份旧副本。
 *
 * 直连 OSS 就没有那层边缘缓存，对象自己的 `Cache-Control: max-age=60` 是唯一一层，
 * 覆盖上传后最多一分钟全网见效。代价是这个域名必须在 OSS 的跨域设置里放行本站来源。
 */
export const DEFAULT_ANNOUNCEMENTS_URL = "https://nfg-web.cdnfg.com/dramaclaw/announcements.json";

export function announcementsUrl(): string {
  const override = import.meta.env.VITE_LOGIN_ANNOUNCEMENTS_URL?.trim();
  return override ? override : DEFAULT_ANNOUNCEMENTS_URL;
}

/**
 * 置顶优先，其余按发布时间倒序。排序放在数据层而不是组件里，是为了让前后端
 * 对顺序的定义只有一处 —— JSON 里怎么排都不影响最终展示。
 */
function sortAnnouncements(items: Announcement[]): Announcement[] {
  return [...items].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    return Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
  });
}

export async function fetchAnnouncements(signal?: AbortSignal): Promise<Announcement[]> {
  const url = announcementsUrl();
  // `no-cache` 是「带 ETag 回源校验」而不是「不缓存」：公告改完刷新就能看到新的，
  // 又不至于每次登录页都全量重下。前提是那个对象带短 Cache-Control，
  // 否则改完公告要等 CDN 边缘缓存自己过期。
  const res = await fetch(url, { credentials: "omit", cache: "no-cache", signal });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);

  const parsed = PayloadSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error(`invalid announcements payload: ${parsed.error.message}`);

  const items = Array.isArray(parsed.data) ? parsed.data : parsed.data.announcements;
  return sortAnnouncements(items);
}

/**
 * 按界面语言挑一份文案：先精确匹配（`zh-CN`），再退到主语言（`zh`），最后退到
 * JSON 里的第一份。**永远返回一份**而不是 null —— 少一种翻译不该让整条公告消失，
 * 显示成另一种语言至少信息还在。
 */
export function pickAnnouncementText(item: Announcement, language: string): AnnouncementText {
  const byLowerKey = new Map(
    Object.entries(item.i18n).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const tag = language.toLowerCase();
  const candidates = [tag, tag.split("-")[0], "zh", "en"];

  for (const candidate of candidates) {
    const hit = byLowerKey.get(candidate);
    if (hit) return hit;
  }
  // schema 保证至少有一项，这里的 ?? 只是让类型收敛。
  return Object.values(item.i18n)[0] ?? { title: "", body: "" };
}

export type AnnouncementBodyToken = { kind: "text" | "hl" | "time"; text: string };

const BODY_MARKUP_RE = /<(hl|time)>([\s\S]*?)<\/\1>/g;

/**
 * 把正文切成「普通文本 / 高亮 / 时间窗」三种 token。
 *
 * 远端文案是不受信任的输入，所以这里既不 `dangerouslySetInnerHTML` 也不走
 * i18next 的 HTML 解析：只认 `<hl>` 和 `<time>` 这两个闭合标记，其它尖括号原样
 * 当文本输出。文案里写了别的标签，看到的就是标签本身，不会变成 DOM。
 */
export function parseAnnouncementBody(body: string): AnnouncementBodyToken[] {
  const tokens: AnnouncementBodyToken[] = [];
  let cursor = 0;

  for (const match of body.matchAll(BODY_MARKUP_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) tokens.push({ kind: "text", text: body.slice(cursor, start) });
    tokens.push({ kind: match[1] as "hl" | "time", text: match[2] });
    cursor = start + match[0].length;
  }
  if (cursor < body.length) tokens.push({ kind: "text", text: body.slice(cursor) });

  return tokens;
}

/**
 * 拉公告。挂载时拉一次，拉不到就是空数组 —— 调用方据此把整个入口收起来。
 *
 * 没有 loading / error 态：调用方对「还没拉到」「拉失败」「本来就没有」的处理
 * 完全一样（都不显示），多分一层状态只会让 UI 多几条走不到的分支。
 *
 * 请求在组件卸载时 abort：登录页的公告入口会随着登录成功一起卸载，让一个已经
 * 没人看的请求继续 setState 只会换来 React 的警告。
 */
export function useAnnouncements(): Announcement[] {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;

    fetchAnnouncements(controller.signal)
      .then((items) => {
        if (alive) setAnnouncements(items);
      })
      .catch((error: unknown) => {
        if (!alive || controller.signal.aborted) return;
        // 只留一条日志：登录页拿不到公告不是用户能处理的问题，界面上安静地少一个入口，
        // 排查时靠这行知道是 CDN/CORS 还是 JSON 写坏了。
        // eslint-disable-next-line no-console
        console.warn("[announcements] load failed:", error);
        setAnnouncements([]);
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, []);

  return announcements;
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
