// SPDX-License-Identifier: Elastic-2.0
import { PIKO_MAP_TRANSITIONS } from "./piko-map-transitions";
import type { PikoExitMarkerDefinition } from "./piko-map-connections";
import type { PikoPoint } from "./runtime/navigation-geometry";
import type { PikoViewportFit } from "./runtime/viewport-fit";
import styles from "./piko-map-exit-marker.module.css";
import { useTranslation } from "react-i18next";
import { canActivateTransport } from "./runtime/map-travel";

/** Destination label; the animated ground marker is rendered inside Pixi. */
export function PikoMapExitMarker({ definition, fit, player, onActivate }: {
  definition: PikoExitMarkerDefinition;
  fit: PikoViewportFit;
  player: PikoPoint;
  onActivate?: () => void;
}) {
  const { t } = useTranslation();
  if (fit.scale <= 0) return null;
  const title = PIKO_MAP_TRANSITIONS[definition.targetMapId].title;
  const near = Math.hypot(player.x - definition.position.x, player.y - definition.position.y) <= (definition.labelDistance ?? 220);

  return (
    <div className={styles.anchor} data-exit-id={definition.exitId} data-near={near}
      style={{ left: fit.x + definition.position.x * fit.scale,
        top: fit.y + definition.position.y * fit.scale,
        transform: `translate(-50%, -50%) scale(${fit.scale})` }}
      role={definition.action ? undefined : "img"} aria-label={definition.action ? undefined : title}>
      {definition.action && canActivateTransport(definition, player, Boolean(onActivate)) ? (
        <button type="button" className={`${styles.name} ${styles.action}`}
          style={definition.labelOffsetY ? { marginTop: definition.labelOffsetY } : undefined}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); onActivate?.(); }}>
          {t(`pikoWorld.transport.${definition.action}`)}
        </button>
      ) : <span className={styles.name} style={definition.labelOffsetY ? { marginTop: definition.labelOffsetY } : undefined}
        aria-hidden="true">{title}</span>}
    </div>
  );
}
