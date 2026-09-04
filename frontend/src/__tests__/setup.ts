// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import "@testing-library/jest-dom/vitest";

// jsdom v29 + Node.js >=22 exposes a broken localStorage (plain object without
// Storage methods) when --localstorage-file is not set. Provide a spec-compliant
// in-memory replacement so zustand/persist and other code that relies on
// localStorage.setItem / getItem / removeItem works correctly in tests.
if (typeof globalThis.localStorage === "undefined" || typeof globalThis.localStorage.setItem !== "function") {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };

  Object.defineProperty(globalThis, "localStorage", { value: storage, writable: true, configurable: true });
  Object.defineProperty(window, "localStorage", { value: storage, writable: true, configurable: true });
}

import { server } from "@/__mocks__/msw/server";
import { beforeAll, afterAll, afterEach } from "vitest";

// `bypass` (not `error`): the repo has test files that own their own `setupServer`
// instance (e.g. render-plan.test.tsx). With two MSW instances listening, `error`
// from the global server would reject requests the test-local server would handle.
// `bypass` lets non-matching requests pass through to other interceptors or fail
// naturally, without MSW crying foul.
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { zhTranslation } from "./helpers/i18n-fixtures";

// 组件单测断言的是用户看见的中文。默认 i18next 实例不初始化的话 t() 只回显 key，
// 凡是搬进 i18n 的文案在测试里都会变成 "node.audioNode.empty" 这种，断言全挂。
// 这里直接拿线上那份 zh/translation.json 初始化：断言照旧写中文，key 打错了也会
// 当场露馅（渲染出 key 而不是文案）。自带 I18nextProvider 的测试用的是各自的
// createInstance()，不受这里影响。
void i18next.use(initReactI18next).init({
  lng: "zh",
  fallbackLng: "zh",
  resources: { zh: { translation: zhTranslation } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});
