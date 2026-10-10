// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useRef, useState } from "react";
export const PIKO_CHAT_COOLDOWN_MS = 3000;
export const PIKO_CHAT_MAX_LENGTH = 80;
export const PIKO_CHAT_BUBBLE_MS = 10000;
export type PikoSpeech = { id: number; body: string; expiresAt: number; owner: string | null };

/** Browser-session rehearsal only; real multiplayer requires server enforcement. */
export function createPikoChatGate() {
  const deadlines = new Map<string | null, number>();
  return {
    remaining(owner: string | null, now: number) { return Math.max(0, (deadlines.get(owner) ?? 0) - now); },
    send(owner: string | null, input: string, now: number) {
      const body = input.trim();
      if (!body) return { ok: false, reason: "empty" } as const;
      if (Array.from(body).length > PIKO_CHAT_MAX_LENGTH) return { ok: false, reason: "length" } as const;
      if (this.remaining(owner, now)) return { ok: false, reason: "cooldown" } as const;
      deadlines.set(owner, now + PIKO_CHAT_COOLDOWN_MS);
      return { ok: true, body } as const;
    },
  };
}
const gate = createPikoChatGate();
export function usePikoPublicChat(owner: string | null) {
  const [clock, setClock] = useState(Date.now());
  const [speech, setSpeech] = useState<PikoSpeech | null>(null);
  const sequence = useRef(0);
  const remaining = gate.remaining(owner, clock);
  const ticking = remaining > 0 || (speech?.owner === owner && speech.expiresAt > clock);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setClock(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const send = (input: string) => {
    const now = Date.now();
    const result = gate.send(owner, input, now);
    setClock(now);
    if (result.ok) setSpeech({ id: ++sequence.current, owner, body: result.body, expiresAt: now + PIKO_CHAT_BUBBLE_MS });
    return result;
  };
  return { send, remaining: Math.ceil(remaining / 1000), speech: speech?.owner === owner && speech.expiresAt > clock ? speech : null };
}
