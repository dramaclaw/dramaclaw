// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  filterFreezoneSkillSuggestions,
  findFreezoneSkillMention,
  FREEZONE_SKILL_EMPTY_ACTIONS,
  getFreezoneSkillSlashQuery,
  insertFreezoneSkillEmptyActionPrompt,
  insertFreezoneSkillMention,
  moveFreezoneSkillSuggestionIndex,
  removeFreezoneSkillMention,
  shouldShowFreezoneSkillSuggestionMenu,
  splitFreezoneSkillMentionText,
  toFreezoneSkillSuggestions,
} from "@/features/superchat/freezone-skill-suggestions";

describe("freezone skill slash suggestions", () => {
  it("builds suggestions only from enabled skills with ids", () => {
    const suggestions = toFreezoneSkillSuggestions([
      {
        id: "poster_design",
        name: "海报设计",
        enabled: true,
        allowed_recipe_ids: ["poster-image"],
        category: "visual",
        description: "海报视觉风格",
        triggers: { keywords: ["海报", { keyword: "视觉" }] },
      },
      { id: "general", enabled: true, description: "没有 Recipe 边界" },
      { id: "disabled_skill", enabled: false, description: "不展示" },
      { enabled: true, description: "没有 id" },
    ]);

    expect(suggestions).toEqual([
      {
        id: "poster_design",
        label: "海报设计",
        category: "visual",
        description: "海报视觉风格",
        keywords: ["海报", "视觉"],
      },
    ]);
  });

  it("opens only for the current slash token and filters by id, category, description, or keywords", () => {
    const suggestions = toFreezoneSkillSuggestions([
      {
        id: "poster_design",
        allowed_recipe_ids: ["poster-image"],
        category: "visual",
        description: "海报视觉风格",
        triggers: { keywords: ["海报"] },
      },
      {
        id: "copy_plan",
        allowed_recipe_ids: ["copy-text"],
        category: "text",
        description: "详情页文案",
        triggers: { keywords: ["文案"] },
      },
    ]);

    expect(getFreezoneSkillSlashQuery("/")).toBe("");
    expect(getFreezoneSkillSlashQuery("请用 /post")).toBe("post");
    expect(getFreezoneSkillSlashQuery("请用 /post 继续")).toBeNull();
    expect(filterFreezoneSkillSuggestions(suggestions, "视觉").map((item) => item.id)).toEqual([
      "poster_design",
    ]);
    expect(filterFreezoneSkillSuggestions(suggestions, "text").map((item) => item.id)).toEqual([
      "copy_plan",
    ]);
  });

  it("inserts the selected skill as visible prompt text without hidden metadata", () => {
    expect(insertFreezoneSkillMention("/", "poster_design")).toBe("/poster_design ");
    expect(insertFreezoneSkillMention("帮我 /post", "poster_design")).toBe("帮我 /poster_design ");
    expect(insertFreezoneSkillMention("第一行\n/post", "poster_design")).toBe("第一行\n/poster_design ");
    expect(insertFreezoneSkillMention("帮我做", "poster_design")).toBe("帮我做 /poster_design ");
  });

  it("finds a completed skill mention wherever slash suggestions can be used", () => {
    expect(findFreezoneSkillMention("/poster_design 做一张海报")).toMatchObject({
      skillId: "poster_design",
      start: 0,
      end: 14,
    });
    expect(findFreezoneSkillMention("帮我 /poster_design 做一张海报")).toMatchObject({
      skillId: "poster_design",
      start: 3,
      end: 17,
    });
    expect(findFreezoneSkillMention("第一行\n/poster_design 做一张海报")).toMatchObject({
      skillId: "poster_design",
      start: 4,
      end: 18,
    });
    expect(findFreezoneSkillMention("https://example.com/poster_design")).toBeNull();
  });

  it("removes a selected skill mention without leaving doubled spacing", () => {
    const mention = findFreezoneSkillMention("帮我 /poster_design 做一张海报");
    expect(removeFreezoneSkillMention("帮我 /poster_design 做一张海报", mention)).toBe("帮我 做一张海报");
    expect(removeFreezoneSkillMention("/poster_design 做一张海报", findFreezoneSkillMention("/poster_design 做一张海报"))).toBe(
      "做一张海报",
    );
  });

  it("splits sent message text into normal text and skill mention parts", () => {
    expect(splitFreezoneSkillMentionText("/poster_design 做一张海报")).toEqual([
      { type: "skill", skillId: "poster_design" },
      { type: "text", text: " 做一张海报" },
    ]);
    expect(splitFreezoneSkillMentionText("帮我 /poster_design 做一张海报 /copy_plan")).toEqual([
      { type: "text", text: "帮我 " },
      { type: "skill", skillId: "poster_design" },
      { type: "text", text: " 做一张海报 " },
      { type: "skill", skillId: "copy_plan" },
    ]);
  });

  it("cycles the active suggestion index with arrow keys", () => {
    expect(moveFreezoneSkillSuggestionIndex(0, 1, 3)).toBe(1);
    expect(moveFreezoneSkillSuggestionIndex(2, 1, 3)).toBe(0);
    expect(moveFreezoneSkillSuggestionIndex(0, -1, 3)).toBe(2);
    expect(moveFreezoneSkillSuggestionIndex(8, 1, 2)).toBe(1);
    expect(moveFreezoneSkillSuggestionIndex(0, 1, 0)).toBe(0);
  });

  it("keeps the slash skill menu open for empty results", () => {
    expect(shouldShowFreezoneSkillSuggestionMenu({ isFreezoneLayout: true, slashQuery: "" })).toBe(
      true,
    );
    expect(
      shouldShowFreezoneSkillSuggestionMenu({ isFreezoneLayout: true, slashQuery: "missing" }),
    ).toBe(true);
    expect(shouldShowFreezoneSkillSuggestionMenu({ isFreezoneLayout: true, slashQuery: null })).toBe(
      false,
    );
    expect(
      shouldShowFreezoneSkillSuggestionMenu({
        isFreezoneLayout: true,
        slashQuery: null,
        explicitOpen: true,
      }),
    ).toBe(true);
    expect(shouldShowFreezoneSkillSuggestionMenu({ isFreezoneLayout: false, slashQuery: "" })).toBe(
      false,
    );
    expect(
      shouldShowFreezoneSkillSuggestionMenu({
        isFreezoneLayout: false,
        slashQuery: null,
        explicitOpen: true,
      }),
    ).toBe(false);
  });

  it("fills the composer with an empty-state skill creation prompt", () => {
    expect(FREEZONE_SKILL_EMPTY_ACTIONS.map((action) => action.id)).toEqual([
      "summarize-canvas",
      "create-with-agent",
    ]);
    expect(insertFreezoneSkillEmptyActionPrompt("/", FREEZONE_SKILL_EMPTY_ACTIONS[0].prompt)).toBe(
      "把当前画布总结成一个可复用 Skill",
    );
    expect(insertFreezoneSkillEmptyActionPrompt("我想 /skill", FREEZONE_SKILL_EMPTY_ACTIONS[1].prompt)).toBe(
      "我想 帮我创建一个 Skill：",
    );
  });
});
