// SPDX-License-Identifier: Elastic-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PikoResidentSelectorDialog } from "./PikoResidentSelectorDialog";

it("selects the playable woman and skips unanimated residents with the keyboard", () => {
  const onConfirm = vi.fn(), onOpenChange = vi.fn();
  render(<PikoResidentSelectorDialog open selectedResidentId="m01" onConfirm={onConfirm} onOpenChange={onOpenChange} />);
  const radios = screen.getAllByRole("radio");
  expect(radios.filter(radio => !(radio as HTMLButtonElement).disabled)).toHaveLength(2);
  expect(screen.getByRole("radio", { name: "男生 · M01" })).toBeChecked();
  fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });
  expect(screen.getByRole("radio", { name: "女生 · F01" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "选好了" }));
  expect(onConfirm).toHaveBeenCalledWith("f01");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
