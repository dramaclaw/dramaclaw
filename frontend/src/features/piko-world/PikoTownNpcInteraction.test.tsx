// SPDX-License-Identifier: Elastic-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PikoTownNpcInteraction } from "./PikoTownNpcInteraction";
import { PIKO_TOWN_NPCS } from "./piko-town-npcs";
import { playNpcGreeting } from "./piko-npc-voice";

vi.mock("./piko-npc-voice", () => ({ playNpcGreeting: vi.fn(() => vi.fn()) }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(PIKO_TOWN_NPCS)("shows $nickname's greeting without opening a menu, and renews its timer", npc => {
  const onInteract = vi.fn(), onHover = vi.fn();
  const { unmount } = render(<PikoTownNpcInteraction npc={npc} fit={{ x: 0, y: 0, scale: 1 }}
    onInteract={onInteract} onHover={onHover} />);
  const trigger = screen.getByRole("button", { name: `与${npc.nickname}互动` });
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  fireEvent.click(trigger);
  expect(screen.getByRole("status")).toHaveTextContent(npc.greeting);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onInteract).toHaveBeenCalledTimes(1);
  expect(playNpcGreeting).toHaveBeenLastCalledWith(npc.residentId);
  act(() => vi.advanceTimersByTime(2000));
  fireEvent.click(trigger);
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByRole("status")).toHaveTextContent(npc.greeting);
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  fireEvent.click(trigger);
  const stopVoice = vi.mocked(playNpcGreeting).mock.results.slice(-1)[0].value;
  unmount();
  expect(stopVoice).toHaveBeenCalledTimes(1);
  expect(onHover).toHaveBeenLastCalledWith(npc.id, false);
  expect(vi.getTimerCount()).toBe(0);
});
