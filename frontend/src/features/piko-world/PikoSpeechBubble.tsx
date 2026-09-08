// SPDX-License-Identifier: Elastic-2.0
import { useLayoutEffect, useRef, useState } from "react";
import type { Point } from "./runtime/character-movement";
import type { PikoViewportFit } from "./runtime/viewport-fit";
import popupStyles from "./piko-popup.module.css";

export function PikoSpeechBubble({ body, position, fit }: { body: string; position: Point; fit: PikoViewportFit }) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ left: 0, top: 0, tail: 20 });
  useLayoutEffect(() => {
    const element = ref.current, parent = element?.parentElement;
    if (!element || !parent) return;
    const update = () => {
      const anchorX = fit.x + position.x * fit.scale;
      const anchorY = fit.y + (position.y - 132) * fit.scale;
      const left = Math.max(8, Math.min(anchorX - element.offsetWidth / 2, parent.clientWidth - element.offsetWidth - 8));
      const top = Math.max(8, Math.min(anchorY - element.offsetHeight - 8, parent.clientHeight - element.offsetHeight - 16));
      setPlacement({ left, top, tail: Math.max(12, Math.min(element.offsetWidth - 20, anchorX - left - 4)) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent); observer.observe(element);
    return () => observer.disconnect();
  }, [body, position.x, position.y, fit.x, fit.y, fit.scale]);
  return <div ref={ref} className={`${popupStyles.surface} pointer-events-none absolute z-10 w-max max-w-[min(13rem,calc(100%-1rem))] px-2.5 py-1.5 text-xs leading-4`}
    style={{ left: placement.left, top: placement.top }} aria-hidden="true">
    <span className="break-words [overflow-wrap:anywhere]">{body}</span>
    <span className="absolute -bottom-[5px] size-2 rotate-45 border-b border-r border-[#c5a12d] bg-amber-100" style={{ left: placement.tail }} />
  </div>;
}
