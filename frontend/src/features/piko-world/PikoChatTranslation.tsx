// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { normalize } from "@/i18n/languages";
import { translateChat, type TranslationLanguage } from "./piko-chat-translation";
import styles from "./piko-chat-translation.module.css";

export function PikoChatTranslation({ text, conversation, children }: { text: string; conversation: string; children: ReactNode }) {
  const { i18n } = useTranslation();
  const owner = useAuthStore(state => state.username) ?? "";
  const language = normalize(i18n.resolvedLanguage ?? i18n.language);
  return <MessageTranslation key={JSON.stringify([owner, conversation, text, language])}
    owner={owner} conversation={conversation} text={text} language={language}>{children}</MessageTranslation>;
}

function MessageTranslation({ owner, conversation, text, language, children }: {
  owner: string; conversation: string; text: string; language: TranslationLanguage;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState("");
  const [targetLanguage, setTargetLanguage] = useState<TranslationLanguage>(language);
  const [expanded, setExpanded] = useState(false);
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const translate = async () => {
    if (busy.current) return;
    if (status === "done") { setExpanded(value => !value); return; }
    busy.current = true; setStatus("loading"); setExpanded(true);
    try {
      const response = await translateChat(owner, conversation, text, language);
      if (alive.current) { setResult(response.translated_text); setTargetLanguage(response.target_language); setStatus("done"); }
    } catch { if (alive.current) setStatus("error"); }
    finally { busy.current = false; }
  };
  return <div className={styles.message}>
    {children}
    <div className={styles.actions}>
      <button type="button" disabled={status === "loading"} onClick={translate}>
        <Languages size={12} aria-hidden="true" />
        {t(status === "loading" ? "pikoWorld.translationLoading" : status === "done" && expanded ? "pikoWorld.translationHide" : status === "error" ? "pikoWorld.translationRetry" : "pikoWorld.translationAction")}
      </button>
    </div>
    {expanded && <div className={styles.result} role="status" aria-live="polite" lang={status === "done" ? targetLanguage : undefined}>
      {status === "loading" ? t("pikoWorld.translationLoading") : status === "error" ? t("pikoWorld.translationError") : <><span className={styles.label}>{t("pikoWorld.translationLabel")}</span><p>{result}</p></>}
    </div>}
  </div>;
}
