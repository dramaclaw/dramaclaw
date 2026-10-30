// SPDX-License-Identifier: Elastic-2.0
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PikoMayor } from "./PikoMayor";

it("anchors the mayor to map coordinates and only shows the name when enabled", () => {
  const { rerender } = render(<PikoMayor fit={{ x: 10, y: 20, scale: 0.5 }} showName={false} />);
  expect(screen.getByTestId("piko-mayor")).toHaveStyle({ transform: "translate(540px, 245px) scale(0.5)" });
  expect(screen.queryByTestId("piko-mayor-name")).toBeNull();
  // Body and contact shadow now live in the Pixi world, not a second DOM sprite.
  expect(screen.queryByRole("img")).toBeNull();
  rerender(<PikoMayor fit={{ x: 0, y: 0, scale: 1 }} showName />);
  expect(screen.getByTestId("piko-mayor")).toHaveStyle({ transform: "translate(1060px, 450px) scale(1)" });
  expect(screen.getByTestId("piko-mayor-name")).not.toBeEmptyDOMElement();
  expect(screen.queryByTestId("piko-mayor-hint")).toBeNull();
  expect(screen.getByTestId("piko-mayor").querySelector("svg")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});
