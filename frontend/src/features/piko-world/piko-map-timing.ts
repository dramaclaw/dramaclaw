// SPDX-License-Identifier: Elastic-2.0
/** Travel deadlines are independent of presentation timing and reduced motion. */
export const PIKO_MAP_TRAVEL_TIMING = {
  fadeOutMs: 300,
  fadeInMs: 400,
  loadingHintMs: 800,
  prepareTimeoutMs: 15_000,
  renderTimeoutMs: 30_000,
} as const;
