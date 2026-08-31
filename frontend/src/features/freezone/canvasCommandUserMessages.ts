import type { CanvasChatCommandApplyStep } from "@/features/freezone/canvasChatCommands";

const CANVAS_PROTOCOL_DETAIL_PATTERN =
  /\b(?:semanticOutputRole|planning_text|input_text|context_text|prompt_for|context_for|link_type|node_type|node_id|schema|envelopes\[\d+\]|commands\[\d+\])\b/;

function rawText(errors: string[] | undefined, commandResults: Array<Partial<CanvasChatCommandApplyStep>> | undefined): string {
  return [
    ...(errors ?? []),
    ...(commandResults ?? []).map((step) => step.error).filter((item): item is string => typeof item === "string"),
  ].join("\n");
}

export function canvasCommandUserMessageFromResult(
  errors: string[] | undefined,
  commandResults: Array<Partial<CanvasChatCommandApplyStep>> | undefined,
): string {
  const text = rawText(errors, commandResults);
  if (!text.trim()) return "画布操作没有完成，我会换一种方式再试。";
  if (/Recipe\s*文本生成超时|Recipe text generation.*(?:timed out|timeout)|Request timed out/i.test(text)) {
    return "Recipe 文本生成超时：模型在规定时间内未返回结果，请稍后重试。本轮未继续执行下游节点。";
  }
  if (/cancel|取消|超时/i.test(text)) return "画布操作已取消，没有应用到画布。";
  if (/field model value|not a valid option.*model|模型|model/i.test(text) && /not a valid option|不可用|invalid/i.test(text)) {
    return "当前选择的生成模型不可用，我会改用当前画布支持的模型。";
  }
  if (/planning_text|input_text|semanticOutputRole|prompt_for/.test(text)) {
    return "当前文本需要先作为生成提示词连接到图片节点，我会按可执行的提示词来源来处理。";
  }
  if (/link_type .*not valid|not valid for .*->|cannot connect|不支持.*连接/i.test(text)) {
    return "这两个节点不能用刚才的方式连接，我会换成画布支持的连接方式。";
  }
  if (/(source node not found|target node not found|node not found|节点.*不存在|没找到.*节点)/i.test(text)) {
    return "我没找到要操作的节点，请先选中节点，或告诉我具体是哪一个。";
  }
  if (/fields are not editable|not editable|不能编辑/i.test(text)) {
    return "这个节点的部分内容不能直接修改，我会改用它支持的编辑方式。";
  }
  if (CANVAS_PROTOCOL_DETAIL_PATTERN.test(text)) {
    return "画布操作没有完成，我会根据当前画布规则换一种可执行方式再试。";
  }
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

export function canvasCommandAgentHintFromResult(
  errors: string[] | undefined,
  commandResults: Array<Partial<CanvasChatCommandApplyStep>> | undefined,
): string {
  const userMessage = canvasCommandUserMessageFromResult(errors, commandResults);
  return [
    "Do not mention raw canvas protocol details to the user, including semanticOutputRole, planning_text, input_text, prompt_for, context_for, schema names, command paths, or node ids unless the user explicitly asks for implementation details.",
    `Use this user-facing summary if you need to explain the failure: ${userMessage}`,
    "The raw errors and command_results remain available for diagnosis; fix the command and retry only when it is safe.",
  ].join(" ");
}
