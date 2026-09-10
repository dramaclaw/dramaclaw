// SPDX-License-Identifier: Elastic-2.0
import { useLayoutEffect } from "react";
import { PIKO_CHARACTER_CURSOR, PIKO_DEFAULT_CURSOR } from "./piko-cursors";
import "./piko-cursors.css";

/** Body scope includes portalled menus and dialogs, and is removed on route exit. */
export function usePikoCursors() {
  useLayoutEffect(() => {
    const body = document.body;
    const previous = body.getAttribute("data-piko-cursors");
    const properties = ["--piko-default-cursor", "--piko-action-cursor"] as const;
    const saved = properties.map(key => [body.style.getPropertyValue(key), body.style.getPropertyPriority(key)]);
    body.style.setProperty(properties[0], PIKO_DEFAULT_CURSOR);
    body.style.setProperty(properties[1], PIKO_CHARACTER_CURSOR);
    body.setAttribute("data-piko-cursors", "true");
    return () => {
      if (previous === null) body.removeAttribute("data-piko-cursors");
      else body.setAttribute("data-piko-cursors", previous);
      properties.forEach((key, index) => {
        const [value, priority] = saved[index];
        if (value) body.style.setProperty(key, value, priority);
        else body.style.removeProperty(key);
      });
    };
  }, []);
}
