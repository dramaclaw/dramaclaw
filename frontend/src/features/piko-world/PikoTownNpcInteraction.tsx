// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PikoSpeechBubble } from "./PikoSpeechBubble";
import { playNpcGreeting } from "./piko-npc-voice";
import { RESIDENT_WORLD_SCALE } from "./runtime/resident-actor";
import { mapPerspectiveScale } from "./runtime/map-perspective";
import type { PikoTownNpc } from "./piko-town-npcs";
import type { PikoViewportFit } from "./runtime/viewport-fit";

export function PikoTownNpcInteraction({ npc, fit, onInteract, onHover }: {
  npc: PikoTownNpc; fit: PikoViewportFit;
  onInteract: () => void;
  onHover: (id: string, hovered: boolean) => void;
}) {
  const { t } = useTranslation();
  const [utterance, setUtterance] = useState(0);
  const stopVoice = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopVoice.current?.(), []);
  useEffect(() => {
    if (!utterance) return;
    const timer = window.setTimeout(() => setUtterance(0), 3000);
    return () => window.clearTimeout(timer);
  }, [utterance]);
  useEffect(() => () => onHover(npc.id, false), [npc.id, onHover]);
  const characterScale = (npc.scale ?? 1) * mapPerspectiveScale(npc.mapId, npc.position.y);
  const scale = fit.scale * RESIDENT_WORLD_SCALE * characterScale;
  return <>
    <button type="button" id={`piko-resident-${npc.id}`}
      aria-label={t("pikoWorld.residentActions", { nickname: npc.nickname })}
      onPointerEnter={() => onHover(npc.id, true)} onPointerLeave={() => onHover(npc.id, false)}
      onClick={() => { onInteract(); stopVoice.current = playNpcGreeting(npc.residentId); setUtterance(value => value + 1); }}
      className="absolute cursor-pointer bg-transparent focus-visible:outline-2 focus-visible:outline-ring"
      style={{ left: fit.x + npc.position.x * fit.scale - 16 * scale,
        top: fit.y + npc.position.y * fit.scale - 56 * scale, width: 32 * scale, height: 56 * scale }} />
    {utterance > 0 && <PikoSpeechBubble body={npc.greeting} position={npc.position} fit={fit} headOffset={132 * characterScale} />}
    <span role="status" aria-live="polite" className="sr-only">{utterance > 0 ? npc.greeting : ""}</span>
  </>;
}
