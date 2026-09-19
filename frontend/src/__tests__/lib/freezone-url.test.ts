// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";
import {
  buildFreezoneCanvasUrl,
  buildFreezoneProjectUrl,
  buildFreezoneUrl,
  openFreezoneProject,
} from "@/lib/freezone-url";

describe("freezone-url", () => {
  describe("internal /freezone route", () => {
    it("maps a backend relative URL onto the project Freezone tab", () => {
      expect(buildFreezoneUrl("/?p=p1&canvas=c1")).toBe(
        "/projects/p1/freezone?canvas=c1",
      );
    });

    it("strips a backend-provided origin and keeps query/hash", () => {
      expect(buildFreezoneUrl("http://localhost:5175/?p=p1&canvas=c1#n")).toBe(
        "/projects/p1/freezone?canvas=c1#n",
      );
    });

    it("builds a project-level entry URL", () => {
      expect(buildFreezoneProjectUrl("01KS77361FXAQNKQF2W4EWWVCW")).toBe(
        "/projects/01KS77361FXAQNKQF2W4EWWVCW/freezone",
      );
    });

    it("builds a project canvas URL and escapes both ids", () => {
      expect(buildFreezoneCanvasUrl("project one", "canvas/two")).toBe(
        "/projects/project%20one/freezone?canvas=canvas%2Ftwo",
      );
    });
  });

  it("rejects empty / non-http inputs", () => {
    expect(buildFreezoneUrl("")).toBeNull();
    expect(buildFreezoneUrl("   ")).toBeNull();
    expect(buildFreezoneUrl("javascript:alert(1)")).toBeNull();
    expect(buildFreezoneUrl("not-a-path")).toBeNull();
    expect(buildFreezoneUrl("/?canvas=c1")).toBeNull();
    expect(buildFreezoneProjectUrl("")).toBeNull();
    expect(buildFreezoneProjectUrl("   ")).toBeNull();
    expect(buildFreezoneCanvasUrl("p1", "")).toBeNull();
  });

  it("stays same-origin", () => {
    expect(buildFreezoneProjectUrl("p1")).toBe("/projects/p1/freezone");
  });

  it("openFreezoneProject returns false for empty ids", () => {
    expect(openFreezoneProject("")).toBe(false);
  });
});
