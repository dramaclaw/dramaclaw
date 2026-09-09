// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { identityPeriodLabel, identityRefLabel } from "@/lib/identity-period";

// 假 t：把 key 原样回显，够看出「查到词条了没」。
const t = ((key: string) => key) as never;

describe("identityPeriodLabel", () => {
  it("认得的时期名走词条", () => {
    expect(identityPeriodLabel("青年时期", t)).toBe(
      "characters.identityPeriods.youngAdult",
    );
  });

  it("认不得的自造名原样回显", () => {
    expect(identityPeriodLabel("大厂时期", t)).toBe("大厂时期");
    expect(identityPeriodLabel("", t)).toBe("");
    expect(identityPeriodLabel(null, t)).toBe("");
  });
});

describe("identityRefLabel", () => {
  it("只本地化下划线后的时期名，角色名原样保留", () => {
    expect(identityRefLabel("沈晚_青年时期", t)).toBe(
      "沈晚_characters.identityPeriods.youngAdult",
    );
  });

  it("角色名自带下划线时按最后一个下划线切", () => {
    expect(identityRefLabel("沈_晚_中年时期", t)).toBe(
      "沈_晚_characters.identityPeriods.middleAge",
    );
  });

  it("时期名认不得就整串原样回显，不做半截替换", () => {
    expect(identityRefLabel("沈晚_大厂时期", t)).toBe("沈晚_大厂时期");
  });

  it("没有下划线时按纯时期名处理", () => {
    expect(identityRefLabel("老年时期", t)).toBe(
      "characters.identityPeriods.laterYears",
    );
    expect(identityRefLabel("路人甲", t)).toBe("路人甲");
  });

  it("下划线在首尾这类畸形值不崩", () => {
    expect(identityRefLabel("_青年时期", t)).toBe("_青年时期");
    expect(identityRefLabel("沈晚_", t)).toBe("沈晚_");
  });
});
