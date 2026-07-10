// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Bell,
  Bolt,
  Camera,
  Check,
  ChevronRight,
  Languages,
  LogOut,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AvatarUploadDialog } from "@/components/account/avatar-upload-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CreditBalanceBadge } from "@/components/layout/credit-balance-badge";
import { NotificationDrawer } from "@/components/notifications/notification-drawer";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import {
  PetGalleryDialog,
  type CompanionSelection,
} from "@/features/companion/petdex/PetGalleryDialog";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth-store";
import { useAppStore } from "@/stores/app-store";
import { authRequired, isCeRuntime } from "@/lib/runtime-config";
import { resetUserSessionState } from "@/lib/reset-region-state";
import { useModelGatewayConfig } from "@/lib/queries/model-gateway";
import { useReleaseNotifications } from "@/lib/queries/release-notifications";
import {
  markUpgradeSeen,
  shouldShowUpgradeNudge,
} from "@/lib/release-notification-state";
import { LiexiaorenSkinPreview } from "@/features/liexiaoren/LiexiaorenSkinPreview";

const ACCOUNT_PANEL_TRANSITION_MS = 350;

export function Header({ showBrand: _showBrand = false }: { showBrand?: boolean }) {
  const { t, i18n } = useTranslation();
  const [companionOpen, setCompanionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [releaseNotificationStateVersion, setReleaseNotificationStateVersion] = useState(0);
  const [avatarDialogOpen, setAvatarDialogOpen] = useState(false);
  const [accountPanelOpen, setAccountPanelOpen] = useState(false);
  const [accountPanelVisible, setAccountPanelVisible] = useState(false);
  const [settingsWarningBubbleDismissed, setSettingsWarningBubbleDismissed] = useState(false);
  const [accountPanelPosition, setAccountPanelPosition] = useState<{ top: number; right: number }>({
    top: 56,
    right: 16,
  });
  const accountCloseTimerRef = useRef<number | null>(null);
  const accountUnmountTimerRef = useRef<number | null>(null);
  const accountOpenFrameRef = useRef<number | null>(null);
  const accountAnchorRef = useRef<HTMLDivElement | null>(null);
  const settingsAnchorRef = useRef<HTMLDivElement | null>(null);
  const { username, logout } = useAuthStore();
  const queryClient = useQueryClient();
  // 退出登录是 SPA 内部跳转（不刷新页面），必须一并清掉 React Query 缓存和
  // 用户级 zustand/localStorage 状态，否则换账号登录后 projectSummaries 等
  // 查询还在 staleTime 内，新账号会直接看到上一个账号的项目列表。
  const handleLogout = async () => {
    await logout();
    resetUserSessionState({ queryClient });
  };
  const avatarUrl = useAuthStore((s) => s.avatarUrl);
  const companionKind = useAppStore((s) => s.companionKind);
  const companionPet = useAppStore((s) => s.companionPet);
  const pikoAccessory = useAppStore((s) => s.pikoAccessory);
  const setCompanion = useAppStore((s) => s.setCompanion);
  const setPikoAccessory = useAppStore((s) => s.setPikoAccessory);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const showLogout = authRequired();
  const ceRuntime = isCeRuntime();
  const displayName = username ?? "User";
  const avatarInitial = displayName.slice(0, 1).toUpperCase();
  const activeLanguage = (i18n.resolvedLanguage ?? i18n.language).startsWith("zh")
    ? "zh"
    : "en";
  const modelGatewayConfig = useModelGatewayConfig(ceRuntime);
  const releaseNotifications = useReleaseNotifications(i18n.resolvedLanguage ?? i18n.language);
  const releaseFeed = releaseNotifications.data?.data;
  void releaseNotificationStateVersion;
  const hasUnreadNotification = shouldShowUpgradeNudge(releaseFeed);
  const gatewayConfig = modelGatewayConfig.data?.data;
  const hasSettingsWarning = Boolean(
    ceRuntime &&
      gatewayConfig &&
      (gatewayConfig.effective.configured === false ||
        gatewayConfig.mediaRelay?.configured === false),
  );
  const settingsWarningBubble = useFloatingBubblePosition(
    settingsAnchorRef,
    hasSettingsWarning && !settingsOpen && !settingsWarningBubbleDismissed,
  );

  useEffect(() => {
    return () => {
      clearAccountCloseTimer();
      clearAccountUnmountTimer();
      clearAccountOpenFrame();
    };
  }, []);

  useEffect(() => {
    if (!hasSettingsWarning) {
      setSettingsWarningBubbleDismissed(false);
    }
  }, [hasSettingsWarning]);

  const handleCompanionConfirm = (
    selection: CompanionSelection,
    accessory: typeof pikoAccessory,
  ) => {
    setCompanion(selection.kind, selection.pet);
    setPikoAccessory(accessory);
    window.dispatchEvent(new Event("mybuddy-companion-reset"));
  };

  const clearAccountCloseTimer = () => {
    if (accountCloseTimerRef.current === null) return;
    window.clearTimeout(accountCloseTimerRef.current);
    accountCloseTimerRef.current = null;
  };

  const clearAccountUnmountTimer = () => {
    if (accountUnmountTimerRef.current === null) return;
    window.clearTimeout(accountUnmountTimerRef.current);
    accountUnmountTimerRef.current = null;
  };

  const clearAccountOpenFrame = () => {
    if (accountOpenFrameRef.current === null) return;
    window.cancelAnimationFrame(accountOpenFrameRef.current);
    accountOpenFrameRef.current = null;
  };

  const closeAccountPanelNow = () => {
    clearAccountCloseTimer();
    clearAccountOpenFrame();
    clearAccountUnmountTimer();
    setAccountPanelVisible(false);
    setAccountPanelOpen(false);
  };

  const openAccountPanel = () => {
    clearAccountCloseTimer();
    clearAccountUnmountTimer();
    clearAccountOpenFrame();
    const rect = accountAnchorRef.current?.getBoundingClientRect();
    if (rect) {
      setAccountPanelPosition({
        top: Math.round(rect.bottom + 8),
        right: Math.round(window.innerWidth - rect.right),
      });
    }
    setAccountPanelOpen(true);
    accountOpenFrameRef.current = window.requestAnimationFrame(() => {
      setAccountPanelVisible(true);
      accountOpenFrameRef.current = null;
    });
  };

  const scheduleCloseAccountPanel = () => {
    clearAccountCloseTimer();
    accountCloseTimerRef.current = window.setTimeout(() => {
      setAccountPanelVisible(false);
      clearAccountUnmountTimer();
      accountUnmountTimerRef.current = window.setTimeout(() => {
        setAccountPanelOpen(false);
        accountUnmountTimerRef.current = null;
      }, ACCOUNT_PANEL_TRANSITION_MS);
      accountCloseTimerRef.current = null;
    }, 120);
  };

  const switchLanguage = (lang: "zh" | "en") => {
    void i18n.changeLanguage(lang);
    setLanguage(lang);
  };

  const openNotifications = () => {
    closeAccountPanelNow();
    markUpgradeSeen(releaseFeed?.latest_tag);
    setReleaseNotificationStateVersion((version) => version + 1);
    setNotificationOpen(true);
  };

  const handleUpgradeStateChange = useCallback(() => {
    setReleaseNotificationStateVersion((version) => version + 1);
  }, []);

  const openAvatarDialog = () => {
    closeAccountPanelNow();
    setAvatarDialogOpen(true);
  };

  return (
    <header className="flex h-[48px] shrink-0 items-center justify-between gap-3 border-b border-white/[0.05] bg-background/58 px-4 text-sidebar-foreground backdrop-blur-xl">
      <div className="flex min-w-0 items-center">
        <TooltipProvider delay={80}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  to="/"
                  aria-label={t("app.logoHomeTooltip")}
                  className="flex min-w-0 items-center"
                />
              }
            >
              <img
                src="/brand/dramaclaw-wordmark.png"
                alt=""
                aria-hidden="true"
                className="h-[22.7px] w-auto max-w-[113px] object-contain"
              />
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              sideOffset={10}
              showArrow={false}
              className="border border-white/10 bg-background/95 text-foreground shadow-none"
            >
              {t("app.logoHomeTooltip")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <LiexiaorenSkinPreview />
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1">
        {/* 设置仅在 CE 版显示,EE 版隐藏 */}
        {ceRuntime ? (
          <div ref={settingsAnchorRef} className="relative">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="relative size-[32px] text-sidebar-foreground/82 transition-colors duration-150 ease-[var(--ease-out-quint)] hover:bg-white/[0.05] hover:text-white aria-expanded:bg-white/[0.05] aria-expanded:text-white"
              aria-label={
                hasSettingsWarning ? t("header.settingsWithWarning") : t("header.settings")
              }
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen(true)}
            >
              <Bolt className="size-[17px]" />
              {hasSettingsWarning ? (
                <span
                  className="absolute right-[5px] top-[5px] flex size-[11px] items-center justify-center rounded-full bg-amber-400 text-black shadow-[0_0_7px_rgba(251,191,36,0.68)]"
                  aria-hidden="true"
                >
                  <AlertTriangle className="size-[8px]" strokeWidth={3} />
                </span>
              ) : null}
            </Button>
          </div>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="group/notification relative size-[32px] text-sidebar-foreground/82 transition-colors duration-150 ease-[var(--ease-out-quint)] hover:bg-white/[0.05] hover:text-white aria-expanded:bg-white/[0.05] aria-expanded:text-white"
          aria-label={t("header.notifications")}
          aria-expanded={notificationOpen}
          onClick={openNotifications}
        >
          <Bell className="size-[17px]" />
          {hasUnreadNotification ? (
            <span
              className="absolute right-[8px] top-[8px] size-1 rounded-full bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.72)]"
              aria-hidden="true"
            />
          ) : null}
        </Button>
        <Button
          id="mybuddy-companion-entry"
          type="button"
          variant="ghost"
          size="icon-sm"
          className="companion-capsule-entry -ml-0.5 -mr-0.5 size-[32px] transition-colors duration-150 ease-[var(--ease-out-quint)] hover:bg-white/[0.06] aria-expanded:bg-white/[0.06]"
          onClick={() => setCompanionOpen(true)}
          aria-label={t("myBuddy.companion.entry")}
        >
          <img
            src="/piko/entry/companion-capsule.png"
            alt=""
            aria-hidden="true"
            className="companion-capsule-entry__icon size-[22px] object-contain [image-rendering:pixelated]"
          />
        </Button>
        <CreditBalanceBadge />
        <div
          id="superchat-header-controls"
          className="flex min-w-0 shrink items-center gap-2 empty:hidden"
        />
        <div
          ref={accountAnchorRef}
          className="relative ml-1 flex items-center"
          onMouseEnter={openAccountPanel}
          onMouseLeave={scheduleCloseAccountPanel}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-[28px] rounded-full p-0 hover:bg-transparent"
            aria-label={t("header.account.open")}
          >
            <span className="flex size-[26px] items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-slate-200 to-slate-500 text-[11px] font-semibold text-slate-950 ring-1 ring-white/20">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                avatarInitial
              )}
            </span>
          </Button>
        </div>
      </div>
      {accountPanelOpen
        ? createPortal(
            <AccountPanel
              activeLanguage={activeLanguage}
              avatarInitial={avatarInitial}
              avatarUrl={avatarUrl}
              displayName={displayName}
              onChangeAvatar={openAvatarDialog}
              onLanguageChange={switchLanguage}
              onClose={scheduleCloseAccountPanel}
              onEnter={openAccountPanel}
              onLogout={showLogout ? () => void handleLogout() : undefined}
              position={accountPanelPosition}
              visible={accountPanelVisible}
              t={t}
            />,
            document.body,
          )
        : null}
      <PetGalleryDialog
        open={companionOpen}
        onOpenChange={setCompanionOpen}
        currentKind={companionKind}
        currentPet={companionPet}
        currentAccessory={pikoAccessory}
        onConfirm={handleCompanionConfirm}
      />
      <NotificationDrawer
        open={notificationOpen}
        onOpenChange={setNotificationOpen}
        onUpgradeStateChange={handleUpgradeStateChange}
      />
      <AvatarUploadDialog
        avatarInitial={avatarInitial}
        displayName={displayName}
        open={avatarDialogOpen}
        onOpenChange={setAvatarDialogOpen}
      />
      {ceRuntime ? <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} /> : null}
      {settingsWarningBubble
        ? createPortal(
            <div
              className="fixed z-[9999] w-[112px] rounded-md border border-amber-400/45 bg-amber-400 py-1 pl-2 pr-6 text-[11px] font-medium leading-none text-black shadow-[0_8px_22px_rgba(0,0,0,0.36),0_0_12px_rgba(251,191,36,0.28)]"
              style={{ left: settingsWarningBubble.left, top: settingsWarningBubble.top }}
              role="status"
            >
              <span
                className="absolute -top-[4px] size-2 rotate-45 border-l border-t border-amber-400/45 bg-amber-400"
                style={{ left: settingsWarningBubble.arrowLeft }}
                aria-hidden="true"
              />
              <span className="block truncate">{t("header.settingsWarningBubble")}</span>
              <button
                type="button"
                className="absolute right-1 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-full text-black/70 transition-colors hover:bg-black/10 hover:text-black"
                aria-label={t("header.dismissSettingsWarningBubble")}
                onClick={() => setSettingsWarningBubbleDismissed(true)}
              >
                <X className="size-3" strokeWidth={3} />
              </button>
            </div>,
            document.body,
          )
        : null}
    </header>
  );
}

function useFloatingBubblePosition(
  anchorRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): { left: number; top: number; arrowLeft: number } | null {
  const [position, setPosition] = useState<{ left: number; top: number; arrowLeft: number } | null>(
    null,
  );

  useEffect(() => {
    if (!enabled) {
      setPosition(null);
      return;
    }

    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) {
        setPosition(null);
        return;
      }
      const bubbleWidth = 112;
      const viewportPadding = 8;
      const idealLeft = rect.left + rect.width / 2 - bubbleWidth / 2;
      const left = Math.min(
        Math.max(viewportPadding, idealLeft),
        window.innerWidth - bubbleWidth - viewportPadding,
      );
      setPosition({
        left,
        top: rect.bottom + 7,
        arrowLeft: rect.left + rect.width / 2 - left - 4,
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, enabled]);

  return position;
}

function AccountPanel({
  activeLanguage,
  avatarInitial,
  avatarUrl,
  displayName,
  onChangeAvatar,
  onLanguageChange,
  onClose,
  onEnter,
  onLogout,
  position,
  visible,
  t,
}: {
  activeLanguage: "zh" | "en";
  avatarInitial: string;
  avatarUrl: string | null;
  displayName: string;
  onChangeAvatar: () => void;
  onLanguageChange: (lang: "zh" | "en") => void;
  onClose: () => void;
  onEnter: () => void;
  onLogout?: () => void;
  position: { top: number; right: number };
  visible: boolean;
  t: (key: string) => string;
}) {
  const [languageOpen, setLanguageOpen] = useState(false);
  const activeLanguageLabel = activeLanguage === "zh"
    ? t("header.account.languageChinese")
    : t("header.account.languageEnglish");

  return (
    <div
      className={`fixed z-[80] w-[216px] transition-opacity duration-[350ms] ease-[var(--ease-out-quint)] ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      style={{ top: position.top, right: position.right }}
      onMouseEnter={onEnter}
      onMouseLeave={onClose}
    >
      <div className="rounded-[14px] border border-white/[0.08] bg-[#202020]/78 p-2.5 text-slate-100 shadow-[0_18px_50px_rgba(0,0,0,0.36)] backdrop-blur-xl">
        <div className="mb-2.5 flex h-[50px] items-center gap-2.5 rounded-[10px] bg-white/[0.07] px-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-slate-200 to-slate-500 text-xs font-semibold text-slate-950">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="size-full object-cover" />
            ) : (
              avatarInitial
            )}
          </span>
          <span className="min-w-0 truncate text-[15px] font-medium text-white">
            {displayName}
          </span>
        </div>
        <div className="space-y-0.5">
          {!isCeRuntime() ? (
            <AccountMenuRow
              icon={<Camera className="size-3.5" />}
              label={t("header.account.changeAvatar")}
              onClick={onChangeAvatar}
            />
          ) : null}
          <AccountMenuRow
            active={languageOpen}
            icon={<Languages className="size-3.5" />}
            label={t("header.account.selectLanguage")}
            meta={activeLanguageLabel}
            onClick={() => setLanguageOpen((open) => !open)}
          />
          {languageOpen ? (
            <div className="ml-[30px] mr-1 space-y-0.5 pb-1">
              <PreferenceOption
                active={activeLanguage === "zh"}
                label={t("header.account.languageChinese")}
                onClick={() => onLanguageChange("zh")}
              />
              <PreferenceOption
                active={activeLanguage === "en"}
                label={t("header.account.languageEnglish")}
                onClick={() => onLanguageChange("en")}
              />
            </div>
          ) : null}
          {onLogout ? (
            <AccountMenuRow
              icon={<LogOut className="size-3.5" />}
              label={t("auth.logout")}
              onClick={onLogout}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AccountMenuRow({
  active = false,
  icon,
  label,
  meta,
  onClick,
}: {
  active?: boolean;
  icon: ReactNode;
  label: string;
  meta?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="flex h-9 w-full items-center gap-2 rounded-[8px] px-1.5 text-left text-[13px] font-normal text-slate-100 transition-colors duration-150 hover:bg-white/[0.05]"
      onClick={onClick}
    >
      <span className="ml-1 flex size-3.5 shrink-0 items-center justify-center text-slate-100/58" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta ? (
        <span className="max-w-16 truncate text-[11px] text-slate-400">{meta}</span>
      ) : null}
      <ChevronRight
        className={`mr-1 size-3.5 shrink-0 text-slate-100/88 transition-transform duration-150 ${
          active ? "rotate-90" : ""
        }`}
      />
    </button>
  );
}

function PreferenceOption({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex h-7 w-full items-center justify-between rounded-[7px] px-2 text-left text-[11px] text-slate-100/78 transition-colors duration-150 hover:bg-white/[0.05] hover:text-white"
      onClick={onClick}
    >
      <span>{label}</span>
      {active ? <Check className="size-3.5 text-cyan-300" /> : null}
    </button>
  );
}
