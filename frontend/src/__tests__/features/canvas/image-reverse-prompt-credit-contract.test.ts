// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nodeSource = readFileSync(
  "src/features/canvas/nodes/TextAnnotationNode.tsx",
  "utf8",
);

describe("canvas image reverse-prompt credit contract", () => {
  it("quotes reverse prompt as a product feature", () => {
    expect(nodeSource).toContain(
      "const IMAGE_REVERSE_PROMPT_FEATURE_KEY = 'freezone.image_reverse_prompt'",
    );
    expect(nodeSource).toContain(
      "mode === 'imageToPrompt' ? IMAGE_REVERSE_PROMPT_FEATURE_KEY : null",
    );
    expect(nodeSource).toContain("operation: 'image_reverse_prompt'");
    expect(nodeSource).toContain(
      "quantity: reversePromptBillableChars",
    );
    expect(nodeSource).toContain(
      "billable_chars: reversePromptBillableChars",
    );
    expect(nodeSource).toContain(
      "pricing_quantity: reversePromptBillableChars",
    );
    expect(nodeSource).toContain(
      "instruction: reversePromptInstruction",
    );
    expect(nodeSource).not.toContain(
      "mode === 'imageToPrompt' ? 'freezone_image_reverse_prompt' : ''",
    );
  });

  it("shows and blocks on an unconfigured reverse-prompt rule", () => {
    expect(nodeSource).toContain(
      "reversePromptCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(nodeSource).toContain(
      "t('common.billingRuleNotConfiguredShort')",
    );
    expect(nodeSource).toContain(
      "mode === 'imageToPrompt' && reversePromptBillingRuleMissing",
    );
    expect(nodeSource).toContain(
      "<CreditCostInline display={reversePromptCostDisplay} />",
    );
  });
});
