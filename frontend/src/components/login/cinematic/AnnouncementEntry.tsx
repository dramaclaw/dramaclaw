// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Fragment, useId, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Bell, ChevronDown, Megaphone, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import styles from "@/components/login/login.module.css";
import {
  type Announcement,
  type AnnouncementText,
  parseAnnouncementBody,
  pickAnnouncementText,
  useAnnouncementReadState,
  useAnnouncements,
} from "./announcements";

/**
 * 登录页顶栏的公告入口：图标 + 常驻红点，点开是公告中心。
 *
 * 顶栏那颗红点不跟已读联动 —— 公告是拿来拦人的，看过一次就熄灭等于白挂。
 * 弹窗里每条公告各有一枚未读点，那个才跟已读状态走（状态在 announcements.ts）。
 *
 * 没有公告可展示时（还没拉到 / 拉失败 / OSS 上真的是空的）喇叭照常在，只是不打红点、
 * 点开是一张空弹窗：失败不值得摆个「重新加载」让人去按 —— 刷新登录页就会重来一次。
 *
 * 弹窗用 Base UI 的 Dialog 原语而不是手搓 portal：焦点陷阱、关闭后焦点回到触发器、
 * 背景滚动锁都由它负责。动效是 data-starting-style / data-ending-style 上的 CSS
 * 过渡，所以 prefers-reduced-motion 能真的关掉它 —— framer-motion 的 JS 动画关不掉。
 */
export function AnnouncementEntry() {
  const { t, i18n } = useTranslation();
  const announcements = useAnnouncements();
  const ids = useMemo(() => announcements.map((item) => item.id), [announcements]);
  const { isRead, markRead, markAllRead, unreadCount } = useAnnouncementReadState();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const unread = unreadCount(ids);

  return (
    <Dialog.Root>
      <div className={styles.announcement}>
        <Dialog.Trigger
          className={styles.announcementTrigger}
          aria-label={t("loginCinematic.announcement.open")}
        >
          <Megaphone aria-hidden="true" />
          {announcements.length > 0 ? (
            <span className={styles.announcementDot} aria-hidden="true" />
          ) : null}
        </Dialog.Trigger>
      </div>

      <Dialog.Portal>
        <Dialog.Backdrop className={styles.announcementOverlay} />
        <Dialog.Popup className={styles.announcementDialog}>
          <header className={styles.announcementHeader}>
            <Megaphone aria-hidden="true" />
            <Dialog.Title className={styles.announcementHeading}>
              {t("loginCinematic.announcement.title")}
            </Dialog.Title>
            {unread > 0 ? (
              <span className={styles.announcementCount}>
                {t("loginCinematic.announcement.unread", { n: unread })}
              </span>
            ) : null}
            <Dialog.Close
              className={styles.announcementClose}
              aria-label={t("loginCinematic.announcement.close")}
            >
              <X strokeWidth={1.8} aria-hidden="true" />
            </Dialog.Close>
          </header>

          <div className={styles.announcementBody}>
            {/* 没有公告就是一张空弹窗：与其写「暂时没有公告」，不如什么都不说。 */}
            <ul className={styles.announcementList}>
              {announcements.map((item) => (
                <AnnouncementCard
                  key={item.id}
                  announcement={item}
                  text={pickAnnouncementText(item, i18n.language)}
                  read={isRead(item.id)}
                  expanded={expandedId === item.id}
                  onToggle={() => {
                    setExpandedId((current) => (current === item.id ? null : item.id));
                    markRead(item.id);
                  }}
                />
              ))}
            </ul>
          </div>

          <footer className={styles.announcementFooter}>
            <button
              type="button"
              className={styles.announcementMarkAll}
              disabled={unread === 0}
              onClick={() => markAllRead(ids)}
            >
              {t("loginCinematic.announcement.markAllRead")}
            </button>
            <Dialog.Close className={styles.announcementConfirm}>
              {t("loginCinematic.announcement.confirm")}
            </Dialog.Close>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AnnouncementCard({
  announcement,
  text,
  read,
  expanded,
  onToggle,
}: {
  announcement: Announcement;
  text: AnnouncementText;
  read: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, i18n } = useTranslation();
  const bodyId = useId();

  // 发布时间存的是 ISO，展示时按当前语言本地化，避免把「2026年8月24日」这种
  // 中文写法硬编进数据里，英文界面就露馅。
  const publishedLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(announcement.publishedAt)),
    [announcement.publishedAt, i18n.language],
  );

  // 正文里的 <time>/<hl> 由文案自己标，高亮位置跟着语序走而不是写死下标。
  const tokens = useMemo(() => parseAnnouncementBody(text.body), [text.body]);

  return (
    <li className={styles.announcementItem}>
      <span className={styles.announcementItemIcon}>
        <Bell aria-hidden="true" />
        {read ? null : <span className={styles.announcementItemDot} aria-hidden="true" />}
      </span>

      <div className={styles.announcementItemMain}>
        <div className={styles.announcementItemTop}>
          <h3 className={styles.announcementItemTitle}>{text.title}</h3>
          {announcement.pinned ? (
            <span className={styles.announcementPinned}>
              {t("loginCinematic.announcement.pinned")}
            </span>
          ) : null}
        </div>

        <p
          id={bodyId}
          className={
            expanded
              ? `${styles.announcementItemBody} ${styles.announcementItemBodyOpen}`
              : styles.announcementItemBody
          }
        >
          {tokens.map((token, index) => {
            if (token.kind === "text") return <Fragment key={index}>{token.text}</Fragment>;
            return (
              <span
                key={index}
                className={
                  token.kind === "time" ? styles.announcementTime : styles.announcementHighlight
                }
              >
                {token.text}
              </span>
            );
          })}
        </p>

        <time className={styles.announcementItemMeta} dateTime={announcement.publishedAt}>
          {publishedLabel}
        </time>
      </div>

      <button
        type="button"
        className={styles.announcementItemToggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <ChevronDown aria-hidden="true" />
        <span className={styles.announcementSrOnly}>
          {t(
            expanded
              ? "loginCinematic.announcement.collapse"
              : "loginCinematic.announcement.expand",
          )}
        </span>
      </button>
    </li>
  );
}
