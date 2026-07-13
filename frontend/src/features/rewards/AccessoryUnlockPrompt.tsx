// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  PIKO_ACCESSORIES,
  PIKO_ACCESSORY_DISPLAY_OPTIONS,
} from "@/features/companion/piko-accessories";
import {
  getPendingRewardEvents,
  getSeenRewardEvents,
  useRewardEventsStore,
  type AccessoryRewardEvent,
} from "@/features/rewards/reward-events-store";
import { useAppStore } from "@/stores/app-store";
import "./accessory-unlock.css";

const REWARD_FLIGHT_HIT_DELAY_MS = 2060;
const REWARD_FLIGHT_COMPLETE_DELAY_MS = 2500;

type RewardFlight = {
  id: string;
  src: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  delayMs: number;
};

export function AccessoryUnlockPrompt() {
  const { t } = useTranslation();
  const accessoryRef = useRef<HTMLImageElement | null>(null);
  const batchAccessoryRefs = useRef(new Map<string, HTMLImageElement>());
  const [rewardFlights, setRewardFlights] = useState<RewardFlight[]>([]);
  const [isClaiming, setIsClaiming] = useState(false);
  const events = useRewardEventsStore((state) => state.events);
  const markSeen = useRewardEventsStore((state) => state.markSeen);
  const markSeenBatch = useRewardEventsStore((state) => state.markSeenBatch);
  const claim = useRewardEventsStore((state) => state.claim);
  const claimBatch = useRewardEventsStore((state) => state.claimBatch);
  const setPikoAccessory = useAppStore((state) => state.setPikoAccessory);
  const pendingEvents = getPendingRewardEvents(events);
  const seenEvents = getSeenRewardEvents(events);
  const pendingEvent = pendingEvents[0] ?? null;
  const seenEvent = seenEvents[0] ?? null;
  const isBatchUnlock = seenEvents.length >= 2;
  const seenAccessory = seenEvent?.rewardId && seenEvent.rewardId !== "none"
    ? PIKO_ACCESSORIES[seenEvent.rewardId]
    : null;
  const seenAccessoryLabelKey =
    PIKO_ACCESSORY_DISPLAY_OPTIONS.find((option) => option.id === seenEvent?.rewardId)?.labelKey ??
    "myBuddy.debug.accessories.none";
  const seenRewardItems = seenEvents
    .map((event) => resolveRewardItem(event))
    .filter((item): item is RewardItem => item !== null);

  const completeClaim = () => {
    if (!seenEvent) return;
    if (!isBatchUnlock && seenEvent.rewardId !== "none") {
      setPikoAccessory(seenEvent.rewardId);
    }
    if (isBatchUnlock) {
      claimBatch(seenEvents.map((event) => event.id));
    } else {
      claim(seenEvent.id);
    }
    setIsClaiming(false);
    setRewardFlights([]);
  };

  const handleClaim = () => {
    if (!seenEvent || isClaiming) return;
    const targetButton = document.getElementById("mybuddy-companion-entry");
    const targetIcon = targetButton?.querySelector(".companion-capsule-entry__icon");
    const targetRect = (targetIcon ?? targetButton)?.getBoundingClientRect();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const flightSources = isBatchUnlock
      ? seenRewardItems
          .map((item, index) => ({
            ...item,
            index,
            rect: batchAccessoryRefs.current.get(item.event.id)?.getBoundingClientRect() ?? null,
          }))
          .filter((item) => item.rect !== null)
      : seenAccessory && accessoryRef.current
        ? [{
            event: seenEvent,
            accessory: seenAccessory,
            index: 0,
            rect: accessoryRef.current.getBoundingClientRect(),
          }]
        : [];

    if (flightSources.length === 0 || !targetButton || !targetRect || reducedMotion) {
      completeClaim();
      return;
    }

    const endX = targetRect.left + targetRect.width / 2;
    const endY = targetRect.top + targetRect.height / 2;
    const lastDelayMs = isBatchUnlock ? Math.min((flightSources.length - 1) * 90, 450) : 0;
    setIsClaiming(true);
    setRewardFlights(
      flightSources.map((item) => ({
        id: item.event.id,
        src: item.accessory.src,
        startX: item.rect!.left + item.rect!.width / 2,
        startY: item.rect!.top + item.rect!.height / 2,
        endX,
        endY,
        delayMs: isBatchUnlock ? Math.min(item.index * 90, 450) : 0,
      })),
    );

    window.setTimeout(() => {
      targetButton.classList.add("companion-capsule-entry--reward-hit");
      window.setTimeout(() => {
        targetButton.classList.remove("companion-capsule-entry--reward-hit");
      }, 520);
    }, REWARD_FLIGHT_HIT_DELAY_MS + lastDelayMs);
    window.setTimeout(completeClaim, REWARD_FLIGHT_COMPLETE_DELAY_MS + lastDelayMs);
  };

  const handleOpenPrompt = () => {
    if (pendingEvents.length >= 2) {
      markSeenBatch(pendingEvents.map((event) => event.id));
      return;
    }
    if (pendingEvent) {
      markSeen(pendingEvent.id);
    }
  };

  if (pendingEvents.length === 0 && seenEvents.length === 0) return null;

  return (
    <>
      {pendingEvent ? (
        <div className="accessory-unlock-prompt-layer" aria-live="polite">
          <button
            type="button"
            className="accessory-unlock-prompt"
            onClick={handleOpenPrompt}
            aria-label={t(
              pendingEvents.length >= 2
                ? "rewards.accessoryUnlock.batchPromptAria"
                : "rewards.accessoryUnlock.promptAria",
              { count: pendingEvents.length },
            )}
          >
            <span className="accessory-unlock-chest" aria-hidden="true">
              <span className="accessory-unlock-chest-lid" />
              <span className="accessory-unlock-chest-body" />
              <span className="accessory-unlock-chest-lock" />
              <span className="accessory-unlock-chest-spark accessory-unlock-chest-spark-one" />
              <span className="accessory-unlock-chest-spark accessory-unlock-chest-spark-two" />
            </span>
            <span className="accessory-unlock-bubble">
              {t(
                pendingEvents.length >= 2
                  ? "rewards.accessoryUnlock.batchPrompt"
                  : "rewards.accessoryUnlock.prompt",
                { count: pendingEvents.length },
              )}
            </span>
          </button>
        </div>
      ) : null}
      {seenEvents.length > 0 ? (
        <div
          className={[
            "accessory-unlock-dialog-layer",
            isClaiming ? "accessory-unlock-dialog-layer--claiming" : "",
          ].filter(Boolean).join(" ")}
          role="dialog"
          aria-modal="true"
        >
          {rewardFlights.map((rewardFlight) => (
            <span
              key={rewardFlight.id}
              aria-hidden="true"
              className="accessory-unlock-flying-item-shell"
              style={
                {
                  "--reward-fly-start-x": `${rewardFlight.startX}px`,
                  "--reward-fly-start-y": `${rewardFlight.startY}px`,
                  "--reward-fly-end-x": `${rewardFlight.endX}px`,
                  "--reward-fly-end-y": `${rewardFlight.endY}px`,
                  "--reward-fly-delay": `${rewardFlight.delayMs}ms`,
                } as CSSProperties
              }
            >
              <img
                src={rewardFlight.src}
                alt=""
                className="accessory-unlock-flying-item"
                draggable={false}
              />
            </span>
          ))}
          <div
            className={[
              "accessory-unlock-dialog",
              isBatchUnlock ? "accessory-unlock-dialog--batch" : "",
              isClaiming ? "accessory-unlock-dialog--claiming" : "",
            ].filter(Boolean).join(" ")}
          >
            <div className="accessory-unlock-dialog-sparks" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className="accessory-unlock-dialog-eyebrow">
              {t(
                isBatchUnlock
                  ? "rewards.accessoryUnlock.batchDialogEyebrow"
                  : "rewards.accessoryUnlock.dialogEyebrow",
                { count: seenEvents.length },
              )}
            </div>
            <h2 className="accessory-unlock-dialog-title">
              {t(
                isBatchUnlock
                  ? "rewards.accessoryUnlock.batchDialogTitle"
                  : "rewards.accessoryUnlock.dialogTitle",
                { count: seenEvents.length },
              )}
            </h2>
            {isBatchUnlock ? (
              <div className="accessory-unlock-dialog-items" aria-hidden="true">
                {seenRewardItems.map((item, index) => (
                  <img
                    key={item.event.id}
                    ref={(node) => {
                      if (node) {
                        batchAccessoryRefs.current.set(item.event.id, node);
                      } else {
                        batchAccessoryRefs.current.delete(item.event.id);
                      }
                    }}
                    src={item.accessory.src}
                    alt=""
                    className="accessory-unlock-dialog-item"
                    style={{ "--reward-item-index": index } as CSSProperties}
                    draggable={false}
                  />
                ))}
              </div>
            ) : (
              <>
                <div className="accessory-unlock-dialog-stage">
                  <span className="accessory-unlock-dialog-burst" aria-hidden="true" />
                  {seenAccessory ? (
                    <img
                      ref={accessoryRef}
                      src={seenAccessory.src}
                      alt=""
                      className="accessory-unlock-dialog-accessory"
                      draggable={false}
                    />
                  ) : (
                    <span className="accessory-unlock-dialog-placeholder" aria-hidden="true" />
                  )}
                </div>
                <div className="accessory-unlock-dialog-name">
                  {t(seenAccessoryLabelKey)}
                </div>
              </>
            )}
            <p className="accessory-unlock-dialog-desc">
              {t(
                isBatchUnlock
                  ? "rewards.accessoryUnlock.batchDialogDesc"
                  : "rewards.accessoryUnlock.dialogDesc",
                { count: seenEvents.length },
              )}
            </p>
            <button
              type="button"
              className="accessory-unlock-dialog-claim"
              onClick={handleClaim}
              disabled={isClaiming}
            >
              {t(
                isBatchUnlock
                  ? "rewards.accessoryUnlock.claimAll"
                  : "rewards.accessoryUnlock.claim",
              )}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

type RewardItem = {
  event: AccessoryRewardEvent;
  accessory: (typeof PIKO_ACCESSORIES)[Exclude<AccessoryRewardEvent["rewardId"], "none">];
};

function resolveRewardItem(event: AccessoryRewardEvent): RewardItem | null {
  if (event.rewardId === "none") return null;
  const accessory = PIKO_ACCESSORIES[event.rewardId];
  return accessory ? { event, accessory } : null;
}
