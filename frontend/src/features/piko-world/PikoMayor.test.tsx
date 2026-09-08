// SPDX-License-Identifier: Elastic-2.0
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PikoMayor } from "./PikoMayor";

it("anchors the mayor to map coordinates and only shows the hint when enabled", () => {
  const { rerender } = render(<PikoMayor fit={{ x: 10, y: 20, scale: 0.5 }} showHint={false} />);
  expect(screen.getByTestId("piko-mayor")).toHaveStyle({ transform: "translate(540px, 245px) scale(0.5)" });
  expect(screen.queryByTestId("piko-mayor-hint")).toBeNull();
  // Body and contact shadow now live in the Pixi world, not a second DOM sprite.
  expect(screen.queryByRole("img")).toBeNull();
  rerender(<PikoMayor fit={{ x: 0, y: 0, scale: 1 }} showHint />);
  expect(screen.getByTestId("piko-mayor")).toHaveStyle({ transform: "translate(1060px, 450px) scale(1)" });
  const hint = screen.getByTestId("piko-mayor-hint");
  expect(hint).toHaveAttribute("aria-hidden", "true");
  expect(hint.querySelector("svg")).toHaveAttribute("viewBox", "0 0 28 32");
  expect(hint.querySelector("text")).toBeNull();
  const paths = hint.querySelectorAll("path");
  expect(paths).toHaveLength(2);
  expect(paths[0].getAttribute("d")).toBe(paths[1].getAttribute("d"));
  expect(paths[1]).toHaveAttribute("stroke-width", "1.3");
  expect(screen.queryByRole("button")).toBeNull();
});
