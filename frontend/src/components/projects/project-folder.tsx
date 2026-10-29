// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import styles from "./project-folder.module.css";

export function ProjectFolder({
  color,
  initial,
  width = 100,
  size = 1,
  badges,
  className,
}: {
  color: string;
  initial: string;
  width?: number | string;
  size?: number;
  badges?: React.ReactNode;
  className?: string;
}) {
  const style = {
    "--folder-color": color,
    "--paper-1": "rgba(255, 255, 255, 0.44)",
    "--paper-2": "rgba(255, 255, 255, 0.70)",
    "--paper-3": "rgba(255, 255, 255, 0.96)",
    "--folder-width": typeof width === "number" ? `${width}px` : width,
    "--folder-size": size,
  } as React.CSSProperties;

  return (
    <div className={className ? `${styles.folder} ${className}` : styles.folder} style={style}>
      <div className={styles.back} aria-hidden="true">
        <div className={`${styles.paper} ${styles.paper1}`} />
        <div className={`${styles.paper} ${styles.paper2}`} />
        <div className={`${styles.paper} ${styles.paper3}`} />
        <div className={styles.front}>
          {badges ? <div className={styles.badges}>{badges}</div> : null}
          <span className={styles.initial}>{initial}</span>
        </div>
      </div>
    </div>
  );
}
