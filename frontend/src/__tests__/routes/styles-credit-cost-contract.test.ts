// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  "src/routes/_app/projects.$project/styles.tsx",
  "utf8",
);
const querySource = readFileSync("src/lib/queries/styles.ts", "utf8");

describe("style analysis feature credit contract", () => {
  it("quotes the strict namespaced feature and shows missing-rule state", () => {
    expect(routeSource).toContain('"mainline.style_analysis"');
    expect(routeSource).toContain('"feature",');
    expect(routeSource).toContain(
      "styleAnalyzeCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(routeSource).toContain('t("common.billingRuleNotConfiguredShort")');
    expect(routeSource).toMatch(
      /<CreditCostInline\s+display=\{styleAnalyzeCostDisplay\}/,
    );
  });

  it("uses typed backend errors for insufficient credit and missing rules", () => {
    expect(querySource).toContain("jsonWithBackendError");
    expect(querySource).toContain("throwHttpErrors: false");
    expect(routeSource).toContain("backendErrorToastMessage(error, t)");
  });
});
