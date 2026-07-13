// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { quotaSafeStateStorage } from "@/lib/localStorageQuota";
import type { PikoAccessoryDisplayId } from "@/features/companion/piko-accessories";

export type RewardEventSource = "points" | "system";
export type RewardEventStatus = "pending" | "seen" | "claimed";

export type AccessoryRewardEvent = {
  id: string;
  type: "accessory";
  rewardId: PikoAccessoryDisplayId;
  source: RewardEventSource;
  status: RewardEventStatus;
  createdAt: string;
};

type RewardEventsState = {
  events: AccessoryRewardEvent[];
  upsertEvents: (events: AccessoryRewardEvent[]) => void;
  triggerMockAccessoryUnlock: () => void;
  triggerMockAccessoryBatchUnlock: () => void;
  markSeen: (id: string) => void;
  markSeenBatch: (ids: string[]) => void;
  claim: (id: string) => void;
  claimBatch: (ids: string[]) => void;
  reset: () => void;
};

// Cap how many events we persist so the blob can't grow without bound. Events
// are tiny, so the limit is generous; actionable (pending/seen) events are
// always retained — only the historical claimed tail is trimmed.
const EVENTS_PERSIST_LIMIT = 200;

export function capPersistedRewardEvents(
  events: AccessoryRewardEvent[],
): AccessoryRewardEvent[] {
  if (events.length <= EVENTS_PERSIST_LIMIT) return events;
  const actionable = events.filter((event) => event.status !== "claimed");
  const claimedBudget = Math.max(0, EVENTS_PERSIST_LIMIT - actionable.length);
  const keptClaimed = events
    .filter((event) => event.status === "claimed")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, claimedBudget);
  const keep = new Set<AccessoryRewardEvent>([...actionable, ...keptClaimed]);
  // Preserve the original ordering for the retained subset.
  return events.filter((event) => keep.has(event));
}

const MOCK_EVENT_ID = "mock-accessory-unlock-founder-medal";
const MOCK_BATCH_ACCESSORY_IDS = [
  "piko-accessory-founder-medal",
  "piko-accessory-code-ling",
  "piko-accessory-dark-knight-mask",
] as const satisfies readonly PikoAccessoryDisplayId[];

export function getPendingRewardEvent(events: AccessoryRewardEvent[]): AccessoryRewardEvent | null {
  return events.find((event) => event.status === "pending") ?? null;
}

export function getPendingRewardEvents(events: AccessoryRewardEvent[]): AccessoryRewardEvent[] {
  return events.filter((event) => event.status === "pending");
}

export function getSeenRewardEvent(events: AccessoryRewardEvent[]): AccessoryRewardEvent | null {
  return events.find((event) => event.status === "seen") ?? null;
}

export function getSeenRewardEvents(events: AccessoryRewardEvent[]): AccessoryRewardEvent[] {
  return events.filter((event) => event.status === "seen");
}

export const useRewardEventsStore = create<RewardEventsState>()(
  persist(
    (set, get) => ({
      events: [],
      upsertEvents: (events) =>
        set((state) => {
          const byId = new Map(state.events.map((event) => [event.id, event]));
          events.forEach((event) => {
            byId.set(event.id, { ...byId.get(event.id), ...event });
          });
          return { events: Array.from(byId.values()) };
        }),
      triggerMockAccessoryUnlock: () => {
        const event: AccessoryRewardEvent = {
          id: `mock-accessory-unlock-${Date.now()}`,
          type: "accessory",
          rewardId: "piko-accessory-founder-medal",
          source: "system",
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        get().upsertEvents([event]);
      },
      triggerMockAccessoryBatchUnlock: () => {
        const createdAt = new Date().toISOString();
        const batchId = Date.now();
        get().upsertEvents(
          MOCK_BATCH_ACCESSORY_IDS.map((rewardId, index) => ({
            id: `mock-accessory-batch-unlock-${batchId}-${index}`,
            type: "accessory",
            rewardId,
            source: "system",
            status: "pending",
            createdAt,
          })),
        );
      },
      markSeen: (id) =>
        set((state) => ({
          events: state.events.map((event) =>
            event.id === id && event.status === "pending"
              ? { ...event, status: "seen" }
              : event,
          ),
        })),
      markSeenBatch: (ids) =>
        set((state) => {
          const idSet = new Set(ids);
          return {
            events: state.events.map((event) =>
              idSet.has(event.id) && event.status === "pending"
                ? { ...event, status: "seen" }
                : event,
            ),
          };
        }),
      claim: (id) =>
        set((state) => ({
          events: state.events.map((event) =>
            event.id === id ? { ...event, status: "claimed" } : event,
          ),
        })),
      claimBatch: (ids) =>
        set((state) => {
          const idSet = new Set(ids);
          return {
            events: state.events.map((event) =>
              idSet.has(event.id) ? { ...event, status: "claimed" } : event,
            ),
          };
        }),
      reset: () => set({ events: [] }),
    }),
    {
      name: "supertale-reward-events",
      version: 1,
      storage: createJSONStorage(() => quotaSafeStateStorage),
      partialize: (state) => ({ events: capPersistedRewardEvents(state.events) }),
      // v0 时代 DEV 会自动注入一个「创始勋章」mock 奖励，不领取就一直弹
      // Piko 气泡。迁移时把这个未领取的种子事件清掉；已领取的保留（饰品
      // 已经归属用户）。
      migrate: (persisted: unknown) => {
        const base = (persisted ?? {}) as { events?: AccessoryRewardEvent[] };
        return {
          events: (base.events ?? []).filter(
            (event) => event.id !== MOCK_EVENT_ID || event.status === "claimed",
          ),
        };
      },
    },
  ),
);
