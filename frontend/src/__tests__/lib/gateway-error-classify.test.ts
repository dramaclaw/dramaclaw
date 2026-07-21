// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  backendErrorToastMessage,
  classifyGatewayError,
  humanizeTaskError,
  providerErrorMessage,
} from "@/lib/api-errors";

// A stub TFunction: return the key, unless a `defaultValue` is supplied and
// the key is unknown. Our two keys are "known", so return a marker per key.
const t = ((key: string, opts?: { defaultValue?: string }) => {
  if (key === "common.generationChannelPolicyBlocked") return "POLICY_MSG";
  if (key === "common.generationRateLimited") return "RATE_MSG";
  if (key === "common.error") return "GENERIC_ERROR";
  return opts?.defaultValue ?? key;
}) as unknown as Parameters<typeof humanizeTaskError>[1];

const CHANNEL_POLICY_RAW =
  '草图重生未生成可用图片（mode=1x1_2-3_sketch, beats=[5]）: HTTP 429: ' +
  'body={"error":{"message":"huimeng channel skipped for low quality request",' +
  '"type":"channel_policy","code":"huimeng_low_quality_skipped"}}';

const REAL_429_RAW =
  'Render 重生未生成可用图片: HTTP 429: rate limit exceeded; body={"error":{"message":"Too Many Requests"}}';

const MODERATION_RAW =
  'DramaClawAPI image generation failed: HTTP 400: request_id=req-123; ' +
  'body={"error":{"message":"Content failed safety review. / 内容未通过安全审核。",' +
  '"type":"content_policy_violation","param":"","code":"moderation_blocked"}}';

describe("providerErrorMessage", () => {
  it("extracts a top-level message from a pure provider JSON error", () => {
    expect(
      providerErrorMessage(
        '{"message":"Content failed safety review.","code":"moderation_blocked"}',
      ),
    ).toBe("Content failed safety review.");
  });

  it("extracts a nested provider message from a wrapped body without altering the raw input", () => {
    expect(providerErrorMessage(MODERATION_RAW)).toBe(
      "Content failed safety review. / 内容未通过安全审核。",
    );
  });

  it("returns null when the raw error has no parseable provider JSON", () => {
    expect(providerErrorMessage("disk full")).toBeNull();
  });
});

describe("classifyGatewayError", () => {
  it("flags channel_policy rejections (route-layer skip, not throttling)", () => {
    expect(classifyGatewayError(CHANNEL_POLICY_RAW)).toBe("channel_policy");
  });

  it("prefers channel_policy over the bare 429 signal when both present", () => {
    // The channel_policy body rides on an HTTP 429 too — must not be read as
    // a real rate limit.
    expect(classifyGatewayError(CHANNEL_POLICY_RAW)).not.toBe("rate_limit");
  });

  it("detects _skipped codes even without the literal channel_policy string", () => {
    expect(
      classifyGatewayError('HTTP 429: body={"error":{"code":"huimeng_low_quality_skipped"}}'),
    ).toBe("channel_policy");
  });

  it("flags a genuine HTTP 429 as a rate limit", () => {
    expect(classifyGatewayError(REAL_429_RAW)).toBe("rate_limit");
  });

  it("returns null for unrelated errors and empty input", () => {
    expect(classifyGatewayError("something else failed")).toBeNull();
    expect(classifyGatewayError("")).toBeNull();
    expect(classifyGatewayError(null)).toBeNull();
    expect(classifyGatewayError(undefined)).toBeNull();
  });
});

describe("humanizeTaskError", () => {
  it("maps channel_policy failures to the policy message", () => {
    expect(humanizeTaskError(CHANNEL_POLICY_RAW, t)).toBe("POLICY_MSG");
  });

  it("maps real 429s to the rate-limit message", () => {
    expect(humanizeTaskError(REAL_429_RAW, t)).toBe("RATE_MSG");
  });

  it("passes unrelated errors through unchanged", () => {
    expect(humanizeTaskError("disk full", t)).toBe("disk full");
  });

  it("shows only the provider message for moderation failures", () => {
    expect(humanizeTaskError(MODERATION_RAW, t)).toBe(
      "Content failed safety review. / 内容未通过安全审核。",
    );
    expect(backendErrorToastMessage(new Error(MODERATION_RAW), t)).toBe(
      "Content failed safety review. / 内容未通过安全审核。",
    );
  });

  it("falls back to the generic error label when input is empty", () => {
    expect(humanizeTaskError("", t)).toBe("GENERIC_ERROR");
    expect(humanizeTaskError(null, t)).toBe("GENERIC_ERROR");
  });
});
