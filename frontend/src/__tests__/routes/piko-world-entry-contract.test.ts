// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dashboard = readFileSync("src/routes/_app/index.tsx", "utf8");
const appLayout = readFileSync("src/routes/_app.tsx", "utf8");
const worldRoute = readFileSync("src/routes/piko-world.tsx", "utf8");
const worldCanvas = readFileSync("src/features/piko-world/PikoWorldCanvas.tsx", "utf8");
const worldShell = readFileSync("src/features/piko-world/PikoWorldShell.tsx", "utf8");
const residentSelector = readFileSync(
  "src/features/piko-world/PikoResidentSelectorDialog.tsx",
  "utf8",
);
const threeSlicePanelSkin = readFileSync(
  "src/features/piko-world/PikoThreeSlicePanelSkin.tsx",
  "utf8",
);
const residents = readFileSync("src/features/piko-world/piko-residents.ts", "utf8");
const worldOverlayMotion = readFileSync(
  "src/features/piko-world/piko-world-overlay-motion.ts",
  "utf8",
);
const zh = JSON.parse(readFileSync("public/locales/zh/translation.json", "utf8"));
const en = JSON.parse(readFileSync("public/locales/en/translation.json", "utf8"));

describe("Piko World 项目中心入口", () => {
  it("通过顶部统一入口进入世界，撤下项目中心悬浮入口", () => {
    const header = readFileSync("src/components/layout/header.tsx", "utf8");
    expect(dashboard).not.toContain("<PikoWorldFloatingEntry />");
    expect(header).toContain("Piko Piko");
    expect(header).toContain("openOnHover");
    expect(header).toContain('navigate({ to: "/piko-world" })');
    expect(header).toContain('t("header.pikoHub.play")');
    expect(header).toContain('t("header.pikoHub.companion")');
    expect(appLayout).toContain('"piko-open-station"');
  });

  it("世界页面独立于工作台外壳并完整适配视口", () => {
    expect(worldRoute).toContain('createFileRoute("/piko-world")');
    expect(worldCanvas).toContain("containWorldInViewport");
    expect(worldShell).toContain("aspect-video");
    expect(worldShell).toContain("overflow-hidden rounded-xl bg-background");
    expect(worldShell).not.toContain(
      "rounded-xl border border-border bg-background shadow-2xl",
    );
    expect(worldShell).toContain("flex items-center justify-center overflow-hidden");
    expect(worldShell).toContain('className="absolute left-4 top-4 z-20');
    expect(worldShell).toContain("piko-world-return-icon-v2.png");
    expect(worldShell).toContain("piko-world-chat-icon-v2.png");
    expect(worldShell).toContain("piko-world-settings-icon-v1.png");
    expect(worldShell).toContain("piko-world-page-background-day-v1.png");
    expect(worldShell).toContain('className="size-full object-cover"');
    expect(worldShell).toContain('className="absolute inset-0 bg-black/35"');
    expect(worldShell).toContain('className="absolute right-4 top-4 z-20"');
    expect(worldShell).toContain("<PikoResidentSelectorDialog");
    expect(worldShell).toContain("safeLocalStorageSet(PIKO_RESIDENT_STORAGE_KEY, residentId)");
    expect(worldShell).toContain("piko-world-public-chat-panel-top-v3.png");
    expect(worldShell).toContain("piko-world-public-chat-panel-middle-v2.png");
    expect(worldShell).toContain("piko-world-public-chat-panel-bottom-v2.png");
    expect(worldShell).not.toContain("piko-world-chat-panel-skin-v1.png");
    expect(worldShell).toContain("<PikoThreeSlicePanelSkin");
    expect(worldShell).not.toContain("function ChatInputSkin()");
    expect(worldShell).not.toContain("function SkinSlice(");
    expect(threeSlicePanelSkin).toContain("h-px min-h-0 w-full flex-1");
    expect(threeSlicePanelSkin).toContain("drop-shadow-black/50");
    expect(worldShell).toContain("flex items-center gap-5");
    expect(worldShell).toContain("inline-flex size-9 items-center justify-center");
    expect(worldShell).toContain("unreadChatCount");
    expect(worldShell).toContain("!message.mine && message.unread ? 1 : 0");
    expect(worldShell).toContain("unreadChatCount > 99 ? \"99+\" : unreadChatCount");
    expect(worldShell).toContain("border-amber-950/45 bg-amber-400");
    expect(worldShell).toContain("absolute -right-[3px] -top-[3px]");
    expect(worldShell).not.toContain("text-amber-950 shadow-sm");
    expect(worldShell).toContain('t("pikoWorld.chatToggleUnread", { count: unreadChatCount })');
    expect(worldShell).toContain("if (message.mine || !message.unread) return message");
    expect(worldShell).toContain("return changed ? nextMessages : messages");
    expect(worldShell).not.toContain("CONTROL_TOOLTIP_CLASS");
    expect(worldShell).not.toContain("<TooltipProvider");
    expect(worldShell).not.toContain("<Tooltip");
    expect(worldShell).toContain("piko-world-control-label-return-v1.png");
    expect(worldShell).toContain("piko-world-control-label-chat-v1.png");
    expect(worldShell).toContain("piko-world-control-label-settings-v1.png");
    expect(worldShell).toContain('aria-controls="piko-world-chat-panel"');
    expect(worldShell).toContain("aria-expanded={chatOpen}");
    expect(worldShell).toContain('event.key !== "Escape"');
    expect(worldShell).toContain('to="/"');
    expect(worldShell).toContain('t("pikoWorld.chatTitle")');
    expect(worldShell).not.toContain('t("pikoWorld.chatStatus")');
    expect(worldShell).toContain('t("pikoWorld.chatClose")');
    expect(worldShell).not.toContain('t("pikoWorld.chatSend")');
    expect(worldShell).not.toContain("<Send");
    expect(worldShell).toContain("absolute bottom-4 left-4 top-16");
    expect(worldShell).toContain("origin-top-left");
    expect(worldShell).toContain("PIKO_WORLD_OVERLAY_TRANSITION_CLASS");
    expect(worldShell).toContain("pikoWorldOverlayVisibilityClass(chatOpen)");
    expect(worldOverlayMotion).toContain("transition-[opacity,translate,scale]");
    expect(worldOverlayMotion).toContain("duration-[var(--duration-slow)]");
    expect(worldOverlayMotion).toContain("ease-[var(--ease-out-quint)]");
    expect(worldOverlayMotion).toContain("motion-reduce:transition-none");
    expect(worldShell).toContain('data-state={chatOpen ? "open" : "closed"}');
    expect(worldShell).toContain("aria-hidden={!chatOpen}");
    expect(worldShell).toContain("inert={!chatOpen}");
    expect(worldOverlayMotion).toContain("-translate-x-1.25 -translate-y-1.75 scale-100 opacity-100");
    expect(worldOverlayMotion).toContain("-translate-x-3.25 -translate-y-3.75 scale-[0.98] opacity-0");
    expect(worldShell).toContain("chatMessages.map");
    expect(worldShell).toContain("chatMessages.length === 0");
    expect(worldShell).toContain('t("pikoWorld.chatEmptyTitle")');
    expect(worldShell).toContain('t("pikoWorld.chatEmptyDescription")');
    expect(worldShell).toContain("chatMockMayorWelcome");
    expect(worldShell).toContain("chatMockResidentLantern");
    expect(worldShell).toContain("chatMockVisitorReply");
    expect(worldShell).toContain("overflow-y-auto px-4 py-2");
    expect(worldShell).toContain('role="log"');
    expect(worldShell).toContain('aria-live="polite"');
    expect(worldShell).toContain('aria-relevant="additions text"');
    expect(worldShell).toContain('t("pikoWorld.chatMessagesLabel")');
    expect(worldShell).toContain("rounded-[min(var(--radius-sm),8px)]");
    expect(worldShell).toContain("px-2.5 py-1.5 text-xs leading-4");
    expect(worldShell).not.toContain("borderImageSlice");
    expect(worldShell).not.toContain("backdrop-blur-tap pointer-events-none");
    expect(worldShell).toContain("mx-4 h-16 -translate-y-1.25 shrink-0");
    expect(worldShell).toContain("rounded-[min(var(--radius-sm),10px)]");
    expect(worldShell).toContain("py-2.5 !text-xs");
    expect(worldShell).toContain("value={chatDraft}");
    expect(worldShell).toContain("setChatDraft(event.target.value)");
    expect(worldShell).toContain("event.stopPropagation()");
    expect(worldShell).toContain('event.key !== "Enter"');
    expect(worldShell).toContain("event.shiftKey");
    expect(worldShell).toContain("event.nativeEvent.isComposing");
    expect(worldShell).toContain("event.preventDefault()");
    expect(worldShell).toContain("submitChatDraft()");
    expect(worldShell).toContain("list.scrollTop = list.scrollHeight");
    expect(worldShell).not.toContain("<Textarea\n              disabled");
    expect(worldShell).not.toContain("bg-white/75 shadow-sm");
    expect(worldShell).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(worldShell).not.toContain("text-[11px]");
    expect(worldCanvas).not.toContain("onWheel");
    expect(worldCanvas).not.toContain("pointermove");
    expect(worldCanvas).toContain('t("pikoWorld.mapLoading")');
    expect(worldCanvas).not.toContain("正在加载初遇庭院");
  });

  it("使用三段式主题弹窗选择并保存居民", () => {
    expect(residentSelector).toContain("piko-world-resident-selector-panel-top-v1.png");
    expect(residentSelector).toContain("piko-world-resident-selector-panel-middle-v1.png");
    expect(residentSelector).toContain("piko-world-resident-selector-panel-bottom-v1.png");
    expect(residentSelector).toContain("piko-world-close-icon-v1.png");
    expect(residentSelector).toContain("<PikoThreeSlicePanelSkin");
    expect(residentSelector).toContain("grid-cols-5 grid-rows-2");
    expect(residentSelector).toContain("group/resident");
    expect(residentSelector).toContain("group-hover/resident:brightness-110");
    expect(residentSelector).toContain("bg-[radial-gradient(ellipse_at_center");
    expect(residentSelector).not.toContain("bg-white/35");
    expect(residentSelector).toContain('role="radiogroup"');
    expect(residentSelector).toContain('role="radio"');
    expect(residentSelector).toContain("draftResidentId");
    expect(residentSelector).toContain("ArrowDown: 5");
    expect(residentSelector).toContain("duration-[var(--duration-slow)]");
    expect(residents).toContain('PIKO_RESIDENT_STORAGE_KEY = "dramaclaw.piko-world.resident-id.v1"');
    expect(residents.match(/id: "[mf]\d{2}"/g)).toHaveLength(10);
  });

  it("提供中英文入口文案", () => {
    expect(zh.project.pikoWorldEntry).toBe("进入 Piko Piko 世界");
    expect(en.project.pikoWorldEntry).toBe("Enter Piko Piko World");
    expect(zh.project.pikoWorldEntryDragHint).toContain("按住可拖动");
    expect(en.project.pikoWorldEntryDragHint).toContain("drag");
    expect(zh.pikoWorld.returnToWorkbench).toBe("回到工作台");
    expect(zh.pikoWorld.chatTitle).toBe("世界聊天");
    expect(zh.pikoWorld.chatClose).toBe("关闭世界聊天");
    expect(zh.pikoWorld.chatToggleUnread).toContain("未读消息");
    expect(zh.pikoWorld.chatEmptyTitle).toBe("风还没有捎来消息");
    expect(zh.pikoWorld.chatEmptyDescription).toContain("小镇的问候");
    expect(zh.pikoWorld.chatMessagesLabel).toBe("聊天消息");
    expect(zh.pikoWorld.chatComposerPlaceholder).toBe("和小镇的大家说点什么吧…");
    expect(zh.pikoWorld.chatMockMayorName).toBe("Piko 镇长");
    expect(zh.pikoWorld.chatMockMayorWelcome).toContain("初遇庭院");
    expect(zh.pikoWorld.mapAriaLabel).toBe("初遇庭院，可使用方向键移动");
    expect(zh.pikoWorld.openResidentSelector).toBe("选择居民角色");
    expect(zh.pikoWorld.residentSelectorTitle).toBe("选择你的居民");
    expect(zh.pikoWorld.residentSelectorConfirm).toBe("选好了");
    expect(en.pikoWorld.chatTitle).toBe("World chat");
    expect(en.pikoWorld.chatClose).toBe("Close world chat");
    expect(en.pikoWorld.chatToggleUnread).toContain("Unread messages");
    expect(en.pikoWorld.chatMessagesLabel).toBe("Chat messages");
    expect(en.pikoWorld.chatComposerPlaceholder).toBe("Say something to everyone in town…");
    expect(en.pikoWorld.chatMockMayorName).toBe("Mayor Piko");
    expect(en.pikoWorld.openResidentSelector).toBe("Choose resident character");
  });
});
