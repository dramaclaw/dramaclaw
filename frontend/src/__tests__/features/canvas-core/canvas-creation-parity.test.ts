// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { planCanvasCreation } from "@/features/canvas/core/canvasCreation";
import type { CanvasCreationPlan, PlanCanvasCreationInput } from "@/features/canvas/core/canvasCreation";
import { createServerTranslate } from "@/features/canvas/server/i18n";
import { MAX_USER_CREATED_CANVASES_PER_PROJECT } from "@/lib/limits";

interface CreationFixture {
  schema: string;
  note: string;
  limit: number;
  cases: {
    name: string;
    locale: string;
    covers: string[];
    input: PlanCanvasCreationInput;
    expected: CanvasCreationPlan;
  }[];
}

const fixture: CreationFixture = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "__parity__/canvas-creation.json"), "utf8",
));

describe("canvas creation browser parity", () => {
  it("keeps the recorded schema, quota limit and 30 uniquely named cases", () => {
    expect(fixture.schema).toBe("canvas_creation_plan_fixture.v1");
    expect(fixture.limit).toBe(MAX_USER_CREATED_CANVASES_PER_PROJECT);
    expect(fixture.cases).toHaveLength(30);
    expect(new Set(fixture.cases.map((row) => row.name)).size).toBe(30);
  });

  it("covers every rejection, a ready plan and the required browser scenarios", () => {
    const codes = fixture.cases.flatMap(({ expected }) => expected.status === "rejected" ? [expected.rejection.code] : []);
    expect([...new Set(codes)].sort()).toEqual([
      "duplicate_name", "id_taken", "name_required", "quota_reached", "quota_unknown",
    ]);
    expect(fixture.cases.some(({ expected }) => expected.status === "ready")).toBe(true);
    expect([...new Set(fixture.cases.flatMap((row) => row.covers))]).toEqual(expect.arrayContaining([
      "success", "quota_unknown", "quota_reached", "name_required", "duplicate_name", "id_taken",
      "system_name_locale", "conflict_copy", "others_not_counted", "list_unavailable", "name_whitespace",
      "name_case", "non_ascii_name", "agent_create",
    ]));
  });

  it.each(fixture.cases)("$name", async (row) => {
    const translate = await createServerTranslate(row.locale);
    expect(planCanvasCreation(row.input, { translate })).toEqual(row.expected);
  });
});
