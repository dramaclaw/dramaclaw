// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 「带着这段内容去问虾导」的一次性投递通道。
 *
 * 为什么是这么一个小store，而不是给 SuperChatPanel 加一个 scope/prefill 参数：
 * SuperChatPanel 3600 行、use-superchat 1100 行，会话 scope 是从路由参数推出来的，
 * 要把一个外部 scope 穿透进去，改动面会铺满整条聊天链路。而实际需要的其实只有
 * 「把一段文字放进输入框并把面板打开」——那是一次性投递，不是新的会话维度。
 *
 * 刻意不持久化：草稿过了这一次就没意义了，留到下次启动只会突然冒出一段陈年文字。
 */
import { create } from "zustand";

interface AssistantDraftState {
  /** 待投递的草稿；被消费后立即回到 null。 */
  pending: string | null;
  /** 投递一段草稿（通常紧接着把助手面板打开）。 */
  requestDraft: (text: string) => void;
  /** 取走并清空。由聊天面板调用，保证同一段只会被填一次。 */
  consumeDraft: () => string | null;
}

export const useAssistantDraftStore = create<AssistantDraftState>((set, get) => ({
  pending: null,
  requestDraft: (text) => set({ pending: text }),
  consumeDraft: () => {
    const { pending } = get();
    if (pending !== null) set({ pending: null });
    return pending;
  },
}));
