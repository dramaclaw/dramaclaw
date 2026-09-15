// SPDX-License-Identifier: Elastic-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PikoWardrobeDialog } from "./PikoWardrobeDialog";
it("shows the actual player and empty inventory, confirmation only closes", () => {
  const close = vi.fn(); render(<PikoWardrobeDialog open gender="female" nickname="小花" onOpenChange={close} />);
  expect(screen.getByRole("img", { name: "女生" })).toHaveAttribute("src", "/piko/world/onboarding/player-female-v2.png");
  expect(screen.queryByText("还没有其他服装")).toBeNull();
  expect(screen.queryByText("还没有可替换的配饰")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "确认" })); expect(close).toHaveBeenCalledWith(false);
});
