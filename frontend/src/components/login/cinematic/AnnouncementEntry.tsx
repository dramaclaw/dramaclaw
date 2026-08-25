// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Bell, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import styles from "@/components/login/login.module.css";
import { AnnouncementCard as SharedAnnouncementCard } from "@/components/notifications/announcement-card";
import {
  type Announcement,
  type AnnouncementText,
  parseAnnouncementBody,
  pickAnnouncementText,
  useAnnouncementReadState,
  useAnnouncements,
} from "./announcements";

/**
 * 登录页顶栏的公告入口：图标 + 未读红点，点开是公告中心。
 *
 * 顶栏红点与未读状态联动。打开公告中心即视为看过当前列表；后续出现新公告时，
 * 新 ID 不在本地已读集合里，红点会自然重新出现。
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
  const { isRead, markAllRead, unreadCount } = useAnnouncementReadState();
  const [open, setOpen] = useState(false);

  const unread = unreadCount(ids);

  useEffect(() => {
    if (open && ids.length > 0) markAllRead(ids);
  }, [ids, markAllRead, open]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <div className={styles.announcement}>
        <Dialog.Trigger
          className={styles.announcementTrigger}
          aria-label={t("loginCinematic.announcement.open")}
        >
          <span className={styles.announcementIcon} aria-hidden="true">
            <Bell />
            {unread > 0 ? <span className={styles.announcementDot} /> : null}
          </span>
          <span>{t("loginCinematic.announcement.label")}</span>
        </Dialog.Trigger>
      </div>

      <Dialog.Portal>
        <Dialog.Backdrop className={styles.announcementOverlay} />
        <Dialog.Popup className={styles.announcementDialog}>
          <header className={styles.announcementHeader}>
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
                <AnnouncementListItem
                  key={item.id}
                  announcement={item}
                  text={pickAnnouncementText(item, i18n.language)}
                  read={isRead(item.id)}
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
            <Dialog.Close
              className={styles.announcementConfirm}
              onClick={() => markAllRead(ids)}
            >
              {t("loginCinematic.announcement.confirm")}
            </Dialog.Close>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AnnouncementListItem({
  announcement,
  text,
  read,
}: {
  announcement: Announcement;
  text: AnnouncementText;
  read: boolean;
}) {
  const { t, i18n } = useTranslation();

  // 正文里的 <time>/<hl> 由文案自己标，高亮位置跟着语序走而不是写死下标。
  const tokens = useMemo(() => parseAnnouncementBody(text.body), [text.body]);

  return (
    <li>
      <SharedAnnouncementCard
        title={text.title}
        body={text.body}
        bodyTokens={tokens}
        publishedAt={announcement.publishedAt}
        locale={i18n.language}
        unread={!read}
        badge={
          announcement.pinned ? t("loginCinematic.announcement.pinned") : undefined
        }
      />
    </li>
  );
}
