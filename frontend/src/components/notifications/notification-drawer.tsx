// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AnnouncementCard as SharedAnnouncementCard,
  type AnnouncementCardBodyToken,
} from "@/components/notifications/announcement-card";
import {
  type Announcement,
  parseAnnouncementBody,
  pickAnnouncementText,
} from "@/components/login/cinematic/announcements";
import { useReleaseNotifications } from "@/lib/queries/release-notifications";
import type { ReleaseItem } from "@/lib/queries/release-notifications";
import {
  markUpgradeSeen,
  markUpgradeSkipped,
} from "@/lib/release-notification-state";

interface NotificationItem {
  id: string;
  title: string;
  body: string;
  bodyTokens?: AnnouncementCardBodyToken[];
  publishedAt?: string | null;
  actions?: React.ReactNode;
}

const DRAWER_TRANSITION_MS = 260;

export function NotificationDrawer({
  open,
  onOpenChange,
  onUpgradeStateChange,
  announcements = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpgradeStateChange?: () => void;
  announcements?: Announcement[];
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const releaseNotifications = useReleaseNotifications(locale);
  const feed = releaseNotifications.data?.data;
  const [shouldRender, setShouldRender] = useState(open);
  const [visible, setVisible] = useState(false);
  const notifications = buildNotifications({
    announcements,
    currentItems: feed?.current_items ?? [],
    latestTag: feed?.latest_tag ?? null,
    updateAvailable: feed?.update_available ?? false,
    releaseUrl: feed?.release_url ?? null,
    publishedAt: feed?.latest_published_at ?? null,
    locale,
    t,
    onSkip: () => {
      markUpgradeSkipped(feed?.latest_tag);
      onUpgradeStateChange?.();
    },
    onOpenRelease: () => {
      markUpgradeSeen(feed?.latest_tag);
      onUpgradeStateChange?.();
    },
  });

  useEffect(() => {
    if (open) {
      setVisible(false);
      setShouldRender(true);
      let secondFrame = 0;
      const firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        window.cancelAnimationFrame(firstFrame);
        if (secondFrame) window.cancelAnimationFrame(secondFrame);
      };
    }

    setVisible(false);
    const timer = window.setTimeout(() => setShouldRender(false), DRAWER_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open || !feed?.update_available || !feed.latest_tag) return;
    markUpgradeSeen(feed.latest_tag);
    onUpgradeStateChange?.();
  }, [feed?.latest_tag, feed?.update_available, onUpgradeStateChange, open]);

  useEffect(() => {
    if (!shouldRender) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpenChange, shouldRender]);

  if (!shouldRender) return null;

  return createPortal(
    <div className="fixed inset-0 z-[70]">
      <button
        type="button"
        aria-label={t("notifications.close")}
        className={`absolute inset-0 bg-black/60 transition-opacity duration-[260ms] ease-[var(--ease-out-quint)] ${
          visible ? "opacity-100" : "opacity-0"
        }`}
        onClick={() => onOpenChange(false)}
      />
      <aside
        aria-label={t("notifications.title")}
        className={`absolute right-0 top-0 flex h-full w-[390px] max-w-[calc(100vw-20px)] flex-col border-l border-white/[0.08] bg-[#111113]/92 text-slate-100 shadow-[-24px_0_60px_rgba(0,0,0,0.34)] backdrop-blur-md transition-transform duration-[260ms] ease-[var(--ease-out-quint)] will-change-transform ${
          visible ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="flex h-[54px] shrink-0 items-end justify-between px-5 pb-1.5">
          <h2 className="text-[20px] font-semibold tracking-normal text-white">
            {t("notifications.title")}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-8 rounded-full text-slate-300 hover:bg-white/[0.06] hover:text-white"
            aria-label={t("notifications.close")}
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 pt-1">
          <div className="space-y-4">
            {notifications.length > 0 ? (
              notifications.map((item) => (
                <NotificationRow key={item.id} item={item} locale={locale} />
              ))
            ) : (
              <p className="px-2 py-6 text-[13px] leading-5 text-slate-400">
                {t("notifications.empty")}
              </p>
            )}
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function NotificationRow({ item, locale }: { item: NotificationItem; locale: string }) {
  return (
    <SharedAnnouncementCard
      title={item.title}
      body={item.body}
      bodyTokens={item.bodyTokens}
      publishedAt={item.publishedAt}
      locale={locale}
      actions={item.actions}
    />
  );
}

function buildNotifications({
  announcements,
  currentItems,
  latestTag,
  updateAvailable,
  releaseUrl,
  publishedAt,
  locale,
  t,
  onSkip,
  onOpenRelease,
}: {
  announcements: Announcement[];
  currentItems: ReleaseItem[];
  latestTag: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  locale: string;
  t: (key: string, options?: Record<string, string>) => string;
  onSkip: () => void;
  onOpenRelease: () => void;
}): NotificationItem[] {
  const rows: NotificationItem[] = [];
  for (const announcement of announcements) {
    const text = pickAnnouncementText(announcement, locale);
    const bodyTokens = parseAnnouncementBody(text.body);
    rows.push({
      id: `announcement:${announcement.id}`,
      title: text.title,
      body: bodyTokens.map((token) => token.text).join(""),
      bodyTokens,
      publishedAt: announcement.publishedAt,
    });
  }

  if (updateAvailable && latestTag) {
    rows.push({
      id: `release-upgrade:${latestTag}`,
      title: t("notifications.upgrade.title", { version: latestTag }),
      body: t("notifications.upgrade.body"),
      publishedAt,
      actions: (
        <>
          {releaseUrl ? (
            <a
              className="rounded-[6px] border border-white/10 px-2 py-1 text-[11px] font-medium leading-none text-cyan-100 transition-colors hover:bg-white/[0.06]"
              href={releaseUrl}
              target="_blank"
              rel="noreferrer"
              onClick={onOpenRelease}
            >
              {t("notifications.upgrade.open")}
            </a>
          ) : null}
          <button
            type="button"
            className="rounded-[6px] px-2 py-1 text-[11px] font-medium leading-none text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
            onClick={onSkip}
          >
            {t("notifications.upgrade.skip")}
          </button>
        </>
      ),
    });
  }

  for (const item of currentItems) {
    rows.push({
      id: item.id,
      title: item.title,
      body: item.body,
    });
  }
  return rows;
}
