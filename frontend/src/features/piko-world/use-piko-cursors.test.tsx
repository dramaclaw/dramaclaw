// SPDX-License-Identifier: Elastic-2.0
import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it } from "vitest";
import { usePikoCursors } from "./use-piko-cursors";
import { PIKO_CHARACTER_CURSOR, PIKO_DEFAULT_CURSOR } from "./piko-cursors";
function Scope() { usePikoCursors(); return null; }
it("covers body portals while mounted and restores the previous page on exit", () => {
  const { unmount } = render(<StrictMode><Scope /></StrictMode>);
  expect(document.body.dataset.pikoCursors).toBe("true");
  expect(document.body.style.getPropertyValue("--piko-default-cursor")).toBe(PIKO_DEFAULT_CURSOR);
  expect(document.body.style.getPropertyValue("--piko-action-cursor")).toBe(PIKO_CHARACTER_CURSOR);
  unmount();
  expect(document.body.hasAttribute("data-piko-cursors")).toBe(false);
  expect(document.body.style.getPropertyValue("--piko-default-cursor")).toBe("");
  expect(document.body.style.getPropertyValue("--piko-action-cursor")).toBe("");
});

it("restores preexisting scope values and CSS priorities", () => {
  document.body.setAttribute("data-piko-cursors", "previous");
  document.body.style.setProperty("--piko-default-cursor", "crosshair", "important");
  document.body.style.setProperty("--piko-action-cursor", "help");
  try {
    const { unmount } = render(<StrictMode><Scope /></StrictMode>);
    unmount();
    expect(document.body.dataset.pikoCursors).toBe("previous");
    expect(document.body.style.getPropertyValue("--piko-default-cursor")).toBe("crosshair");
    expect(document.body.style.getPropertyPriority("--piko-default-cursor")).toBe("important");
    expect(document.body.style.getPropertyValue("--piko-action-cursor")).toBe("help");
  } finally {
    document.body.removeAttribute("data-piko-cursors");
    document.body.style.removeProperty("--piko-default-cursor");
    document.body.style.removeProperty("--piko-action-cursor");
  }
});
