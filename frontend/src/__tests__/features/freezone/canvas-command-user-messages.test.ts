import { describe, expect, it } from "vitest";

import { canvasCommandUserMessageFromResult } from
  "@/features/freezone/canvasCommandUserMessages";

describe("canvasCommandUserMessageFromResult", () => {
  it("returns one explicit message for duplicate Recipe text timeouts", () => {
    expect(canvasCommandUserMessageFromResult(
      [
        "Recipe 文本生成超时：模型在规定时间内未返回结果，请稍后重试。",
        "Recipe 文本生成超时：模型在规定时间内未返回结果，请稍后重试。",
      ],
      [
        {
          error: "Recipe 文本生成超时：模型在规定时间内未返回结果，请稍后重试。",
        },
      ],
    )).toBe(
      "Recipe 文本生成超时：模型在规定时间内未返回结果，请稍后重试。本轮未继续执行下游节点。",
    );
  });

  it("does not misreport a Recipe timeout as user cancellation", () => {
    expect(canvasCommandUserMessageFromResult(
      ["Request timed out."],
      [],
    )).toContain("Recipe 文本生成超时");
  });
});
