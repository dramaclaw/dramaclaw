// SPDX-License-Identifier: Elastic-2.0
import { fireEvent, render, screen } from "@testing-library/react";
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

it("retries failures and switches target without automatically sending text", async () => {
  mocks.post.mockReturnValueOnce({ json: async () => { throw Error("offline"); } })
    .mockReturnValue({ json: async () => ({ translated_text: "Hello", source_language: "zh", target_language: "en" }) });
  render(<PikoChatTranslation text="你好" conversation="test-private"><p>你好</p></PikoChatTranslation>);
  fireEvent.click(screen.getByRole("button", { name: "翻译" }));
  await screen.findByText("暂时无法翻译，请稍后重试。");
  fireEvent.click(screen.getByRole("button", { name: "重试翻译" }));
  await screen.findByText("Hello");
  fireEvent.click(screen.getByLabelText("翻译为", {selector: "summary"}));
  fireEvent.change(screen.getByRole("combobox"), { target: {value: "en"} });
  expect(mocks.post).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("Hello")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "翻译" }));
  await screen.findByText("Hello");
  expect(mocks.post.mock.calls[2][1].json.target_language).toBe("en");
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
