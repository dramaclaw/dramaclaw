// SPDX-License-Identifier: Elastic-2.0
import { api } from "@/lib/api";
import type { Supported } from "@/i18n/languages";

export type TranslationLanguage = Supported;
export type ChatTranslation = { translated_text: string; source_language: string; target_language: TranslationLanguage };
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
