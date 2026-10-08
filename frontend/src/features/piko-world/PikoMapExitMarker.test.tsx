// SPDX-License-Identifier: Elastic-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PikoMapExitMarker } from "./PikoMapExitMarker";
import { MAP_EXIT_MARKERS } from "./piko-map-connections";

it("shows a transport button only nearby and activates it deliberately", () => {
  const definition = MAP_EXIT_MARKERS["startrace-coast"].find(marker => marker.action)!;
  const activate = vi.fn();
  const props = { definition, fit: { x: 0, y: 0, scale: 1 }, onActivate: activate };
  const { rerender } = render(<PikoMapExitMarker {...props} player={{ x: 500, y: 500 }} />);
  expect(screen.queryByRole("button")).toBeNull();
  rerender(<PikoMapExitMarker {...props} player={definition.position} />);
  expect(activate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button"));
  expect(activate).toHaveBeenCalledTimes(1);
  rerender(<PikoMapExitMarker {...props} player={definition.position} onActivate={undefined} />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("keeps walking destination labels passive", () => {
  const definition = MAP_EXIT_MARKERS["welcome-courtyard"][0];
  render(<PikoMapExitMarker definition={definition} fit={{ x: 0, y: 0, scale: 1 }} player={definition.position} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByRole("img", { name: "匠作市集" })).toBeInTheDocument();
});

it("reveals the hall label near the door and enables entry only within its smaller reach", () => {
  const definition = MAP_EXIT_MARKERS["welcome-courtyard"].find(marker => marker.action === "enterHall")!;
  const activate = vi.fn();
  const props = { definition, fit: { x: 0, y: 0, scale: 1 }, onActivate: activate };
  const { container, rerender } = render(<PikoMapExitMarker {...props} player={{ x: 1054, y: 530 }} />);
  expect(container.firstChild).toHaveAttribute("data-near", "false");
  expect(screen.queryByRole("button")).toBeNull();
  rerender(<PikoMapExitMarker {...props} player={{ x: 1054, y: 510 }} />);
  expect(container.firstChild).toHaveAttribute("data-near", "true");
  expect(screen.queryByRole("button")).toBeNull();
  rerender(<PikoMapExitMarker {...props} player={definition.groundPosition!} />);
  fireEvent.click(screen.getByRole("button"));
  expect(activate).toHaveBeenCalledOnce();
});
