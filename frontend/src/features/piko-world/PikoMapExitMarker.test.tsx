// SPDX-License-Identifier: Elastic-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PikoMapExitMarker } from "./PikoMapExitMarker";
import { MAP_EXIT_MARKERS } from "./piko-map-connections";

it("shows an open-scene transport button only nearby and activates it deliberately", () => {
  const definition = MAP_EXIT_MARKERS["welcome-courtyard"].find(marker => marker.action)!;
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

it.each(["walking", "transport"])("shows the closed-scene notice near a %s entrance and prevents activation", kind => {
  const definition = kind === "transport"
    ? MAP_EXIT_MARKERS["startrace-coast"].find(marker => marker.action)!
    : MAP_EXIT_MARKERS["artisan-market"].find(marker => marker.targetMapId === "wind-garden-gate")!;
  const activate = vi.fn();
  const props = { definition, fit: { x: 0, y: 0, scale: 1 }, onActivate: activate };
  const { rerender } = render(<PikoMapExitMarker {...props} player={{ x: 10000, y: 10000 }} />);
  expect(screen.queryByRole("status")).toBeNull();
  rerender(<PikoMapExitMarker {...props} player={definition.position} />);
  const notice = kind === "transport" ? "无垠海域暂未开放，敬请期待" : "风庭门暂未开放，敬请期待";
  expect(screen.getByRole("status", { name: notice })).toHaveTextContent(notice);
  expect(screen.queryByRole("button")).toBeNull();
  expect(activate).not.toHaveBeenCalled();
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
  rerender(<PikoMapExitMarker {...props} player={definition.position} />);
  fireEvent.click(screen.getByRole("button"));
  expect(activate).toHaveBeenCalledOnce();
});
