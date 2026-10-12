// SPDX-License-Identifier: Elastic-2.0
import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";

export type TranslationLanguage = "zh" | "en";
export type ChatTranslation = { translated_text: string; source_language: string; target_language: TranslationLanguage };
const changed = "piko-translation-language";
const cached = new Map<string, { expires: number; request: Promise<ChatTranslation> }>();
let cacheOwner: string | null = null;

export function translateChat(owner: string, conversation: string, text: string, target: TranslationLanguage) {
  if (cacheOwner !== owner) { cached.clear(); cacheOwner = owner; }
  const key = JSON.stringify([owner, conversation, text, target]);
  const hit = cached.get(key);
  if (hit && hit.expires > Date.now()) return hit.request;
  const request = api.post("api/v1/piko/chat/translate", {
    json: { conversation, text, target_language: target }, retry: 0, timeout: 20_000,
  }).json<ChatTranslation>();
  const entry = { expires: Date.now() + 300_000, request };
  cached.set(key, entry);
  while (cached.size > 128) cached.delete(cached.keys().next().value!);
  void request.catch(() => { if (cached.get(key) === entry) cached.delete(key); });
  return request;
}

const subscribe = (listener: () => void) => {
  window.addEventListener(changed, listener);
  window.addEventListener("storage", listener);
  return () => { window.removeEventListener(changed, listener); window.removeEventListener("storage", listener); };
};
export function useTranslationLanguage(owner: string, interfaceLanguage: string) {
  const key = `piko:translation-language:${owner}`;
  const fallback: TranslationLanguage = interfaceLanguage.startsWith("zh") ? "zh" : "en";
  const language = useSyncExternalStore(subscribe, () => {
    try { const saved = localStorage.getItem(key); return saved === "zh" || saved === "en" ? saved : fallback; }
    catch { return fallback; }
  }, () => fallback);
  const setLanguage = (value: TranslationLanguage) => {
    try { localStorage.setItem(key, value); } catch { /* Preference storage may be unavailable. */ }
    window.dispatchEvent(new Event(changed));
  };
  return [language, setLanguage] as const;
}
