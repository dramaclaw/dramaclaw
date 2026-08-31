// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { canvasNodeDefinitions } from "@/features/canvas/domain/nodeRegistry";
import { CanvasAddNodePanel } from "@/features/canvas/ui/CanvasAddNodePanel";
import { canvasMenuIconMap } from "@/features/canvas/ui/canvas-node-menu-shared";

const translations: Record<string, string> = {
  "node.menu.sectionAddNode": "添加节点",
  "node.menu.sectionAddResource": "添加资源",
  "node.menu.sectionSkillNode": "技能节点",
  "node.menu.uploadImage": "上传资源",
  "node.menu.image": "图片",
  "node.menu.aiImageGeneration": "AI 图片",
  "node.menu.storyboard": "分格抽取结果",
  "node.menu.storyboardGen": "多版本宫格",
  "node.menu.beatContext": "镜头上下文",
  "node.menu.textAnnotation": "文本",
  "node.menu.video": "视频",
  "node.menu.audio": "音频",
  "node.menu.videoStory": "视频故事",
  "node.menu.videoCompose": "视频合成",
  "node.menu.script": "脚本",
  "node.menu.pano360Viewer": "360° 全景",
  "node.menu.threeDWorld": "3D 世界",
  "node.menu.previz": "预演台",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

describe("CanvasAddNodePanel", () => {
  it("shows standalone shot context in the quick add panel", async () => {
    const user = userEvent.setup();
    const onSelectNode = vi.fn();
    const onClose = vi.fn();

    render(
      <CanvasAddNodePanel skillItems={[]} onSelectNode={onSelectNode} onSelectSkill={vi.fn()} onClose={onClose} />,
    );

    await user.click(screen.getByRole("button", { name: /镜头上下文/ }));

    expect(onSelectNode).toHaveBeenCalledWith(CANVAS_NODE_TYPES.beatContext);
    expect(onClose).toHaveBeenCalled();
  });

  it("offers the previz stage in the quick add panel", async () => {
    const user = userEvent.setup();
    const onSelectNode = vi.fn();

    render(
      <CanvasAddNodePanel skillItems={[]} onSelectNode={onSelectNode} onSelectSkill={vi.fn()} onClose={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: /预演台/ }));

    expect(onSelectNode).toHaveBeenCalledWith(CANVAS_NODE_TYPES.previz);
  });
});

/** 按 "a.b.c" 取值；中途断链或末端不是字符串都返回 null，交给调用方记账。 */
function lookupString(root: unknown, path: string): string | null {
  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : null;
}

// 菜单文案漏进 locale 是静默故障：zh 缺键时 i18next 直接把原始 key 渲染出来；
// en 缺键时被 i18n/index.ts 的 fallbackLng: "zh" 兜住，在英文界面里渲染出中文
// ——两种都不抛错，后者还更隐蔽（看着像「没翻译完」而不是「键没配」）。
// 而 src/__tests__/i18n/locales-json.test.ts 只校验 zh/en 两边键集「互相对齐」，
// 两边都漏也算对齐，盖不住这里。
describe("canvas menu labels and icons", () => {
  const locales = (["zh", "en"] as const).map((language) => ({
    language,
    data: JSON.parse(
      readFileSync(`public/locales/${language}/translation.json`, "utf8"),
    ) as unknown,
  }));
  const menuDefinitions = Object.values(canvasNodeDefinitions).filter(
    (definition) => definition.visibleInMenu,
  );

  it("covers every menu-visible node type in both locales", () => {
    const missing: string[] = [];
    for (const definition of menuDefinitions) {
      for (const { language, data } of locales) {
        const label = lookupString(data, definition.menuLabelKey);
        if (!label) {
          missing.push(`${language}:${definition.menuLabelKey} (${definition.type})`);
        }
      }
    }

    expect(missing.sort()).toEqual([]);
    // 防空转：双重循环任一侧为空都会得到空数组，所以两侧被遍历的集合各钉一下。
    expect(menuDefinitions.map((definition) => definition.type)).toContain(
      CANVAS_NODE_TYPES.previz,
    );
    expect(locales.map(({ language }) => language)).toEqual(["zh", "en"]);
  });

  it("maps every menu-visible node type to a known icon", () => {
    // 这条今天由 tsc 兜着：canvasMenuIconMap 声明成 Record<MenuIconKey, LucideIcon>，
    // 少一项就编译不过。留着是防它被放宽成 Partial —— 那时 canvas-node-menu-shared.tsx
    // 里的 `?? Image` 兜底会让图标错了也不崩，静默退化成通用图片图标。
    const unmapped = menuDefinitions
      .filter((definition) => !(definition.menuIcon in canvasMenuIconMap))
      .map((definition) => `${definition.type}:${definition.menuIcon}`);

    expect(unmapped.sort()).toEqual([]);
    expect(menuDefinitions.length).toBeGreaterThan(0);
  });
});
