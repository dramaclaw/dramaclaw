// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatIngestElapsedTime,
  IngestElapsedTime,
} from "@/components/ingest/IngestElapsedTime";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, values: { time: string }) => `Elapsed ${values.time}`,
  }),
}));

describe("IngestElapsedTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats minute and hour durations", () => {
    expect(formatIngestElapsedTime(0)).toBe("00:00");
    expect(formatIngestElapsedTime(65)).toBe("01:05");
    expect(formatIngestElapsedTime(3661)).toBe("01:01:01");
  });

  it("keeps advancing while the ingest indicator is mounted", () => {
    render(<IngestElapsedTime startedAtMs={Date.now()} />);
    expect(screen.getByText("Elapsed 00:00")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(65_000);
    });

    expect(screen.getByText("Elapsed 01:05")).toBeInTheDocument();
  });

  it("continues from the persisted task start after remount", () => {
    const startedAtMs = Date.parse("2026-07-31T23:55:00Z");
    const first = render(<IngestElapsedTime startedAtMs={startedAtMs} />);
    expect(screen.getByText("Elapsed 05:00")).toBeInTheDocument();

    first.unmount();
    vi.setSystemTime(new Date("2026-08-01T00:02:00Z"));
    render(<IngestElapsedTime startedAtMs={startedAtMs} />);

    expect(screen.getByText("Elapsed 07:00")).toBeInTheDocument();
  });
});
