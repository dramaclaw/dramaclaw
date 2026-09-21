// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  BLENDER_ADDON_DOWNLOAD_URL,
  BlenderAddonDownloadLink,
} from "@/features/blender/BlenderAddonDownloadLink";

describe("BlenderAddonDownloadLink", () => {
  it("是一个指向后端端点、由服务端定文件名的下载链接", () => {
    render(<BlenderAddonDownloadLink />);
    const link = screen.getByRole("link", { name: "Blender 插件" });
    expect(link).toHaveAttribute("href", BLENDER_ADDON_DOWNLOAD_URL);
    // download 不给值：文件名听服务端 Content-Disposition 的。
    expect(link).toHaveAttribute("download", "");
    expect(link).not.toHaveAttribute("target");
  });

  it("把自定义 className 合并到锚点上", () => {
    render(<BlenderAddonDownloadLink className="ml-2" />);
    const link = screen.getByRole("link", { name: "Blender 插件" });
    expect(link).toHaveClass("ml-2");
  });
});
