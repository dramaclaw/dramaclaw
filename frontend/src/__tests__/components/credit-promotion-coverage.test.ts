// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = join(process.cwd(), "src");

function productionTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : productionTsxFiles(path);
    }
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("credit promotion display coverage", () => {
  it("passes promotion metadata to every production credit component", () => {
    const missing: string[] = [];
    const tagPattern = /<CreditCost(?:Inline|Pill)\b[\s\S]*?\/>/g;

    for (const file of productionTsxFiles(SOURCE_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(tagPattern)) {
        const tag = match[0];
        if (!tag.includes("promotion=") && !tag.includes('display="0"')) {
          const line = source.slice(0, match.index).split("\n").length;
          missing.push(`${relative(SOURCE_ROOT, file)}:${line}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
