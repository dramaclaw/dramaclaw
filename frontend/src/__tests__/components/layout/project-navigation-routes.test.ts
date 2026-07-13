// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PROJECT_SECTION_ROUTES,
  projectModeFromPath,
  projectSectionFromPath,
} from "@/components/layout/project-navigation-routes";

describe("project navigation routes", () => {
  it("uses freezone as the project dashboard entry", () => {
    expect(PROJECT_SECTION_ROUTES.freezone).toBe("/projects/$project/freezone");
  });

  it("classifies freezone as xiahua and every production section as xiaji", () => {
    expect(projectModeFromPath("/projects/demo/freezone")).toBe("xiahua");
    expect(projectModeFromPath("/projects/demo/ingest")).toBe("xiaji");
    expect(projectModeFromPath("/projects/demo/tasks")).toBe("xiaji");
  });

  it("preserves the tasks section when switching projects", () => {
    expect(projectSectionFromPath("/projects/demo/tasks")).toBe("tasks");
  });

  it("does not silently classify unknown project sections as freezone", () => {
    expect(projectSectionFromPath("/projects/demo/unknown")).toBeNull();
  });
});
