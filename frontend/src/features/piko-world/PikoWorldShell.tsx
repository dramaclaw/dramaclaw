// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link } from "@tanstack/react-router";
import { Leaf } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { safeLocalStorageSet } from "@/lib/localStorageQuota";
import { PikoWorldCanvas } from "./PikoWorldCanvas";
import { PikoMapTransition } from "./PikoMapTransition";
import { PikoResidentSelectorDialog } from "./PikoResidentSelectorDialog";
import { PikoThreeSlicePanelSkin } from "./PikoThreeSlicePanelSkin";
import {
  PIKO_RESIDENT_STORAGE_KEY,
  readSelectedPikoResidentId,
} from "./piko-residents";
import {
  PIKO_WORLD_OVERLAY_TRANSITION_CLASS,
  pikoWorldOverlayVisibilityClass,
} from "./piko-world-overlay-motion";

const RETURN_CONTROL_SRC = "/piko/world/ui/piko-world-return-icon-v2.png";
const CHAT_CONTROL_SRC = "/piko/world/ui/piko-world-chat-icon-v2.png";
const SETTINGS_CONTROL_SRC = "/piko/world/ui/piko-world-settings-icon-v1.png";
const RETURN_CONTROL_LABEL_SRC =
  "/piko/world/ui/control-labels/piko-world-control-label-return-v1.png";
const CHAT_CONTROL_LABEL_SRC =
  "/piko/world/ui/control-labels/piko-world-control-label-chat-v1.png";
const SETTINGS_CONTROL_LABEL_SRC =
  "/piko/world/ui/control-labels/piko-world-control-label-settings-v1.png";
const CLOSE_CONTROL_SRC = "/piko/world/ui/piko-world-close-icon-v1.png";
const CHAT_PANEL_TOP_SRC = "/piko/world/ui/chat/piko-world-chat-panel-top-v1.png";
const CHAT_PANEL_MIDDLE_SRC = "/piko/world/ui/chat/piko-world-chat-panel-middle-v1.png";
const CHAT_PANEL_BOTTOM_SRC = "/piko/world/ui/chat/piko-world-chat-panel-bottom-v1.png";
const DAY_PAGE_BACKGROUND_SRC =
  "/piko/world/ui/backgrounds/piko-world-page-background-day-v1.png";
const CURRENT_MAP_ID = "welcome-courtyard" as const;

type ChatMessage = {
  id: string;
  authorKey: string;
  bodyKey?: string;
  body?: string;
  time: string;
  mine: boolean;
  unread?: boolean;
};

const CHAT_MOCK_MESSAGES: ChatMessage[] = [
  {
    id: "mayor-welcome",
    authorKey: "pikoWorld.chatMockMayorName",
    bodyKey: "pikoWorld.chatMockMayorWelcome",
    time: "08:40",
    mine: false,
    unread: true,
  },
  {
    id: "resident-lantern",
    authorKey: "pikoWorld.chatMockResidentName",
    bodyKey: "pikoWorld.chatMockResidentLantern",
    time: "08:42",
    mine: false,
    unread: true,
  },
  {
    id: "visitor-reply",
    authorKey: "pikoWorld.chatMockYouName",
    bodyKey: "pikoWorld.chatMockVisitorReply",
    time: "08:43",
    mine: true,
  },
];

function currentChatTime(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function PikoWorldShell() {
  const { t } = useTranslation();
  const [chatOpen, setChatOpen] = useState(false);
  const [mapLoadState, setMapLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [residentSelectorOpen, setResidentSelectorOpen] = useState(false);
  const [selectedResidentId, setSelectedResidentId] = useState(readSelectedPikoResidentId);
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => [
    ...CHAT_MOCK_MESSAGES,
  ]);
  const chatButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const chatMessageListRef = useRef<HTMLDivElement>(null);
  const unreadChatCount = chatMessages.reduce(
    (count, message) => count + (!message.mine && message.unread ? 1 : 0),
    0,
  );
  const handleMapLoadStateChange = useCallback(
    (loadState: "loading" | "ready" | "error") => setMapLoadState(loadState),
    [],
  );

  useEffect(() => {
    if (!chatOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setChatOpen(false);
      chatButtonRef.current?.focus();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [chatOpen]);

  useEffect(() => {
    if (!chatOpen) return;
    const list = chatMessageListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [chatMessages.length, chatOpen]);

  const submitChatDraft = () => {
    const body = chatDraft.trim();
    if (!body) return;
    setChatMessages((messages) => [
      ...messages,
      {
        id: `local-${Date.now()}`,
        authorKey: "pikoWorld.chatMockYouName",
        body,
        time: currentChatTime(),
        mine: true,
      },
    ]);
    setChatDraft("");
  };

  const handleChatDraftKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") return;
    event.stopPropagation();
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submitChatDraft();
  };

  const handleChatToggle = () => {
    if (chatOpen) {
      setChatOpen(false);
      return;
    }
    setChatOpen(true);
    setChatMessages((messages) => {
      let changed = false;
      const nextMessages = messages.map((message) => {
        if (message.mine || !message.unread) return message;
        changed = true;
        return { ...message, unread: false };
      });
      return changed ? nextMessages : messages;
    });
  };

  const handleResidentSelectorOpenChange = (open: boolean) => {
    setResidentSelectorOpen(open);
    if (!open) window.requestAnimationFrame(() => settingsButtonRef.current?.focus());
  };

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="fixed inset-0 flex items-center justify-center overflow-hidden bg-background p-8 focus:outline-none"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <img
          src={DAY_PAGE_BACKGROUND_SRC}
          alt=""
          className="size-full object-cover"
          draggable={false}
        />
        <div className="absolute inset-0 bg-black/35" />
      </div>

      <section className="relative z-10 aspect-video w-full max-w-[calc(177.7778dvh-7.1111rem)] overflow-hidden rounded-xl bg-background">
        <PikoWorldCanvas
          mapId={CURRENT_MAP_ID}
          onLoadStateChange={handleMapLoadStateChange}
        />

        <nav
          className="absolute left-4 top-4 z-20 flex items-center gap-5"
          aria-label={t("pikoWorld.worldControls")}
        >
          <div className="flex w-9 flex-col items-center gap-0.5">
            <Link
              to="/"
              className="inline-flex size-9 items-center justify-center transition-[filter,transform] duration-[var(--duration-fast)] hover:-translate-y-0.5 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("pikoWorld.returnToWorkbench")}
            >
              <img
                src={RETURN_CONTROL_SRC}
                alt=""
                className="size-9 object-contain"
                draggable={false}
              />
            </Link>
            <img
              src={RETURN_CONTROL_LABEL_SRC}
              alt=""
              aria-hidden="true"
              className="w-[34px] translate-y-0.5 object-contain"
              draggable={false}
            />
          </div>
          <div className="flex w-9 flex-col items-center gap-0.5">
            <button
              ref={chatButtonRef}
              type="button"
              className={cn(
                "relative inline-flex size-9 items-center justify-center overflow-visible transition-[filter,transform] duration-[var(--duration-fast)] hover:-translate-y-0.5 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                chatOpen && "brightness-110",
              )}
              aria-label={
                unreadChatCount > 0
                  ? t("pikoWorld.chatToggleUnread", { count: unreadChatCount })
                  : t("pikoWorld.chatToggle")
              }
              aria-controls="piko-world-chat-panel"
              aria-expanded={chatOpen}
              onClick={handleChatToggle}
            >
              <img
                src={CHAT_CONTROL_SRC}
                alt=""
                className="size-9 object-contain"
                draggable={false}
              />
              {unreadChatCount > 0 && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -right-[3px] -top-[3px] inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-amber-950/45 bg-amber-400 px-1 text-[10px] font-bold leading-none text-amber-950"
                >
                  {unreadChatCount > 99 ? "99+" : unreadChatCount}
                </span>
              )}
            </button>
            <img
              src={CHAT_CONTROL_LABEL_SRC}
              alt=""
              aria-hidden="true"
              className="w-[34px] translate-y-0.5 object-contain"
              draggable={false}
            />
          </div>
        </nav>

        <div className="absolute right-4 top-4 z-20">
          <div className="flex w-9 flex-col items-center gap-0.5">
            <button
              ref={settingsButtonRef}
              type="button"
              className="inline-flex size-9 items-center justify-center transition-[filter,transform] duration-[var(--duration-fast)] hover:-translate-y-0.5 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("pikoWorld.openResidentSelector")}
              aria-controls="piko-world-resident-selector"
              aria-expanded={residentSelectorOpen}
              onClick={() => {
                setChatOpen(false);
                setResidentSelectorOpen(true);
              }}
            >
              <img
                src={SETTINGS_CONTROL_SRC}
                alt=""
                className="size-9 object-contain"
                draggable={false}
              />
            </button>
            <img
              src={SETTINGS_CONTROL_LABEL_SRC}
              alt=""
              aria-hidden="true"
              className="w-[34px] translate-y-0.5 object-contain"
              draggable={false}
            />
          </div>
        </div>

        <PikoResidentSelectorDialog
          open={residentSelectorOpen}
          selectedResidentId={selectedResidentId}
          onOpenChange={handleResidentSelectorOpenChange}
          onConfirm={(residentId) => {
            setSelectedResidentId(residentId);
            safeLocalStorageSet(PIKO_RESIDENT_STORAGE_KEY, residentId);
          }}
        />

        <aside
          id="piko-world-chat-panel"
          className={cn(
            "dark absolute bottom-4 left-4 top-16 z-10 isolate flex w-[min(22rem,calc(100%_-_2rem))] min-h-0 origin-top-left flex-col overflow-visible px-9 pb-14 pt-[5.5rem]",
            PIKO_WORLD_OVERLAY_TRANSITION_CLASS,
            pikoWorldOverlayVisibilityClass(chatOpen),
          )}
          aria-label={t("pikoWorld.chatTitle")}
          aria-hidden={!chatOpen}
          data-state={chatOpen ? "open" : "closed"}
          inert={!chatOpen}
        >
          <PikoThreeSlicePanelSkin
            topSrc={CHAT_PANEL_TOP_SRC}
            middleSrc={CHAT_PANEL_MIDDLE_SRC}
            bottomSrc={CHAT_PANEL_BOTTOM_SRC}
          />

          <button
            type="button"
            className="absolute -right-9 top-5 z-20 inline-flex size-8 items-center justify-center transition-[filter,transform] duration-[var(--duration-fast)] hover:-translate-y-0.5 hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-800/25"
            aria-label={t("pikoWorld.chatClose")}
            onClick={() => {
              setChatOpen(false);
              chatButtonRef.current?.focus();
            }}
          >
            <img
              src={CLOSE_CONTROL_SRC}
              alt=""
              className="size-8 object-contain"
              draggable={false}
            />
          </button>

          <div
            ref={chatMessageListRef}
            className="ui-scrollbar relative z-10 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-2 text-left"
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            aria-label={t("pikoWorld.chatMessagesLabel")}
          >
            {chatMessages.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-2 pb-6 text-center">
                <Leaf
                  aria-hidden="true"
                  className="size-5 text-amber-900/35"
                  strokeWidth={1.75}
                />
                <p className="text-sm font-semibold leading-5 text-primary-foreground/85">
                  {t("pikoWorld.chatEmptyTitle")}
                </p>
                <p className="max-w-60 text-xs leading-4 text-primary-foreground/50">
                  {t("pikoWorld.chatEmptyDescription")}
                </p>
              </div>
            ) : (
              chatMessages.map((message) => (
                <article
                  key={message.id}
                  className={cn(
                    "flex max-w-[88%] flex-col gap-1",
                    message.mine ? "self-end items-end" : "self-start items-start",
                  )}
                >
                  <div className="flex items-center gap-2 px-1 text-xs text-primary-foreground/55">
                    <span className="font-medium text-primary-foreground/70">
                      {t(message.authorKey)}
                    </span>
                    <time>{message.time}</time>
                  </div>
                  <p
                    className={cn(
                      "rounded-[min(var(--radius-sm),8px)] border px-2.5 py-1.5 text-xs leading-4 text-primary-foreground/80",
                      message.mine
                        ? "border-amber-900/15 bg-amber-100/55"
                        : "border-amber-950/10 bg-white/55",
                    )}
                  >
                    {message.body ?? t(message.bodyKey ?? "")}
                  </p>
                </article>
              ))
            )}
          </div>

          <div className="relative z-10 mx-4 h-16 -translate-y-1.25 shrink-0 overflow-hidden rounded-[min(var(--radius-sm),10px)] border border-amber-950/20 bg-white/65 transition-[border-color,box-shadow] duration-[var(--duration-fast)] focus-within:border-amber-950/35 focus-within:ring-2 focus-within:ring-amber-950/10">
            <Textarea
              rows={2}
              value={chatDraft}
              onChange={(event) => setChatDraft(event.target.value)}
              onKeyDown={handleChatDraftKeyDown}
              className="relative z-10 h-full min-h-0 resize-none border-0 !bg-transparent px-3 py-2.5 !text-xs text-primary-foreground shadow-none placeholder:text-primary-foreground/45 focus-visible:ring-0 dark:!bg-transparent"
              placeholder={t("pikoWorld.chatComposerPlaceholder")}
              aria-label={t("pikoWorld.chatComposerPlaceholder")}
            />
          </div>
        </aside>

      </section>
      <PikoMapTransition mapId={CURRENT_MAP_ID} loadState={mapLoadState} />
    </main>
  );
}
