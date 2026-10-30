// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import styles from "./notification-dot.module.css";

/** Shared visual for unread information and undiscovered entries. */
export function NotificationDot({ className }: { className?: string }) {
  return (
    <span
      data-slot="notification-dot"
      aria-hidden="true"
      className={[styles.dot, className].filter(Boolean).join(" ")}
    />
  );
}
