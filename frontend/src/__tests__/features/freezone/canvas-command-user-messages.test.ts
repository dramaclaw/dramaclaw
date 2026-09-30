import { describe, expect, it } from "vitest";

import {
  canvasCommandAgentHintFromResult,
  canvasCommandUserMessageFromResult,
} from "@/features/freezone/canvasCommandUserMessages";

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

describe("unavailable model failures", () => {
  const errors = ["field model value 'LingShan-G2' is not a valid option"];

  it("asks the user to pick a model instead of promising to switch it", () => {
    const message = canvasCommandUserMessageFromResult(errors, []);
    expect(message).toContain("生成模型不可用");
    expect(message).toContain("选择");
    expect(message).not.toContain("我会改用");
  });

  it("tells the agent not to change the model or rerun without the user's choice", () => {
    const hint = canvasCommandAgentHintFromResult(errors, []);
    expect(hint).toMatch(/do not change the node's model/i);
    expect(hint).toMatch(/ask the user/i);
    expect(hint).not.toMatch(/fix the command and retry/i);
  });

  it("keeps the generic retry hint for other failures", () => {
    const hint = canvasCommandAgentHintFromResult(["source node not found: n1"], []);
    expect(hint).toMatch(/fix the command and retry only when it is safe/i);
  });
});
