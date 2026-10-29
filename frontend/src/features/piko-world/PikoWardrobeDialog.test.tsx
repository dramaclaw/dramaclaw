// SPDX-License-Identifier: Elastic-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PikoWardrobeDialog } from "./PikoWardrobeDialog";
it("matches the base outfit to gender, disables unavailable clothes and confirms by closing", () => {
  const close = vi.fn(); const { rerender } = render(<PikoWardrobeDialog open gender="female" nickname="小花" onOpenChange={close} />);
  expect(screen.getByRole("img", { name: "女生" })).toHaveAttribute("src", "/piko/world/onboarding/player-female-v2.png");
  expect(screen.queryByText("还没有其他服装")).toBeNull();
  expect(screen.queryByText("还没有可替换的配饰")).toBeNull();
  expect(screen.getByRole("img", { name: "当前基础服饰" })).toHaveAttribute("src", "/piko/world/ui/wardrobe/base-outfit-female-v2.png");
  const unavailable = screen.getAllByRole("button", { name: "服饰暂未开放" });
  expect(unavailable).toHaveLength(5);
  unavailable.forEach(slot => expect(slot).toBeDisabled());
  fireEvent.click(unavailable[0]);
  expect(close).not.toHaveBeenCalled();
  rerender(<PikoWardrobeDialog open gender="male" nickname="小花" onOpenChange={close} />);
  expect(screen.getByRole("img", { name: "当前基础服饰" })).toHaveAttribute("src", "/piko/world/ui/wardrobe/base-outfit-male-v2.png");
  fireEvent.click(screen.getByRole("button", { name: "确认" })); expect(close).toHaveBeenCalledWith(false);
});

it("previews one accessory, toggles it off, discards drafts and reports save failure", () => {
  const close = vi.fn(); const save = vi.fn(() => true);
  const props = { gender: "female" as const, nickname: "小花", accessory: null, onOpenChange: close, onSave: save };
  const { rerender } = render(<PikoWardrobeDialog {...props} open />);
  fireEvent.click(screen.getByRole("button", { name: "魔法帽" }));
  expect(screen.getByRole("button", { name: "魔法帽" })).toHaveAttribute("aria-pressed", "true");
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "薄暮" }));
  expect(screen.getByRole("button", { name: "魔法帽" })).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  expect(save).toHaveBeenLastCalledWith("dark-knight-mask");
  rerender(<PikoWardrobeDialog {...props} open={false} />);
  rerender(<PikoWardrobeDialog {...props} open />);
  expect(screen.getByRole("button", { name: "薄暮" })).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(screen.getByRole("button", { name: "小蜗牛" }));
  fireEvent.click(screen.getByRole("button", { name: "小蜗牛" }));
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  expect(save).toHaveBeenLastCalledWith(null);
  close.mockClear(); save.mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  expect(screen.getByRole("alert")).toHaveTextContent("保存失败");
  expect(close).not.toHaveBeenCalled();
});
