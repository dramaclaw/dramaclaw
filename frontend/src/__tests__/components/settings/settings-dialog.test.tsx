// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { SettingsDialog } from "@/components/settings/settings-dialog";

const runtimeState = vi.hoisted(() => ({ isCeRuntime: true }));
const modelGatewayMocks = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  saveBrainClaw: vi.fn(),
  setCustomLlmMode: vi.fn(),
}));
const freezoneAgentConfigMocks = vi.hoisted(() => ({
  delete: vi.fn(),
  exportBundle: vi.fn(),
  installBundle: vi.fn(),
  items: [] as Array<Record<string, unknown>>,
  itemsByKind: {} as Record<string, Array<Record<string, unknown>>>,
  refetch: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
}));

vi.mock("@/lib/queries/freezone-agent-config", () => ({
  useFreezoneAgentConfigItems: (kind: string) => {
    const scopedItems = freezoneAgentConfigMocks.itemsByKind[kind];
    return {
      data: scopedItems ?? freezoneAgentConfigMocks.items,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: freezoneAgentConfigMocks.refetch,
    };
  },
  useSaveFreezoneAgentConfigItem: () => ({
    mutateAsync: freezoneAgentConfigMocks.save,
    isPending: false,
  }),
  useDeleteFreezoneAgentConfigItem: () => ({
    mutateAsync: freezoneAgentConfigMocks.delete,
    isPending: false,
  }),
  useInstallFreezoneAgentBundle: () => ({
    mutateAsync: freezoneAgentConfigMocks.installBundle,
    isPending: false,
  }),
  useExportFreezoneAgentBundle: () => ({
    mutateAsync: freezoneAgentConfigMocks.exportBundle,
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/model-gateway", () => ({
  useModelGatewayConfig: () => ({
    data: modelGatewayMocks.config ? { data: modelGatewayMocks.config } : undefined,
    isLoading: false,
  }),
  useOfficialMediaCatalogStatus: () => ({ data: undefined, isLoading: false }),
  useSaveOfficialMediaCatalogPreferences: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useCheckOfficialMediaCatalog: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useNewApiChannelTypes: () => ({ data: undefined, isLoading: false }),
  useEnableOfficial: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEnableCustom: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEnableHybrid: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useEnableBrainClaw: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveOfficialConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveBrainClawConfig: () => ({
    mutateAsync: modelGatewayMocks.saveBrainClaw,
    isPending: false,
  }),
  useSetCustomLlmMode: () => ({
    mutateAsync: modelGatewayMocks.setCustomLlmMode,
    isPending: false,
  }),
  useInitCustomNewApi: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveCustomChannel: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveCustomChannelsBatch: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveEmbeddingModel: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveMediaModels: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveProviderChannels: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveMediaRelayConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSyncProviderChannel: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: {
        defaultValue?: string;
        count?: number;
        exclusiveCount?: number;
        id?: string;
        page?: string;
        selectedCount?: number;
        sharedCount?: number;
      },
    ) =>
      ({
        "settings.title": "设置",
        "settings.close": "关闭",
        "settings.navigationLabel": "设置导航",
        "settings.pages.models": "模型配置",
        "settings.pages.storage": "媒体存储",
        "settings.pages.freezoneSkills": "虾画 Skills",
        "settings.pages.freezoneRecipes": "虾画 Recipes",
        "settings.statusConfigured": `${options?.page ?? ""}已配置`,
        "settings.statusNotConfigured": `${options?.page ?? ""}未配置`,
        "settings.modelConfig.title": "模型配置",
        "settings.modelConfig.description": "选择模型网关渠道",
        "settings.modelConfig.gatewayWarningIconLabel": "模型网关未配置",
        "settings.modelConfig.gatewayNotConfiguredImpact": "模型网关未配置",
        "settings.modelConfig.modes.official": "官方渠道",
        "settings.modelConfig.modes.custom": "自定义 NewAPI",
        "settings.modelConfig.official.description": "官方渠道说明",
        "settings.modelConfig.official.registerLink": "注册",
        "settings.modelConfig.official.save": "保存并启用",
        "settings.modelConfig.brainclaw.tab": "虾驿 BrainClaw（推荐）",
        "settings.modelConfig.brainclaw.advancedTab": "高级自定义",
        "settings.modelConfig.brainclaw.title": "虾脑 BrainClaw（推荐）",
        "settings.modelConfig.brainclaw.description": "虾脑仅通过虾驿提供",
        "settings.modelConfig.brainclaw.model": "固定模型",
        "settings.modelConfig.brainclaw.save": "保存并启用 BrainClaw",
        "settings.modelConfig.featureModels.title": "业务模型映射",
        "settings.modelConfig.embeddingModel.title": "Embedding 模型",
        "settings.modelConfig.mediaModels.title": "媒体模型",
        "settings.modelConfig.fields.gatewayBaseUrl": "网关地址",
        "settings.modelConfig.fields.apiKey": "API Key",
        "settings.mediaStorage.title": "图床 / 媒体存储",
        "settings.mediaStorage.description": "媒体存储说明",
        "settings.freezoneCatalog.skills.description": "管理 Agent 可直接使用的技能。",
        "settings.freezoneCatalog.recipes.description": "维护 Skill 可调用的底层 Recipes，通常用于调试或内置能力管理。",
        "settings.freezoneCatalog.searchSkills": "搜索 Skill",
        "settings.freezoneCatalog.searchRecipes": "搜索 Recipe",
        "settings.freezoneCatalog.emptySkills": "暂无虾画 Skills",
        "settings.freezoneCatalog.emptyRecipes": "暂无虾画 Recipes",
        "settings.freezoneCatalog.emptyDescription": "当前还没有配置项。",
        "settings.freezoneCatalog.loading": "加载中…",
        "settings.freezoneCatalog.retry": "重试",
        "settings.freezoneCatalog.saved": "虾画配置已保存",
        "settings.freezoneCatalog.saveFailed": "保存失败，请检查配置内容",
        "settings.freezoneCatalog.deleted": "虾画配置已删除",
        "settings.freezoneCatalog.deleteFailed": "删除失败，请重试",
        "settings.freezoneCatalog.deleteSelected": "删除选中",
        "settings.freezoneCatalog.deleteSkillDialog.title": "删除 Skill",
        "settings.freezoneCatalog.deleteSkillDialog.description": `确定要删除「${options?.id ?? ""}」吗？`,
        "settings.freezoneCatalog.deleteSkillDialog.recipeHint": `这个 Skill 使用了 ${options?.count ?? 0} 个能力模块，其中 ${options?.exclusiveCount ?? 0} 个仅当前 Skill 使用，${options?.sharedCount ?? 0} 个也被其他 Skill 使用。`,
        "settings.freezoneCatalog.deleteSkillDialog.exclusiveRecipes": "可随 Skill 一起删除",
        "settings.freezoneCatalog.deleteSkillDialog.sharedRecipes": "共享模块会保留",
        "settings.freezoneCatalog.deleteSkillDialog.cancel": "取消",
        "settings.freezoneCatalog.deleteSkillDialog.deleteSkillOnly": "只删除 Skill",
        "settings.freezoneCatalog.deleteSkillDialog.deleteWithRecipes": "删除 Skill 和独占模块",
        "settings.freezoneCatalog.exported": "虾画配置已导出",
        "settings.freezoneCatalog.imported": "虾画配置已导入",
        "settings.freezoneCatalog.importFailed": "导入失败，请选择有效的 JSON 文件",
        "settings.freezoneCatalog.toggleEnabled": `切换 ${options?.id ?? ""} 启用状态`,
        "settings.freezoneCatalog.editItem": `编辑 ${options?.id ?? ""}`,
        "settings.freezoneCatalog.deleteItem": `删除 ${options?.id ?? ""}`,
        "settings.freezoneCatalog.refresh": "刷新",
        "settings.freezoneCatalog.advancedManagement": "高级管理",
        "settings.freezoneCatalog.backToSkills": "返回 Skills",
        "settings.freezoneCatalog.import": "导入",
        "settings.freezoneCatalog.importBundle": "导入 Skill",
        "settings.freezoneCatalog.export": "导出",
        "settings.freezoneCatalog.exportBundle": "导出 Skill",
        "settings.freezoneCatalog.community.filters.all": "全部",
        "settings.freezoneCatalog.new": "新增",
        "settings.freezoneCatalog.selectAll": "全选",
        "settings.freezoneCatalog.backToTop": "顶部",
        "settings.freezoneCatalog.readOnly": "只读",
        "settings.freezoneCatalog.builtIn": "内置",
        "settings.freezoneCatalog.customized": "已定制",
        "settings.freezoneCatalog.customizedShort": "定制",
        "settings.freezoneCatalog.skillsCount": `共 ${options?.count ?? 0} 项`,
        "settings.freezoneCatalog.recipesCount": `共 ${options?.count ?? 0} 项`,
        "settings.freezoneCatalog.selectionCount": `已选 ${options?.selectedCount ?? 0} / 共 ${options?.count ?? 0} 项`,
        "settings.freezoneCatalog.recipesPendingTitle": "Recipe 配置入口已预留",
        "settings.freezoneCatalog.recipesPendingDescription": "等待后端 Recipe catalog 接入后，这里会展示和编辑虾画 Recipes。",
        "settings.freezoneCatalog.newSkill.title": "新增 Skill",
        "settings.freezoneCatalog.newSkill.editTitle": "编辑 Skill",
        "settings.freezoneCatalog.newSkill.close": "关闭新增 Skill",
        "settings.freezoneCatalog.newSkill.cancel": "取消",
        "settings.freezoneCatalog.newSkill.save": "保存",
        "settings.freezoneCatalog.newSkill.id": "ID",
        "settings.freezoneCatalog.newSkill.idHint": "仅允许 a-z、0-9、-、_",
        "settings.freezoneCatalog.newSkill.name": "名称",
        "settings.freezoneCatalog.newSkill.namePlaceholder": "如：品牌视频 Skill",
        "settings.freezoneCatalog.newSkill.category": "分类",
        "settings.freezoneCatalog.newSkill.description": "适用说明",
        "settings.freezoneCatalog.newSkill.descriptionPlaceholder": "适用场景描述",
        "settings.freezoneCatalog.newSkill.triggerTitle": "触发条件",
        "settings.freezoneCatalog.newSkill.triggerDescription": "定义哪些关键词或节点类型会激活此 Skill",
        "settings.freezoneCatalog.newSkill.keywords": "触发关键词",
        "settings.freezoneCatalog.newSkill.keywordsPlaceholder": "输入关键词",
        "settings.freezoneCatalog.newSkill.keywordsHint": "支持权重",
        "settings.freezoneCatalog.newSkill.nodeScopes": "节点类型",
        "settings.freezoneCatalog.newSkill.nodeScopesPlaceholder": "textGeneration / imageGeneration / videoGeneration / audioGeneration",
        "settings.freezoneCatalog.newSkill.workflow2Title": "工作流设置",
        "settings.freezoneCatalog.newSkill.workflow2Description": "工作流字段",
        "settings.freezoneCatalog.newSkill.schemaVersion": "Schema 版本",
        "settings.freezoneCatalog.newSkill.version": "版本",
        "settings.freezoneCatalog.newSkill.allowedRecipeIds": "关联 Recipes",
        "settings.freezoneCatalog.newSkill.allowedRecipeIdsPlaceholder": "输入 Recipe ID",
        "settings.freezoneCatalog.newSkill.allowedRecipeIdsHint": "动态规划时使用",
        "settings.freezoneCatalog.newSkill.inputParameters": "开始前选项",
        "settings.freezoneCatalog.newSkill.inputParametersEmpty": "没有选项",
        "settings.freezoneCatalog.newSkill.inputParameterRequired": "必填",
        "settings.freezoneCatalog.newSkill.inputParameterDefault": "默认",
        "settings.freezoneCatalog.newSkill.inputParameterOptions": `${options?.count ?? 0} 个选项`,
        "settings.freezoneCatalog.newSkill.inputParameterOptionList": "选项列表",
        "settings.freezoneCatalog.newSkill.addInputParameter": "新增选项",
        "settings.freezoneCatalog.newSkill.deleteInputParameter": "删除选项",
        "settings.freezoneCatalog.newSkill.inputParameterId": "参数 ID",
        "settings.freezoneCatalog.newSkill.inputParameterIdPlaceholder": "如 total_duration",
        "settings.freezoneCatalog.newSkill.inputParameterLabel": "显示名称",
        "settings.freezoneCatalog.newSkill.inputParameterLabelPlaceholder": "如 目标时长",
        "settings.freezoneCatalog.newSkill.inputParameterType": "类型",
        "settings.freezoneCatalog.newSkill.inputParameterDefaultPlaceholder": "如 15s",
        "settings.freezoneCatalog.newSkill.inputParameterOptionsPlaceholder": "一行一个选项",
        "settings.freezoneCatalog.newSkill.inputParameterTypes.single_select": "单选",
        "settings.freezoneCatalog.newSkill.inputParameterTypes.multi_select": "多选",
        "settings.freezoneCatalog.newSkill.inputParameterTypes.text": "文本",
        "settings.freezoneCatalog.newSkill.inputParameterTypes.number": "数字",
        "settings.freezoneCatalog.newSkill.inputParameterTypes.boolean": "开关",
        "settings.freezoneCatalog.newSkill.inputParametersPlaceholder": "[]",
        "settings.freezoneCatalog.newSkill.planningTitle": "规则配置",
        "settings.freezoneCatalog.newSkill.planningDescription": "规则策略",
        "settings.freezoneCatalog.newSkill.planningNotes": "规划器提示词",
        "settings.freezoneCatalog.newSkill.planningNotesPlaceholder": "规划提示...",
        "settings.freezoneCatalog.newSkill.promptGuide": "提示词风格",
        "settings.freezoneCatalog.newSkill.promptGuidePlaceholder": "风格指引...",
        "settings.freezoneCatalog.newSkill.conductRules": "行为规则",
        "settings.freezoneCatalog.newSkill.conductRulesPlaceholder": "行为规则...",
        "settings.freezoneCatalog.newSkill.aspectPresets": "默认画幅",
        "settings.freezoneCatalog.newSkill.modelNamePlaceholder": "任务类型",
        "settings.freezoneCatalog.newSkill.ratioPlaceholder": "比例",
        "settings.freezoneCatalog.newSkill.ratioLabel": "比例",
        "settings.freezoneCatalog.newSkill.ratioSelectPlaceholder": "选择比例",
        "settings.freezoneCatalog.newSkill.modelHints": "模型偏好",
        "settings.freezoneCatalog.newSkill.taskTypeLabel": "任务类型",
        "settings.freezoneCatalog.newSkill.taskTypePlaceholder": "选择类型",
        "settings.freezoneCatalog.newSkill.modelSelectLabel": "模型名称",
        "settings.freezoneCatalog.newSkill.modelSelectPlaceholder": "选择模型",
        "settings.freezoneCatalog.newSkill.modelLoading": "模型加载中…",
        "settings.freezoneCatalog.newSkill.evaluationTitle": "评估规则",
        "settings.freezoneCatalog.newSkill.evaluationDescription": "评分标准",
        "settings.freezoneCatalog.newSkill.qualityThreshold": "通过分数",
        "settings.freezoneCatalog.newSkill.qualityThresholdPlaceholder": "如：7",
        "settings.freezoneCatalog.newSkill.domainConstraints": "领域规则",
        "settings.freezoneCatalog.newSkill.domainConstraintsPlaceholder": "输入规则",
        "settings.freezoneCatalog.newSkill.ratingBands": "评分锚点",
        "settings.freezoneCatalog.newSkill.visualReviewItems": "视觉评估维度",
        "settings.freezoneCatalog.newSkill.textReviewItems": "文本评估维度",
        "settings.freezoneCatalog.newSkill.add": "添加",
        "settings.freezoneCatalog.newSkill.addRatingBand": "添加锚点",
        "settings.freezoneCatalog.newSkill.addDimension": "添加维度",
        "settings.freezoneCatalog.newSkill.dimensionNamePlaceholder": "维度名称",
        "settings.freezoneCatalog.newSkill.dimensionDescriptionPlaceholder": "维度描述",
        "settings.freezoneCatalog.newSkill.dimensionWeight": "权重",
        "settings.freezoneCatalog.newSkill.dimensionWeightPlaceholder": "1",
        "settings.freezoneCatalog.newSkill.dimensionWeightHint": "所有权重之和建议为 1.0",
        "settings.freezoneCatalog.newSkill.removeDimension": "删除评估维度",
        "settings.freezoneCatalog.newSkill.ratingBandScorePlaceholder": "0",
        "settings.freezoneCatalog.newSkill.ratingBandDescriptionPlaceholder": "该分数段的描述",
        "settings.freezoneCatalog.newSkill.removeRatingBand": "删除评分锚点",
        "settings.freezoneCatalog.newSkill.rawJson": "查看 / 编辑原始 JSON（高级）",
        "settings.freezoneCatalog.newSkill.collapseRawJson": "收起原始 JSON",
        "settings.freezoneCatalog.newSkill.rawJsonAria": "原始 JSON",
        "settings.freezoneCatalog.newSkill.rawJsonSyncHint": "直接编辑 JSON 会同步到上方表单字段",
        "settings.freezoneCatalog.newSkill.copyRawJson": "复制 JSON",
        "settings.freezoneCatalog.newSkill.rawJsonCopied": "Skill JSON 已复制",
        "settings.freezoneCatalog.newSkill.rawJsonCopyFailed": "复制失败，请手动复制",
        "settings.freezoneCatalog.newRecipe.title": "新增 Recipe",
        "settings.freezoneCatalog.newRecipe.close": "关闭新增 Recipe",
        "settings.freezoneCatalog.newRecipe.cancel": "取消",
        "settings.freezoneCatalog.newRecipe.save": "保存",
        "settings.freezoneCatalog.newRecipe.id": "ID",
        "settings.freezoneCatalog.newRecipe.idHint": "仅允许 a-z、0-9、-、_ 字符",
        "settings.freezoneCatalog.newRecipe.name": "名称",
        "settings.freezoneCatalog.newRecipe.namePlaceholder": "如：电商广告图增强",
        "settings.freezoneCatalog.newRecipe.outputKind": "生成类型",
        "settings.freezoneCatalog.newRecipe.outputKinds.image": "图片",
        "settings.freezoneCatalog.newRecipe.outputKinds.video": "视频",
        "settings.freezoneCatalog.newRecipe.outputKinds.audio": "音频",
        "settings.freezoneCatalog.newRecipe.outputKinds.text": "文本",
        "settings.freezoneCatalog.newRecipe.actionKeys": "操作标识",
        "settings.freezoneCatalog.newRecipe.actionKeysPlaceholder": "输入后按 Enter 或逗号确认",
        "settings.freezoneCatalog.newRecipe.actionKeysHint": "Agent 规划时用于匹配此 Recipe 的操作类型标识符",
        "settings.freezoneCatalog.newRecipe.system_prompt": "System Prompt",
        "settings.freezoneCatalog.newRecipe.system_promptPlaceholder": "用于增强生成提示词的系统指令...",
        "settings.freezoneCatalog.newRecipe.mustHaveItems": "必需元素",
        "settings.freezoneCatalog.newRecipe.mustHaveItemsPlaceholder": "输入后按 Enter 或逗号确认",
        "settings.freezoneCatalog.newRecipe.mustHaveItemsHint": "生成结果必须包含的关键要素",
        "settings.freezoneCatalog.newRecipe.planningPrompt": "规划器提示词",
        "settings.freezoneCatalog.newRecipe.planningPromptPlaceholder": "给规划器的简短提示（~30字）",
        "settings.freezoneCatalog.newRecipe.resultSummary": "输出概述",
        "settings.freezoneCatalog.newRecipe.resultSummaryPlaceholder": "产出特征描述（~50字）",
        "settings.freezoneCatalog.newRecipe.sourceMediaRequired": "需要上游素材输入",
        "settings.freezoneCatalog.newRecipe.sourceMediaRequiredHint": "启用后此 Recipe 需要图片/视频等输入",
        "settings.freezoneCatalog.newRecipe.forceEnhancement": "跳过详细度检查",
        "settings.freezoneCatalog.newRecipe.forceEnhancementHint": "强制进入增强流程，忽略“已足够详细”判断",
        "settings.freezoneCatalog.newRecipe.rawJson": "查看 / 编辑原始 JSON（高级）",
        "settings.freezoneCatalog.newRecipe.collapseRawJson": "收起原始 JSON",
        "settings.freezoneCatalog.newRecipe.rawJsonAria": "Recipe 原始 JSON",
        "settings.freezoneCatalog.newRecipe.rawJsonSyncHint": "当前 JSON 根据上方表单字段自动生成",
        "settings.freezoneCatalog.newRecipe.copyRawJson": "复制 JSON",
        "settings.freezoneCatalog.newRecipe.rawJsonCopied": "Recipe JSON 已复制",
        "settings.freezoneCatalog.newRecipe.rawJsonCopyFailed": "复制失败，请手动复制",
      })[key] ?? options?.defaultValue ?? key,
  }),
}));

function renderSettingsDialog() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SettingsDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

function openRecipesManagement() {
  fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
  fireEvent.click(screen.getByRole("button", { name: "高级管理" }));
}

beforeEach(() => {
  runtimeState.isCeRuntime = true;
  modelGatewayMocks.config = undefined;
  modelGatewayMocks.saveBrainClaw.mockReset();
  modelGatewayMocks.setCustomLlmMode.mockReset();
  modelGatewayMocks.setCustomLlmMode.mockResolvedValue({ ok: true });
  freezoneAgentConfigMocks.delete.mockReset();
  freezoneAgentConfigMocks.exportBundle.mockReset();
  freezoneAgentConfigMocks.installBundle.mockReset();
  freezoneAgentConfigMocks.items = [];
  freezoneAgentConfigMocks.itemsByKind = {};
  freezoneAgentConfigMocks.refetch.mockReset();
  freezoneAgentConfigMocks.save.mockReset();
  freezoneAgentConfigMocks.exportBundle.mockImplementation(
    async ({ bundle }: { bundle: Record<string, unknown> }) => bundle,
  );
  freezoneAgentConfigMocks.installBundle.mockResolvedValue({
    bundle_id: "test-bundle",
    installed_skill: "test-skill",
    installed_recipes: [],
  });
});

describe("SettingsDialog pages", () => {
  it("opens on the model settings page", () => {
    renderSettingsDialog();

    expect(screen.getByRole("button", { name: /模型配置/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("选择模型网关渠道")).toBeInTheDocument();
  });

  it("lets BrainClaw use an editable NewAPI endpoint in custom mode", async () => {
    modelGatewayMocks.config = {
      mode: "custom",
      effective: {
        source: "custom",
        baseUrl: "http://local-newapi:3000/v1",
        apiKeyPreview: "sk-c...cret",
        configured: true,
      },
      llmEffective: {
        mode: "relayclaw_brainclaw",
        source: "official",
        baseUrl: "https://relayclaw.cdnfg.com/v1",
        apiKeyPreview: "sk-r...cret",
        configured: true,
        model: "brainclaw",
        brainclaw: true,
      },
      official: {
        source: "database",
        baseUrl: "https://relayclaw.cdnfg.com/v1",
        apiKeyPreview: "sk-r...cret",
        configured: true,
        environment: {
          baseUrl: "https://relayclaw.cdnfg.com/v1",
          apiKeyPreview: "",
          configured: false,
        },
      },
      brainclaw: {
        baseUrl: "https://relayclaw.cdnfg.com/v1",
        apiKeyPreview: "sk-r...cret",
        configured: true,
      },
      custom: {
        llmMode: "relayclaw_brainclaw",
        baseUrl: "http://local-newapi:3000/v1",
        apiKeyPreview: "sk-c...cret",
        configured: true,
        adminBaseUrl: "http://local-newapi:3000",
        tokenName: "dramaclaw",
        tokenId: "1",
      },
    };

    renderSettingsDialog();

    expect(screen.getByRole("tab", { name: "虾驿 BrainClaw（推荐）" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "高级自定义" })).toBeInTheDocument();
    expect(screen.getByText("虾脑 BrainClaw（推荐）")).toBeInTheDocument();
    const endpoint = screen.getByDisplayValue("https://relayclaw.cdnfg.com/v1");
    expect(endpoint).not.toHaveAttribute("readonly");
    expect(screen.getByText("brainclaw")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存并启用 BrainClaw" })).toBeEnabled();
    expect(screen.getByText("Embedding 模型")).toBeInTheDocument();
    expect(screen.getByText("媒体模型")).toBeInTheDocument();
    expect(screen.queryByText("业务模型映射")).not.toBeInTheDocument();

    modelGatewayMocks.saveBrainClaw.mockResolvedValue({ ok: true, data: modelGatewayMocks.config });
    fireEvent.change(endpoint, { target: { value: "http://127.0.0.1:8317" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并启用 BrainClaw" }));
    await waitFor(() => {
      expect(modelGatewayMocks.saveBrainClaw).toHaveBeenCalledWith({
        newApiBaseUrl: "http://127.0.0.1:8317",
      });
    });

    fireEvent.click(screen.getByRole("tab", { name: "高级自定义" }));

    expect(modelGatewayMocks.setCustomLlmMode).toHaveBeenCalledWith("advanced");
    expect(screen.getByText("业务模型映射")).toBeInTheDocument();
    expect(screen.getByText("Embedding 模型")).toBeInTheDocument();
    expect(screen.getByText("媒体模型")).toBeInTheDocument();
  });

  it("limits EE settings to Freezone Skills with Recipes under advanced management", () => {
    runtimeState.isCeRuntime = false;

    renderSettingsDialog();

    expect(screen.queryByRole("button", { name: /模型配置/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /媒体存储/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "虾画 Skills" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("暂无虾画 Skills")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "虾画 Recipes" })).not.toBeInTheDocument();

    openRecipesManagement();

    expect(screen.getByText("暂无虾画 Recipes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回 Skills" })).toBeInTheDocument();
  });

  it("opens Recipes from the Skills advanced management entry", () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));

    expect(screen.getByText("暂无虾画 Skills")).toBeInTheDocument();
    expect(screen.getByText("导入 Skill")).toBeInTheDocument();
    expect(screen.queryByText("freezone_demo")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "虾画 Recipes" })).not.toBeInTheDocument();

    openRecipesManagement();

    expect(screen.getByText("暂无虾画 Recipes")).toBeInTheDocument();
  });

  it("opens a JSON file picker from the Freezone import button", () => {
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "导入 Skill" }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("导入 Skill")).toHaveAttribute("type", "file");
    expect(screen.getByLabelText("导入 Skill")).toHaveAttribute("accept", ".json,application/json");

    clickSpy.mockRestore();
  });

  it("opens the new Skill editor shell without saving data", () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "新增" }));

    expect(screen.getByText("新增 Skill")).toBeInTheDocument();
    expect(screen.getByText("暂无虾画 Skills")).toBeInTheDocument();
    expect(screen.getByText("触发条件")).toBeInTheDocument();
    expect(screen.getByText("规则配置")).toBeInTheDocument();
    expect(screen.getByText("评估规则")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.getByText("暂无虾画 Skills")).toBeInTheDocument();
    expect(screen.queryByText("新增 Skill")).not.toBeInTheDocument();
  });

  it("opens the new Recipe editor shell from advanced management", () => {
    renderSettingsDialog();

    openRecipesManagement();
    fireEvent.click(screen.getByRole("button", { name: "新增" }));

    expect(screen.getByText("新增 Recipe")).toBeInTheDocument();
    expect(screen.getByText("暂无虾画 Recipes")).toBeInTheDocument();
    expect(screen.getByText("生成类型")).toBeInTheDocument();
    expect(screen.getAllByText("操作标识")).toHaveLength(1);
    expect(screen.getAllByText("System Prompt")).toHaveLength(1);
    expect(screen.getAllByText("必需元素")).toHaveLength(1);
    expect(screen.getByText("需要上游素材输入")).toBeInTheDocument();
    expect(screen.queryByText("跳过详细度检查")).not.toBeInTheDocument();
  });

  it("shows raw JSON that maps to the current new Recipe form fields", () => {
    renderSettingsDialog();

    openRecipesManagement();
    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    fireEvent.change(screen.getByPlaceholderText("my-recipe"), {
      target: { value: "digital-product-text-plan" },
    });
    fireEvent.change(screen.getByPlaceholderText("如：电商广告图增强"), {
      target: { value: "数码智能产品详情页策划文案" },
    });

    const [operationInput, mustHaveItemsInput] =
      screen.getAllByPlaceholderText("输入后按 Enter 或逗号确认");
    fireEvent.change(operationInput, {
      target: { value: "digital-product-text-plan" },
    });
    fireEvent.keyDown(operationInput, { key: "Enter", code: "Enter" });

    fireEvent.change(screen.getByPlaceholderText("用于增强生成提示词的系统指令..."), {
      target: { value: "系统提示" },
    });

    fireEvent.change(mustHaveItemsInput, { target: { value: "【产品定位】" } });
    fireEvent.keyDown(mustHaveItemsInput, { key: "Enter", code: "Enter" });

    fireEvent.change(screen.getByPlaceholderText("给规划器的简短提示（~30字）"), {
      target: { value: "规划提示" },
    });
    fireEvent.change(screen.getByPlaceholderText("产出特征描述（~50字）"), {
      target: { value: "输出描述" },
    });
    fireEvent.click(screen.getByLabelText("需要上游素材输入"));

    fireEvent.click(screen.getByRole("button", { name: "查看 / 编辑原始 JSON（高级）" }));

    const rawJson = JSON.parse(screen.getByLabelText("Recipe 原始 JSON").textContent ?? "{}");
    expect(rawJson).toMatchObject({
      id: "digital-product-text-plan",
      name: "数码智能产品详情页策划文案",
      output_kind: "image",
      action_keys: ["digital-product-text-plan"],
      system_prompt: "系统提示",
      must_have_items: ["【产品定位】"],
      planning_prompt: "规划提示",
      result_summary: "输出描述",
      requires_source_media: true,
    });
    expect(rawJson).not.toHaveProperty("force_enhancement");
    expect(rawJson).not.toHaveProperty("skip_detail_check");
  });

  it("preserves legacy Recipe enhancement flags while keeping them out of the form", () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "legacy-recipe",
        name: "旧版 Recipe",
        enabled: true,
        output_kind: "image",
        action_keys: ["legacy-action"],
        system_prompt: "旧版系统提示",
        planning_prompt: "旧版规划提示",
        result_summary: "旧版输出说明",
        requires_source_media: false,
        force_enhancement: true,
        skip_detail_check: true,
      },
    ];
    renderSettingsDialog();

    openRecipesManagement();
    fireEvent.click(screen.getByRole("button", { name: "编辑 旧版 Recipe" }));

    expect(screen.queryByText("跳过详细度检查")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看 / 编辑原始 JSON（高级）" }));
    const rawJson = JSON.parse(screen.getByLabelText("Recipe 原始 JSON").textContent ?? "{}");
    expect(rawJson.force_enhancement).toBe(true);
    expect(rawJson.skip_detail_check).toBe(true);
  });

  it("copies the generated Recipe raw JSON from the raw JSON header", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderSettingsDialog();

    openRecipesManagement();
    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    fireEvent.change(screen.getByPlaceholderText("my-recipe"), {
      target: { value: "copyable-recipe" },
    });
    fireEvent.change(screen.getByPlaceholderText("如：电商广告图增强"), {
      target: { value: "可复制 Recipe" },
    });
    fireEvent.change(screen.getByPlaceholderText("用于增强生成提示词的系统指令..."), {
      target: { value: "复制用系统提示" },
    });

    fireEvent.click(screen.getByRole("button", { name: "查看 / 编辑原始 JSON（高级）" }));
    const rawJsonText = screen.getByLabelText("Recipe 原始 JSON").textContent ?? "";

    fireEvent.click(screen.getByRole("button", { name: "复制 JSON" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(rawJsonText));
    expect(toast.success).toHaveBeenCalledWith("Recipe JSON 已复制");
  });

  it("does not save a Freezone Recipe until all required fields are present", () => {
    renderSettingsDialog();

    openRecipesManagement();
    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    fireEvent.change(screen.getByPlaceholderText("my-recipe"), {
      target: { value: "story-recipe" },
    });
    fireEvent.change(screen.getByPlaceholderText("如：电商广告图增强"), {
      target: { value: "故事 Recipe" },
    });

    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

    const [actionKeysInput] = screen.getAllByPlaceholderText("输入后按 Enter 或逗号确认");
    fireEvent.change(actionKeysInput, {
      target: { value: "story-action" },
    });
    fireEvent.keyDown(actionKeysInput, { key: "Enter", code: "Enter" });
    fireEvent.change(screen.getByPlaceholderText("用于增强生成提示词的系统指令..."), {
      target: { value: "系统提示" },
    });

    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("给规划器的简短提示（~30字）"), {
      target: { value: "规划提示" },
    });
    fireEvent.change(screen.getByPlaceholderText("产出特征描述（~50字）"), {
      target: { value: "输出概述" },
    });

    expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled();
  });

  it("adds and removes rating band rows in the new Skill editor", () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "新增" }));

    expect(screen.queryByPlaceholderText("该分数段的描述")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加锚点" }));

    const scoreInput = screen.getByPlaceholderText("0");
    expect(scoreInput).toBeInTheDocument();
    expect(scoreInput).toHaveAttribute("min", "0");
    expect(scoreInput).toHaveAttribute("max", "10");
    expect(scoreInput).toHaveAttribute("step", "0.5");
    expect(screen.getByPlaceholderText("该分数段的描述")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除评分锚点" }));

    expect(screen.queryByPlaceholderText("该分数段的描述")).not.toBeInTheDocument();
  });

  it("adds and removes visual and text dimension rows in the new Skill editor", () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "新增" }));

    expect(screen.queryByPlaceholderText("维度名称")).not.toBeInTheDocument();

    const addDimensionButtons = screen.getAllByRole("button", { name: "添加维度" });
    fireEvent.click(addDimensionButtons[0]);
    fireEvent.click(addDimensionButtons[1]);

    expect(screen.getAllByPlaceholderText("维度名称")).toHaveLength(2);
    const weightInputs = screen.getAllByPlaceholderText("1");
    expect(weightInputs).toHaveLength(2);
    for (const weightInput of weightInputs) {
      expect(weightInput).toHaveAttribute("min", "0");
      expect(weightInput).toHaveAttribute("max", "1");
      expect(weightInput).toHaveAttribute("step", "0.1");
    }
    expect(screen.getAllByPlaceholderText("维度描述")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "删除评估维度" })[0]);

    expect(screen.getAllByPlaceholderText("维度名称")).toHaveLength(1);
  });

  it("shows raw JSON that maps to the current new Skill form fields", () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    fireEvent.change(screen.getByPlaceholderText("my-skill"), { target: { value: "id" } });
    fireEvent.change(screen.getByPlaceholderText("general"), {
      target: { value: "category" },
    });
    fireEvent.change(screen.getByPlaceholderText("适用场景描述"), {
      target: { value: "des" },
    });
    const keywordInput = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(keywordInput, {
      target: { value: "关键词" },
    });
    fireEvent.keyDown(keywordInput, {
      key: "Enter",
      code: "Enter",
    });
    fireEvent.change(keywordInput, {
      target: { value: "关键词2" },
    });
    fireEvent.keyDown(keywordInput, {
      key: "Enter",
      code: "Enter",
    });
    fireEvent.keyDown(keywordInput, {
      key: "Backspace",
      code: "Backspace",
    });
    expect(
      screen.queryByPlaceholderText(
        "textGeneration / imageGeneration / videoGeneration / audioGeneration",
      ),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "图片生成 imageGeneration" }));
    fireEvent.change(screen.getByPlaceholderText("规划提示..."), {
      target: { value: "planhints" },
    });
    fireEvent.change(screen.getByPlaceholderText("风格指引..."), {
      target: { value: "sytleguide" },
    });
    const behaviorRulesInput = screen.getByPlaceholderText("行为规则...");
    fireEvent.change(behaviorRulesInput, {
      target: { value: "behaviorrules" },
    });
    fireEvent.keyDown(behaviorRulesInput, {
      key: "Enter",
      code: "Enter",
    });
    expect(screen.queryByText("默认画幅")).not.toBeInTheDocument();
    expect(screen.queryByText("模型偏好")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("如：7"), { target: { value: "7" } });
    fireEvent.change(screen.getByPlaceholderText("输入规则"), {
      target: { value: "domainrules" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加锚点" }));

    expect(screen.getByRole("button", { name: "删除 关键词" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除 关键词2" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除 imageGeneration" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑 关键词" }));
    const keywordEditInput = screen.getByRole("textbox", { name: "编辑 关键词" });
    expect(keywordEditInput).toHaveValue("关键词");
    expect(screen.queryByRole("button", { name: "编辑 关键词" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除 关键词" })).toBeInTheDocument();
    fireEvent.change(keywordEditInput, {
      target: { value: "关键词编辑" },
    });
    fireEvent.keyDown(keywordEditInput, {
      key: "Enter",
      code: "Enter",
    });
    expect(screen.getByRole("button", { name: "删除 关键词编辑" })).toBeInTheDocument();

    const addDimensionButtons = screen.getAllByRole("button", { name: "添加维度" });
    fireEvent.click(addDimensionButtons[0]);
    fireEvent.click(addDimensionButtons[1]);

    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "10" } });
    fireEvent.change(screen.getByPlaceholderText("该分数段的描述"), {
      target: { value: "分数段描述" },
    });

    const weightInputs = screen.getAllByPlaceholderText("1");
    fireEvent.change(weightInputs[0], { target: { value: "0.1" } });
    fireEvent.change(weightInputs[1], { target: { value: "0.9" } });

    fireEvent.click(screen.getByRole("button", { name: "查看 / 编辑原始 JSON（高级）" }));

    expect(screen.getByRole("button", { name: "收起原始 JSON" })).toBeInTheDocument();
    const rawJson = JSON.parse(screen.getByLabelText("原始 JSON").textContent ?? "{}");

    expect(rawJson).toMatchObject({
      id: "id",
      description: "des",
      category: "category",
      triggers: {
        keywords: ["关键词编辑"],
        node_scopes: ["imageGeneration"],
      },
      planning: {
        planning_notes: "planhints",
        prompt_guide: "sytleguide",
        conduct_rules: ["behaviorrules"],
      },
      evaluation: {
        rating_bands: [
          {
            score: 10,
            description: "分数段描述",
          },
        ],
        visual_review_items: [
          {
            name: "",
            weight: 0.1,
            description: "",
          },
        ],
        text_review_items: [
          {
            name: "",
            weight: 0.9,
            description: "",
          },
        ],
        quality_threshold: 7,
        domain_constraints: ["domainrules"],
      },
    });
    expect(rawJson.planning.default_aspect_ratios).toBeUndefined();
    expect(rawJson.planning.model_preferences).toBeUndefined();
  });

  it("copies the generated Skill raw JSON from the raw JSON header", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    fireEvent.change(screen.getByPlaceholderText("my-skill"), {
      target: { value: "copyable-skill" },
    });
    fireEvent.change(screen.getByPlaceholderText("general"), {
      target: { value: "poster" },
    });
    fireEvent.change(screen.getByPlaceholderText("适用场景描述"), {
      target: { value: "可复制 Skill" },
    });
    const keywordInput = screen.getByPlaceholderText("输入关键词");
    fireEvent.change(keywordInput, {
      target: { value: "海报" },
    });
    fireEvent.keyDown(keywordInput, {
      key: "Enter",
      code: "Enter",
    });

    fireEvent.click(screen.getByRole("button", { name: "查看 / 编辑原始 JSON（高级）" }));
    const rawJsonText = screen.getByLabelText("原始 JSON").textContent ?? "";

    fireEvent.click(screen.getByRole("button", { name: "复制 JSON" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(rawJsonText));
    expect(toast.success).toHaveBeenCalledWith("Skill JSON 已复制");
  });

  it("saves a new Freezone Skill through account config storage", async () => {
    freezoneAgentConfigMocks.save.mockResolvedValue({
      id: "story-skill",
      description: "故事规则",
      category: "general",
    });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    fireEvent.change(screen.getByPlaceholderText("my-skill"), {
      target: { value: "story-skill" },
    });
    fireEvent.change(screen.getByPlaceholderText("适用场景描述"), {
      target: { value: "故事规则" },
    });
    fireEvent.change(screen.getByPlaceholderText("输入关键词"), {
      target: { value: "故事" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("输入关键词"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "添加 Recipe" }));
    fireEvent.change(screen.getByPlaceholderText("输入 Recipe ID"), {
      target: { value: "story-recipe" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("输入 Recipe ID"), { key: "Enter" });
    fireEvent.change(screen.getByPlaceholderText("规划提示..."), {
      target: { value: "根据故事需求动态规划。" },
    });
    fireEvent.change(screen.getByPlaceholderText("行为规则..."), {
      target: { value: "保持故事一致性" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("行为规则..."), { key: "Enter" });
    fireEvent.change(screen.getByPlaceholderText("如：7"), { target: { value: "7" } });
    fireEvent.change(screen.getByPlaceholderText("输入规则"), {
      target: { value: "不得偏离故事主题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加锚点" }));
    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "5" } });
    fireEvent.change(screen.getByPlaceholderText("该分数段的描述"), {
      target: { value: "故事完整" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.save).toHaveBeenCalledWith({
        kind: "skills",
        payload: expect.objectContaining({
          id: "story-skill",
          description: "故事规则",
          category: "general",
          allowed_recipe_ids: ["story-recipe"],
        }),
      });
    });
  });

  it("does not render Freezone Skill catalog tags in the list", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "social-media",
        enabled: true,
        category: "social",
        description: "社交媒体内容素材制作",
        triggers: { keywords: ["instagram", "tiktok"] },
      },
    ];
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));

    expect(screen.getByText("social-media")).toBeInTheDocument();
    expect(screen.getByText("社交媒体内容素材制作")).toBeInTheDocument();
    expect(screen.queryByText("instagram")).not.toBeInTheDocument();
    expect(screen.queryByText("tiktok")).not.toBeInTheDocument();
    expect(screen.queryByText("social")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索 Skill"), {
      target: { value: "instagram" },
    });

    expect(screen.getByText("social-media")).toBeInTheDocument();
  });

  it("renders Freezone Recipe generation type labels in the list", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "public-welfare-poster-9-16",
        name: "公益宣传海报生成",
        enabled: true,
        output_kind: "image",
        action_keys: ["public-welfare-poster-9-16"],
        result_summary: "9:16 竖版公益宣传海报",
      },
      {
        id: "public-welfare-copy",
        name: "公益宣传文案",
        _catalog_source: "user",
        _catalog_base_source: "builtin",
        enabled: true,
        output_kind: "text",
        action_keys: ["public-welfare-copy"],
        result_summary: "温暖感人的公益宣传文案",
      },
    ];
    renderSettingsDialog();

    openRecipesManagement();

    expect(screen.getByText("公益宣传海报生成").closest("article")).toHaveTextContent("图片");
    expect(screen.getByText("公益宣传文案").closest("article")).toHaveTextContent("文本");
    expect(screen.getByText("公益宣传文案").closest("article")).toHaveTextContent("定制");
    expect(screen.queryByText("已定制")).not.toBeInTheDocument();
    expect(screen.queryByText("image")).not.toBeInTheDocument();
    expect(screen.queryByText("text")).not.toBeInTheDocument();
  });

  it("marks built-in Freezone catalog items in the list", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "builtin-skill",
        _catalog_source: "builtin",
        enabled: true,
        category: "general",
        description: "内置规则",
        triggers: { keywords: ["builtin"] },
      },
      {
        id: "user-skill",
        enabled: true,
        category: "general",
        description: "用户规则",
        triggers: { keywords: ["user"] },
      },
    ];
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));

    expect(screen.getByText("builtin-skill")).toBeInTheDocument();
    expect(screen.getByText("user-skill")).toBeInTheDocument();
    expect(screen.getByText("内置")).toBeInTheDocument();
    expect(screen.getByText("builtin-skill").closest("article")).toHaveTextContent("内置");
    expect(screen.getByText("user-skill").closest("article")).not.toHaveTextContent("内置");
  });

  it("marks customized built-in items and toggles pure built-ins with the full payload", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "builtin-skill",
        schema_version: "dramaclaw.workflow-skill.v1",
        name: "内置 Skill",
        version: "1.0.0",
        _catalog_source: "builtin",
        enabled: true,
        category: "general",
        description: "内置规则",
        triggers: { keywords: ["builtin"] },
        allowed_recipe_ids: ["builtin-recipe"],
        input_parameters: [
          {
            id: "aspect_ratio",
            label: "画幅",
            type: "single_select",
            required: true,
            default: "16:9",
            options: ["16:9", "1:1"],
          },
        ],
        planning: {
          planning_notes: "根据用户目标动态规划。",
          conduct_rules: ["保持主体一致。"],
        },
        evaluation: {
          rating_bands: [{ score: 5, description: "结果清晰" }],
          quality_threshold: 4,
          domain_constraints: ["不得改变主体。"],
        },
      },
      {
        id: "customized-skill",
        _catalog_source: "user",
        _catalog_base_source: "builtin",
        enabled: true,
        category: "general",
        description: "用户定制规则",
        triggers: { keywords: ["customized"] },
      },
    ];
    freezoneAgentConfigMocks.save.mockResolvedValue({});
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));

    expect(screen.getByText("内置 Skill").closest("article")).toHaveTextContent("内置");
    expect(screen.getByText("customized-skill").closest("article")).toHaveTextContent("定制");
    expect(screen.queryByText("已定制")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "切换 内置 Skill 启用状态" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.save).toHaveBeenCalledWith({
        kind: "skills",
        payload: {
          id: "builtin-skill",
          schema_version: "dramaclaw.workflow-skill.v1",
          name: "内置 Skill",
          version: "1.0.0",
          enabled: false,
          category: "general",
          description: "内置规则",
          triggers: { keywords: ["builtin"] },
          allowed_recipe_ids: ["builtin-recipe"],
          input_parameters: [
            {
              id: "aspect_ratio",
              label: "画幅",
              type: "single_select",
              required: true,
              default: "16:9",
              options: ["16:9", "1:1"],
            },
          ],
          planning: {
            planning_notes: "根据用户目标动态规划。",
            conduct_rules: ["保持主体一致。"],
          },
          evaluation: {
            rating_bands: [{ score: 5, description: "结果清晰" }],
            quality_threshold: 4,
            domain_constraints: ["不得改变主体。"],
          },
        },
      });
    });
  });

  it("does not save a Freezone Skill until all required fields are present", async () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    fireEvent.change(screen.getByPlaceholderText("my-skill"), {
      target: { value: "story-skill" },
    });
    fireEvent.change(screen.getByPlaceholderText("适用场景描述"), {
      target: { value: "故事规则" },
    });

    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(freezoneAgentConfigMocks.save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("输入关键词"), {
      target: { value: "故事" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("输入关键词"), { key: "Enter" });

    expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled();
  });

  it("rejects imported Freezone Recipes that miss required fields", async () => {
    renderSettingsDialog();

    openRecipesManagement();
    const importInput = screen.getByLabelText("导入");
    const file = new File(
      [
        JSON.stringify({
          id: "recipe-without-system-prompt",
          name: "缺字段 Recipe",
          output_kind: "image",
          action_keys: ["missing-prompt"],
        }),
      ],
      "recipe.json",
      { type: "application/json" },
    );
    fireEvent.change(importInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.save).not.toHaveBeenCalled();
    });
  });

  it("rejects imported Freezone Skills that miss required schema fields", async () => {
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    const importInput = screen.getByLabelText("导入");
    const file = new File(
      [
        JSON.stringify({
          id: "loose-skill",
          name: "半截 Skill",
          enabled: true,
          allowed_recipe_ids: ["loose-recipe"],
          category: "video",
          description: "缺少规划和评估字段",
          triggers: { keywords: ["半截"] },
        }),
      ],
      "skill.json",
      { type: "application/json" },
    );
    fireEvent.change(importInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.save).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("planning.planning_notes"));
    });
  });

  it("exports selected Freezone config items as JSON", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "story-skill",
        description: "故事规则",
        category: "general",
      },
      {
        id: "visual-skill",
        description: "视觉规则",
        category: "image",
      },
    ];
    const createObjectURL = vi.fn((payload: Blob | MediaSource) => {
      void payload;
      return "blob:freezone-config";
    });
    const revokeObjectURL = vi.fn();
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });

    try {
      renderSettingsDialog();

      fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
      fireEvent.click(screen.getAllByRole("checkbox")[1]);
      fireEvent.click(screen.getByRole("button", { name: "导出 Skill" }));

      await waitFor(() => {
        expect(anchorClick).toHaveBeenCalledTimes(1);
      });
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:freezone-config");
      const exportedBlob = createObjectURL.mock.calls[0]?.[0];
      if (!(exportedBlob instanceof Blob)) {
        throw new Error("expected Freezone export to create a Blob");
      }
      const exportedText = await exportedBlob.text();
      expect(exportedText).toContain('"id": "story-skill"');
      expect(exportedText).not.toContain('"id": "visual-skill"');
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectURL,
      });
      anchorClick.mockRestore();
    }
  });

  it("selects all visible items and deletes them in bulk", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "story-skill",
        description: "故事规则",
        category: "general",
      },
      {
        id: "visual-skill",
        description: "视觉规则",
        category: "image",
      },
    ];
    freezoneAgentConfigMocks.delete.mockResolvedValue({ deleted: true });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: "删除选中" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.delete).toHaveBeenCalledWith({
        kind: "skills",
        id: "story-skill",
      });
      expect(freezoneAgentConfigMocks.delete).toHaveBeenCalledWith({
        kind: "skills",
        id: "visual-skill",
      });
    });
  });

  it("toggles and deletes an existing Freezone Skill", async () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "story-skill",
        description: "故事规则",
        category: "general",
        enabled: true,
        triggers: { keywords: ["故事"] },
      },
    ];
    freezoneAgentConfigMocks.save.mockResolvedValue({});
    freezoneAgentConfigMocks.delete.mockResolvedValue({ deleted: true });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getByRole("switch", { name: "切换 story-skill 启用状态" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.save).toHaveBeenCalledWith({
        kind: "skills",
        payload: expect.objectContaining({
          id: "story-skill",
          enabled: false,
        }),
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "删除 story-skill" }));
    expect(screen.getByText("删除 Skill")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "只删除 Skill" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.delete).toHaveBeenCalledWith({
        kind: "skills",
        id: "story-skill",
      });
    });
  });

  it("deletes a Skill with only its exclusive linked Recipes", async () => {
    freezoneAgentConfigMocks.itemsByKind = {
      skills: [
        {
          id: "story-skill",
          description: "故事规则",
          allowed_recipe_ids: ["recipe-a", "recipe-b"],
        },
        {
          id: "visual-skill",
          description: "视觉规则",
          allowed_recipe_ids: ["recipe-b"],
        },
      ],
      recipes: [
        { id: "recipe-a", output_kind: "text", result_summary: "A" },
        { id: "recipe-b", output_kind: "image", result_summary: "B" },
        { id: "recipe-c", output_kind: "video", result_summary: "C" },
      ],
    };
    freezoneAgentConfigMocks.delete.mockResolvedValue({ deleted: true });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 story-skill" }));

    expect(screen.getByText("recipe-a")).toBeInTheDocument();
    expect(screen.getByText("recipe-b")).toBeInTheDocument();
    expect(screen.queryByText("recipe-c")).not.toBeInTheDocument();
    expect(screen.getByText("可随 Skill 一起删除")).toBeInTheDocument();
    expect(screen.getByText("共享模块会保留")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除 Skill 和独占模块" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.delete).toHaveBeenCalledWith({
        kind: "skills",
        id: "story-skill",
      });
      expect(freezoneAgentConfigMocks.delete).toHaveBeenCalledWith({
        kind: "recipes",
        id: "recipe-a",
      });
      expect(freezoneAgentConfigMocks.delete).not.toHaveBeenCalledWith({
        kind: "recipes",
        id: "recipe-b",
      });
      expect(freezoneAgentConfigMocks.delete).not.toHaveBeenCalledWith({
        kind: "recipes",
        id: "recipe-c",
      });
    });
  });

  it("keeps the linked Recipe delete option hidden when all linked Recipes are shared", async () => {
    freezoneAgentConfigMocks.itemsByKind = {
      skills: [
        {
          id: "story-skill",
          description: "故事规则",
          allowed_recipe_ids: ["recipe-a"],
        },
        {
          id: "visual-skill",
          description: "视觉规则",
          allowed_recipe_ids: ["recipe-a"],
        },
      ],
      recipes: [
        { id: "recipe-a", output_kind: "text", result_summary: "A" },
      ],
    };
    freezoneAgentConfigMocks.delete.mockResolvedValue({ deleted: true });
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "删除 story-skill" }));

    expect(screen.getByText("recipe-a")).toBeInTheDocument();
    expect(screen.getByText("共享模块会保留")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除 Skill 和独占模块" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "只删除 Skill" }));

    await waitFor(() => {
      expect(freezoneAgentConfigMocks.delete).toHaveBeenCalledWith({
        kind: "skills",
        id: "story-skill",
      });
      expect(freezoneAgentConfigMocks.delete).not.toHaveBeenCalledWith({
        kind: "recipes",
        id: "recipe-a",
      });
    });
  });

  it("opens an existing Freezone Skill for editing", () => {
    freezoneAgentConfigMocks.items = [
      {
        id: "story-skill",
        description: "故事规则",
        category: "general",
        triggers: { keywords: ["故事"], nodeTypes: ["imageGeneration"] },
        planning: {
          default_aspect_ratios: {
            imageGeneration: "9:16",
            textGeneration: "1:1",
            videoGeneration: "auto",
          },
        },
      },
    ];
    renderSettingsDialog();

    fireEvent.click(screen.getByRole("button", { name: "虾画 Skills" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑 story-skill" }));

    expect(screen.getByText("编辑 Skill")).toBeInTheDocument();
    expect(screen.queryByText("新增 Skill")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("story-skill")).toBeInTheDocument();
    expect(screen.getByDisplayValue("故事规则")).toBeInTheDocument();
    expect(screen.getAllByText("故事").length).toBeGreaterThan(0);
    expect(screen.getByRole("checkbox", { name: "图片生成 imageGeneration" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "查看 / 编辑原始 JSON（高级）" }));
    const rawJson = JSON.parse(screen.getByLabelText("原始 JSON").textContent ?? "{}");
    expect(rawJson.planning.default_aspect_ratios).toBeUndefined();
    expect(rawJson.planning.model_preferences).toBeUndefined();
  });

});
