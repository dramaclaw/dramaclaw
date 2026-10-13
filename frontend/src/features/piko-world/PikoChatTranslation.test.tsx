// SPDX-License-Identifier: Elastic-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import enTranslation from "../../../public/locales/en/translation.json";
import viTranslation from "../../../public/locales/vi/translation.json";
import { beforeEach, expect, it, vi } from "vitest";
import { PikoChatTranslation } from "./PikoChatTranslation";
const mocks = vi.hoisted(() => ({ post: vi.fn(), username: "alice" }));
vi.mock("@/lib/api", () => ({ api: { post: mocks.post } }));
vi.mock("@/stores/auth-store", () => ({ useAuthStore: (select: (s: {username: string}) => unknown) => select(mocks) }));
beforeEach(() => { localStorage.clear(); mocks.post.mockReset(); mocks.username = "alice"; });

it("translates only on click, preserves the original, collapses and reuses the result", async () => {
  mocks.post.mockReturnValue({ json: async () => ({ translated_text: "一起去喷泉吧", source_language: "en", target_language: "zh" }) });
  render(<PikoChatTranslation text="Let's go to the fountain" conversation="test-public"><p>Let's go to the fountain</p></PikoChatTranslation>);
  expect(mocks.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "翻译" }));
  expect(await screen.findByText("一起去喷泉吧")).toBeTruthy();
  expect(screen.getByText("Let's go to the fountain")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "收起译文" }));
  expect(screen.queryByText("一起去喷泉吧")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "翻译" }));
  expect(screen.getByText("一起去喷泉吧")).toBeTruthy();
  expect(mocks.post).toHaveBeenCalledTimes(1);
});

it("retries failures and uses the detected target language for a non-English message", async () => {
  mocks.post.mockReturnValueOnce({ json: async () => { throw Error("offline"); } })
    .mockReturnValue({ json: async () => ({ translated_text: "Hello", source_language: "zh", target_language: "en" }) });
  render(<PikoChatTranslation text="你好" conversation="test-private"><p>你好</p></PikoChatTranslation>);
  fireEvent.click(screen.getByRole("button", { name: "翻译" }));
  await screen.findByText("暂时无法翻译，请稍后重试。");
  fireEvent.click(screen.getByRole("button", { name: "重试翻译" }));
  await screen.findByText("Hello");
  expect(mocks.post).toHaveBeenCalledTimes(2);
  expect(mocks.post.mock.calls[1][1].json.target_language).toBe("zh");
  expect(screen.getByRole("status")).toHaveAttribute("lang", "en");
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("coalesces requests and does not reuse another user's private translation", async () => {
  let finish: (value: unknown) => void = () => {};
  mocks.post.mockReturnValue({ json: () => new Promise(resolve => { finish = resolve; }) });
  const { translateChat } = await import("./piko-chat-translation");
  const first = translateChat("bob", "private:a", "unique", "zh");
  const second = translateChat("bob", "private:a", "unique", "zh");
  expect(first).toBe(second);
  finish({ translated_text: "独特", source_language: "en", target_language: "zh" });
  await first;
  mocks.post.mockReturnValue({ json: async () => ({translated_text: "独特"}) });
  await translateChat("carol", "private:a", "unique", "zh");
  expect(mocks.post).toHaveBeenCalledTimes(2);
});

it.each(["public:town", "private:leaf"])("follows the current system language in %s and ignores the old manual preference", async conversation => {
  localStorage.setItem("piko:translation-language:alice", "en");
  mocks.post.mockReturnValue({ json: async () => ({ translated_text: "问候", source_language: "en", target_language: "zh" }) });
  render(<PikoChatTranslation text="greetings" conversation={conversation}><p>greetings</p></PikoChatTranslation>);
  fireEvent.click(screen.getByRole("button", { name: "翻译" }));
  await screen.findByText("问候");
  expect(mocks.post.mock.calls[0][1].json.target_language).toBe("zh");
  try {
    i18next.addResourceBundle("en", "translation", enTranslation);
    mocks.post.mockReturnValue({ json: async () => ({ translated_text: "greetings", source_language: "en", target_language: "en" }) });
    await act(async () => { await i18next.changeLanguage("en"); });
    expect(screen.queryByText("问候")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    await screen.findByRole("button", { name: "Hide translation" });
    expect(mocks.post.mock.calls[1][1].json.target_language).toBe("en");
  } finally {
    await act(async () => { await i18next.changeLanguage("zh"); });
  }
});

it("uses Vietnamese when it is the selected interface language", async () => {
  try {
    i18next.addResourceBundle("vi", "translation", viTranslation);
    await act(async () => { await i18next.changeLanguage("vi"); });
    mocks.post.mockReturnValue({ json: async () => ({ translated_text: "Xin chào", source_language: "en", target_language: "vi" }) });
    render(<PikoChatTranslation text="Hello there" conversation="test-vi"><p>Hello there</p></PikoChatTranslation>);
    fireEvent.click(screen.getByRole("button", { name: "Dịch" }));
    await screen.findByText("Xin chào");
    expect(mocks.post.mock.calls[0][1].json.target_language).toBe("vi");
    expect(screen.getByRole("status")).toHaveAttribute("lang", "vi");
  } finally {
    await act(async () => { await i18next.changeLanguage("zh"); });
  }
});
