// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";

export function useTransientConfirmation(duration = 1400) {
  const [confirmed, setConfirmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearConfirmation = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setConfirmed(false);
  }, []);

  const showConfirmation = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setConfirmed(true);
    timerRef.current = window.setTimeout(() => {
      setConfirmed(false);
      timerRef.current = null;
    }, duration);
  }, [duration]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return { clearConfirmation, confirmed, showConfirmation };
}
