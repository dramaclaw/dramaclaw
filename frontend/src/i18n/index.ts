// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import HttpBackend from "i18next-http-backend";
import LanguageDetector from "i18next-browser-languagedetector";
import { useAppStore } from "@/stores/app-store";
import { APP_VERSION } from "@/lib/app-version";

const SUPPORTED = ["zh", "en"] as const;
type Supported = (typeof SUPPORTED)[number];

export function normalize(lng: string | undefined): Supported {
  const two = (lng ?? "").slice(0, 2).toLowerCase();
  return (SUPPORTED as readonly string[]).includes(two) ? (two as Supported) : "en";
}

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // If detection can't land on a supported language we fall back to English,
    // not Chinese — Chinese is only auto-selected when the browser/OS says so.
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED],
    // `zh-CN` / `en-US` from navigator collapse to `zh` / `en`, so the
    // backend loader only has to serve two translation files.
    load: "languageOnly",
    defaultNS: "translation",
    detection: {
      // Priority: explicit override (?lng=), prior user choice in
      // localStorage, then the browser/OS setting. `htmlTag` is deliberately
      // omitted — we don't want a static markup attribute to dictate locale.
      // Anything not resolving to zh/en drops through to `fallbackLng` ("en").
      order: ["querystring", "localStorage", "navigator"],
      caches: ["localStorage"],
    },
    backend: {
      // 翻译 JSON 是静态文件、会被浏览器/CDN 长期缓存。不带版本号时，发版后新增的
      // key 在老用户那里仍读旧缓存 → 直接显示成原始 key（如 ingest.reuploadConfirm.*）。
      // 按构建版本加 query 破缓存：每次发版 URL 变化拉到新文件，同版本内仍走缓存。
      loadPath: `/locales/{{lng}}/{{ns}}.json?v=${encodeURIComponent(APP_VERSION)}`,
    },
    interpolation: {
      escapeValue: false,
    },
  });

// Keep the app-store's `language` field AND `<html lang>` in lockstep with
// what i18next actually resolved. Without this, the switcher (which reads
// app-store) can show a different pill than the page is rendered in — the
// drift we hit when the persisted app-store default ("zh") disagreed with
// the detector's resolution.
function syncResolvedLanguage() {
  const lng = normalize(i18n.resolvedLanguage ?? i18n.language);
  if (useAppStore.getState().language !== lng) {
    useAppStore.setState({ language: lng });
  }
  if (typeof document !== "undefined" && document.documentElement.lang !== lng) {
    document.documentElement.lang = lng;
  }
}

if (i18n.isInitialized) {
  syncResolvedLanguage();
} else {
  i18n.on("initialized", syncResolvedLanguage);
}
i18n.on("languageChanged", syncResolvedLanguage);

export default i18n;
