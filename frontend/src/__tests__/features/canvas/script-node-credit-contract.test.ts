// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nodeSource = readFileSync(
  "src/features/canvas/nodes/ScriptNode.tsx",
  "utf8",
);

describe("canvas script node credit contract", () => {
  it("quotes the story-script feature even when the input has zero characters", () => {
    expect(nodeSource).toContain(
      "useGenerationCreditCost(\n    'feature',\n    STORY_SCRIPT_FEATURE_KEY,",
    );
    expect(nodeSource).toContain("{ surface: 'canvas', quantity: storyBillableChars }");
    expect(nodeSource).not.toContain(
      "storyBillableChars > 0 ? STORY_SCRIPT_FEATURE_KEY : null",
    );
  });

  it("shows the configuration fallback when the story-script rule is missing", () => {
    expect(nodeSource).toContain(
      "scriptCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(nodeSource).toContain("t('common.billingRuleNotConfiguredShort')");
  });
});
