// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Fragment, type ReactNode } from "react";
import { Bell } from "lucide-react";
import styles from "./announcement-card.module.css";

export type AnnouncementCardBodyToken = {
  kind: "text" | "hl" | "time";
  text: string;
};

export function AnnouncementCard({
  title,
  body,
  bodyTokens,
  publishedAt,
  locale,
  unread = false,
  badge,
  actions,
}: {
  title: string;
  body: string;
  bodyTokens?: readonly AnnouncementCardBodyToken[];
  publishedAt?: string | null;
  locale: string;
  unread?: boolean;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  const publishedLabel = formatRelativeTime(publishedAt, locale);

  return (
    <article className={styles.card}>
      <span className={styles.icon} aria-hidden="true">
        <Bell />
        {unread ? <span className={styles.unreadDot} /> : null}
      </span>

      <div className={styles.content}>
        <div className={styles.header}>
          <div className={styles.titleGroup}>
            <h3 className={styles.title}>{title}</h3>
            {badge ? <span className={styles.badge}>{badge}</span> : null}
          </div>
          {publishedLabel ? (
            <time className={styles.publishedAt} dateTime={publishedAt ?? undefined}>
              {publishedLabel}
            </time>
          ) : null}
        </div>

        <p className={styles.body}>
          {bodyTokens
            ? bodyTokens.map((token, index) => {
                if (token.kind === "text") {
                  return <Fragment key={index}>{token.text}</Fragment>;
                }
                return (
                  <span
                    key={index}
                    className={token.kind === "time" ? styles.highlightTime : styles.highlight}
                  >
                    {token.text}
                  </span>
                );
              })
            : body}
        </p>

        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </article>
  );
}

function formatRelativeTime(value: string | null | undefined, locale: string): string | undefined {
  if (!value) return undefined;
  const published = new Date(value);
  if (Number.isNaN(published.getTime())) return undefined;
  const diffMs = published.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(locale.startsWith("zh") ? "zh" : "en", {
    numeric: "auto",
  });
  if (absMs < 60 * 60 * 1000) {
    return rtf.format(Math.round(diffMs / (60 * 1000)), "minute");
  }
  if (absMs < 24 * 60 * 60 * 1000) {
    return rtf.format(Math.round(diffMs / (60 * 60 * 1000)), "hour");
  }
  return rtf.format(Math.round(diffMs / (24 * 60 * 60 * 1000)), "day");
}
