// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  NodeToolbar as ReactFlowNodeToolbar,
  Position,
  useReactFlow,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';

import { useCanvasStore } from '@/stores/canvasStore';
import {
  DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO,
  fetchFreezoneJobResult,
  submitFreezoneOutpaint,
  submitFreezoneScene360,
  submitFreezoneTemplateEdit,
  submitFreezoneUpscale,
  type FreezoneOutpaintAspectRatio,
  type FreezoneTemplateEditMode,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import {
  publishNodeActionAccepted,
  publishNodeActionError,
  publishNodeActionSuccess,
  subscribeNodeAction,
} from '@/features/canvas/application/nodeActionResult';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_NODE_WIDTH,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isPano360ViewerNode,
  isUploadNode,
  isVideoNode,
  NODE_TOOL_TYPES,
  type NodeToolType,
  resolveNodeSourceImageUrl,
  type CanvasNode,
  type ExportImageNodeResultKind,
} from '@/features/canvas/domain/canvasNodes';
import { isNodeStoryClip } from '@/features/canvas/story/storySelectors';
import { createUpscaleResultNode } from '@/features/canvas/application/imageUpscale';
import {
  createRotateResultNode,
  discardRotateResultNode,
} from '@/features/canvas/application/imageRotate';
import { NodeActionToolbar } from './NodeActionToolbar';
import { NodeIdBadge } from './NodeIdBadge';
import { AssetCommitHandle } from './AssetCommitHandle';
import { MultiAngleEditorOverlay } from './MultiAngleEditorOverlay';
import { RedrawOverlay } from './RedrawOverlay';
import { EraseOverlay } from './EraseOverlay';
import { Scene360Overlay } from './Scene360Overlay';
import { UpscaleEditorOverlay } from './UpscaleEditorOverlay';
import { VideoUpscaleEditorOverlay } from './VideoUpscaleEditorOverlay';
import { getFreezoneImageModelsSnapshot } from '@/features/canvas/hooks/useFreezoneImageModels';
import {
  DEFAULT_SHARED_MODEL_ID,
  DEFAULT_UPSCALE_MODEL_ID,
  SHARED_MODELS,
} from '@/features/canvas/ui/ProviderModelPicker';
import { OutpaintEditorOverlay } from './OutpaintEditorOverlay';
import { RotateEditorOverlay } from './RotateEditorOverlay';
import type { GridActionKey } from '@/features/canvas/application/gridTemplateAction';
import type { GridActionRequest } from './NodeActionToolbar';
import { spawnAssetBoardImageOpNode } from '@/features/canvas/application/assetBoardImageOps';
import { readUrl } from '@/lib/url-params';
import { inheritMainlineFields } from '../domain/inheritMainlineFields';

// Image/video nodes only need the floating action toolbar once they actually
// have a resource to act on. While the node is empty (no upload, no generated
// output), the toolbar entries (剪辑 / 高清 / 智能去字幕 / ...) are all no-ops,
// so we hide the toolbar entirely to keep the empty-state UI uncluttered.
// Other node types (text / group / audio / storyboard) keep the toolbar on
// selection because their actions don't depend on a resource.
function nodeHasResourceForToolbar(node: CanvasNode): boolean {
  // 360 全景查看器自带顶部截图工具栏，不需要这条只剩「删除」的 toolbar
  // （删除仍可用 Delete / Backspace）。
  if (isPano360ViewerNode(node)) {
    return false;
  }
  if (isVideoNode(node)) {
    return Boolean(node.data.videoUrl);
  }
  // imageGen 上传的是「参考图」，存进 referenceImageUrl 而非 imageUrl —— 但
  // 节点画面同样显示它（previewUrl 会回退到 referenceImageUrl），所以工具栏也
  // 应在只有参考图时出现，否则用户上传后看不到任何操作入口。
  if (isImageGenNode(node)) {
    return Boolean(
      node.data.imageUrl || node.data.previewImageUrl || node.data.referenceImageUrl,
    );
  }
  if (
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node)
  ) {
    return Boolean(node.data.imageUrl || node.data.previewImageUrl);
  }
  return true;
}

const SCENE_360_FOCUS_ZOOM = 1.2;
const SCENE_360_FOCUS_DURATION = 320;
const SCENE_360_DEFAULT_NODE_HEIGHT = 320;
const PANO_VIEWER_LAYOUT_WIDTH = 720;
const PANO_VIEWER_LAYOUT_HEIGHT = 420;
const NODE_ID_BADGE_OFFSET = 88;
const DEFAULT_OUTPAINT_ASPECT_RATIO: FreezoneOutpaintAspectRatio = 'original';
const DEFAULT_OUTPAINT_IMAGE_SIZE = '2K';

const GRID_RUN_ACTIONS: Record<string, {
  key: GridActionKey;
  i18nKey: string;
  mode: FreezoneTemplateEditMode;
}> = {
  run_grid_multi_camera: {
    key: 'multiCameraGrid',
    i18nKey: 'nodeToolbar.gridMenu.multiCameraGrid',
    mode: 'multi_camera_nine_grid',
  },
  run_grid_plot_four: {
    key: 'plotFourGrid',
    i18nKey: 'nodeToolbar.gridMenu.plotFourGrid',
    mode: 'story_pitch_four_grid',
  },
  run_grid_face_three_view: {
    key: 'faceThreeView',
    i18nKey: 'nodeToolbar.gridMenu.faceThreeView',
    mode: 'character_face_three_view',
  },
  run_grid_product_three_view: {
    key: 'productThreeView',
    i18nKey: 'nodeToolbar.gridMenu.productThreeView',
    mode: 'product_three_view',
  },
  run_grid_serial_storyboard_25: {
    key: 'serialStoryboard25',
    i18nKey: 'nodeToolbar.gridMenu.serialStoryboard25',
    mode: 'storyboard_25_grid',
  },
  run_grid_cinematic_light_correction: {
    key: 'cinematicLightCorrection',
    i18nKey: 'nodeToolbar.gridMenu.cinematicLightCorrection',
    mode: 'cinematic_light_correction',
  },
  run_grid_character_three_view: {
    key: 'characterThreeView',
    i18nKey: 'nodeToolbar.gridMenu.characterThreeView',
    mode: 'character_three_view_generation',
  },
  run_grid_scene_setting_sheet: {
    key: 'sceneSettingSheet',
    i18nKey: 'nodeToolbar.gridMenu.sceneSettingSheet',
    mode: 'scene_setting_sheet',
  },
  run_grid_frame_projection_3s_later: {
    key: 'frameProjection3sLater',
    i18nKey: 'nodeToolbar.gridMenu.frameProjection3sLater',
    mode: 'image_projection_after_3s',
  },
  run_grid_frame_projection_5s_earlier: {
    key: 'frameProjection5sEarlier',
    i18nKey: 'nodeToolbar.gridMenu.frameProjection5sEarlier',
    mode: 'image_projection_before_5s',
  },
};

const NODE_TOOL_DIALOG_ACTIONS: Record<string, NodeToolType> = {
  open_crop_tool: NODE_TOOL_TYPES.crop,
  open_annotate_tool: NODE_TOOL_TYPES.annotate,
  open_split_storyboard_tool: NODE_TOOL_TYPES.splitStoryboard,
};

export const SelectedNodeOverlay = memo(() => {
  const { t } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const setActiveOverlayNodeId = useCanvasStore((state) => state.setActiveOverlayNodeId);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const reactFlow = useReactFlow();

  // 顶部 toolbar 触发的二级 overlay（全景 / 多维度 / 打光 / 九宫格 等）
  // 打开时，必须把节点的 React Flow `selected` 真清掉——否则节点自身的
  // 操作面板（ImageGenNode 等用 `selected` prop 判断显示）会和 overlay
  // 同时露出来。`setSelectedNode(null)` 只清 store 的 `selectedNodeId`，
  // Canvas.tsx 的同步 effect 会立刻根据 `node.selected === true` 把它
  // 再写回去，所以必须走 onNodesChange 触发真正的 select=false。
  const clearFlowSelection = useCallback(() => {
    const ids = nodes.filter((n) => n.selected).map((n) => n.id);
    if (ids.length === 0) return;
    onNodesChange(
      ids.map((id) => ({ id, type: 'select' as const, selected: false })),
    );
  }, [nodes, onNodesChange]);

  const selectAndFocusCanvasNode = useCallback(
    (nodeId: string) => {
      const currentNodes = useCanvasStore.getState().nodes;
      onNodesChange(
        currentNodes.map((node) => ({
          id: node.id,
          type: 'select' as const,
          selected: node.id === nodeId,
        })),
      );
      setSelectedNode(nodeId);
      useCanvasStore.getState().requestFocusNode(nodeId);
    },
    [onNodesChange, setSelectedNode],
  );
  const [multiAngleNodeId, setMultiAngleNodeId] = useState<string | null>(null);
  const activeLightEditorNodeId = useCanvasStore((state) => state.activeLightEditorNodeId);
  const setLightEditorNodeId = useCanvasStore((state) => state.setActiveLightEditorNodeId);
  const [scene360NodeId, setScene360NodeId] = useState<string | null>(null);
  const [redrawNodeId, setRedrawNodeId] = useState<string | null>(null);
  const [eraseNodeId, setEraseNodeId] = useState<string | null>(null);
  const [outpaintNodeId, setOutpaintNodeId] = useState<string | null>(null);
  const [rotateNodeId, setRotateNodeId] = useState<string | null>(null);

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) {
      return null;
    }

    return nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [nodes, selectedNodeId]);

  const multiAngleNode = useMemo(() => {
    if (!multiAngleNodeId) {
      return null;
    }
    return nodes.find((node) => node.id === multiAngleNodeId) ?? null;
  }, [nodes, multiAngleNodeId]);

  const multiAngleImageSource = useMemo(
    () => resolveNodeSourceImageUrl(multiAngleNode),
    [multiAngleNode]
  );

  const redrawNode = useMemo(() => {
    if (!redrawNodeId) {
      return null;
    }
    return nodes.find((node) => node.id === redrawNodeId) ?? null;
  }, [nodes, redrawNodeId]);

  const redrawImageSource = useMemo(
    () => resolveNodeSourceImageUrl(redrawNode),
    [redrawNode]
  );

  const scene360Node = useMemo(() => {
    if (!scene360NodeId) {
      return null;
    }
    return nodes.find((node) => node.id === scene360NodeId) ?? null;
  }, [nodes, scene360NodeId]);

  const scene360ImageSource = useMemo(
    () => resolveNodeSourceImageUrl(scene360Node),
    [scene360Node]
  );


  const handleOpenMultiAngleEditor = useCallback(
    (nodeId: string) => {
      setMultiAngleNodeId(nodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, setSelectedNode]
  );

  const handleCloseMultiAngleEditor = useCallback(() => {
    setMultiAngleNodeId(null);
  }, []);

  const handleOpenLightEditor = useCallback(
    (nodeId: string) => {
      setLightEditorNodeId(nodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, setSelectedNode]
  );

  const handleOpenRedraw = useCallback(
    (nodeId: string) => {
      setRedrawNodeId(nodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, setSelectedNode]
  );

  const handleCloseRedraw = useCallback(() => {
    setRedrawNodeId(null);
  }, []);

  const eraseNode = useMemo(() => {
    if (!eraseNodeId) {
      return null;
    }
    return nodes.find((node) => node.id === eraseNodeId) ?? null;
  }, [nodes, eraseNodeId]);

  const eraseImageSource = useMemo(
    () => resolveNodeSourceImageUrl(eraseNode),
    [eraseNode]
  );

  const handleOpenErase = useCallback(
    (nodeId: string) => {
      setEraseNodeId(nodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, setSelectedNode]
  );

  const handleCloseErase = useCallback(() => {
    setEraseNodeId(null);
  }, []);

  const handleOpenScene360 = useCallback(
    (nodeId: string) => {
      const targetNode = nodes.find((node) => node.id === nodeId);
      if (targetNode) {
        const width =
          typeof targetNode.measured?.width === 'number'
            ? targetNode.measured.width
            : typeof targetNode.width === 'number'
              ? targetNode.width
              : DEFAULT_NODE_WIDTH;
        const height =
          typeof targetNode.measured?.height === 'number'
            ? targetNode.measured.height
            : typeof targetNode.height === 'number'
              ? targetNode.height
              : SCENE_360_DEFAULT_NODE_HEIGHT;
        // 组内成员的 position 是相对父组坐标；setCenter 需要绝对坐标，否则视野跳偏。
        const absolute =
          reactFlow.getInternalNode(nodeId)?.internals.positionAbsolute ??
          targetNode.position;
        const centerX = absolute.x + width / 2;
        const centerY = absolute.y + height / 2;
        reactFlow.setCenter(centerX, centerY, {
          zoom: SCENE_360_FOCUS_ZOOM,
          duration: SCENE_360_FOCUS_DURATION,
        });
      }
      setScene360NodeId(nodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, nodes, reactFlow, setSelectedNode]
  );

  const handleCloseScene360 = useCallback(() => {
    setScene360NodeId(null);
  }, []);

  const outpaintNode = useMemo(() => {
    if (!outpaintNodeId) {
      return null;
    }
    return nodes.find((node) => node.id === outpaintNodeId) ?? null;
  }, [nodes, outpaintNodeId]);

  const outpaintImageSource = useMemo(
    () => resolveNodeSourceImageUrl(outpaintNode),
    [outpaintNode]
  );

  const handleOpenOutpaint = useCallback(
    (nodeId: string) => {
      setOutpaintNodeId(nodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, setSelectedNode]
  );

  const handleCloseOutpaint = useCallback(() => {
    setOutpaintNodeId(null);
  }, []);

  const rotateNode = useMemo(() => {
    if (!rotateNodeId) {
      return null;
    }
    return nodes.find((node) => node.id === rotateNodeId) ?? null;
  }, [nodes, rotateNodeId]);

  const rotateImageSource = useMemo(() => {
    if (!rotateNode) {
      return null;
    }
    if (
      isUploadNode(rotateNode)
      || isImageEditNode(rotateNode)
      || isImageGenNode(rotateNode)
      || isExportImageNode(rotateNode)
    ) {
      return (
        rotateNode.data.imageUrl
        || rotateNode.data.previewImageUrl
        || null
      );
    }
    return null;
  }, [rotateNode]);

  const handleOpenRotate = useCallback(
    (sourceNodeId: string) => {
      const newNodeId = createRotateResultNode(sourceNodeId, {
        displayName: t('rotateEditor.resultTitle'),
      });
      if (!newNodeId) return;
      setRotateNodeId(newNodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, setSelectedNode, t]
  );

  // 旋转结果节点可能被用户用键盘直接删掉（绕过编辑器的关闭流程）。此时
  // `rotateNode` 解析为 null、编辑器自然消失，但 `rotateNodeId` 仍残留一个
  // 失效 id，会让顶部 toolbar 的 `!rotateNodeId` 判断一直为假 —— 重新选中
  // 原图片节点也不再显示菜单。节点消失后同步清空状态，避免这种悬挂。
  useEffect(() => {
    if (rotateNodeId && !rotateNode) {
      setRotateNodeId(null);
    }
  }, [rotateNodeId, rotateNode]);

  const handleCloseRotate = useCallback(
    (committed: boolean) => {
      // 进入旋转时会预创建一个「旋转结果」节点。用户退出 / 按 Esc / 没做任何
      // 变换就关闭（committed=false）时，把它删掉，否则会凭空多出一个节点。
      if (!committed && rotateNodeId) {
        discardRotateResultNode(rotateNodeId);
      }
      setRotateNodeId(null);
    },
    [rotateNodeId]
  );

  const handleOpenUpscale = useCallback(
    (sourceNodeId: string) => {
      const placeholderNodeId = createUpscaleResultNode(sourceNodeId, {
        displayName: t('upscaleEditor.title'),
      });
      if (!placeholderNodeId) return;
      selectAndFocusCanvasNode(placeholderNodeId);
    },
    [selectAndFocusCanvasNode, t],
  );

  const upscalePanelNode = useMemo(() => {
    if (!selectedNode) return null;
    if (!isExportImageNode(selectedNode)) return null;
    if (
      (selectedNode.data as { resultKind?: ExportImageNodeResultKind }).resultKind
      !== 'upscale'
    ) {
      return null;
    }
    return selectedNode;
  }, [selectedNode]);

  const videoUpscalePanelNode = useMemo(() => {
    if (!selectedNode) return null;
    if (!isVideoNode(selectedNode)) return null;
    return selectedNode.data.isUpscaleNode ? selectedNode : null;
  }, [selectedNode]);

  /**
   * 「九宫格」下拉点某一项：**只在源节点下游建一个功能节点，不提交**——节点名 =
   * 功能名，功能 chip 落在它的提示词输入框里，用户改完提示词/参考图/比例按 ↑ 才
   * 真正下发（与故事板详情工具条同一条交互，同一个 spawn/run）。
   *
   * 建完就选中并聚焦过去：功能节点的生成表单是跟着 React Flow 的 `selected` 渲染的，
   * 不选中就看不见输入框，也就没地方按 ↑。
   */
  const handleSpawnGridActionNode = useCallback(
    (request: GridActionRequest) => {
      const sourceNode = nodes.find((node) => node.id === request.nodeId) ?? null;
      const imageSource = resolveNodeSourceImageUrl(sourceNode);
      if (!sourceNode || !imageSource) {
        return;
      }
      const nextNodeId = spawnAssetBoardImageOpNode(sourceNode.id, imageSource, request.key);
      if (!nextNodeId) {
        return;
      }
      selectAndFocusCanvasNode(nextNodeId);
    },
    [nodes, selectAndFocusCanvasNode]
  );

  useEffect(() => {
    return subscribeNodeAction(({ nodeId, action, requestId }) => {
      const toolType = NODE_TOOL_DIALOG_ACTIONS[action];
      if (toolType) {
        canvasEventBus.publish("tool-dialog/open", {
          nodeId,
          toolType,
        });
        publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
        return;
      }

      switch (action) {
        case 'open_multi_angle_tool':
          handleOpenMultiAngleEditor(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        case 'open_light_tool':
          handleOpenLightEditor(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        case 'open_scene360_tool':
          handleOpenScene360(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        case 'open_redraw_tool':
          handleOpenRedraw(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        case 'open_erase_tool':
          handleOpenErase(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        case 'open_outpaint_tool':
          handleOpenOutpaint(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        case 'open_rotate_tool': {
          const beforeNodeIds = new Set(useCanvasStore.getState().nodes.map((node) => node.id));
          handleOpenRotate(nodeId);
          const created = useCanvasStore
            .getState()
            .nodes.some((node) => !beforeNodeIds.has(node.id));
          if (!created) {
            publishNodeActionError(requestId, nodeId, action, "目标节点没有可用于旋转的图片");
            return;
          }
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        }
        case 'open_upscale_tool':
          handleOpenUpscale(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        default:
          return;
      }
    });
  }, [
    handleOpenErase,
    handleOpenLightEditor,
    handleOpenMultiAngleEditor,
    handleOpenOutpaint,
    handleOpenRedraw,
    handleOpenRotate,
    handleOpenScene360,
    handleOpenUpscale,
  ]);

  useEffect(() => {
    return subscribeNodeAction(({ nodeId, action, requestId }) => {
      if (action === 'run_outpaint_tool') {
        const sourceNode = nodes.find((node) => node.id === nodeId) ?? null;
        const imageSource = resolveNodeSourceImageUrl(sourceNode);
        if (!sourceNode || !imageSource) {
          publishNodeActionError(requestId, nodeId, action, "目标节点没有可用于扩图的图片");
          return;
        }
        const project = readUrl().project;
        if (!project) {
          publishNodeActionError(requestId, nodeId, action, "当前 URL 缺少 project，无法提交生成");
          return;
        }

        publishNodeActionAccepted(requestId, nodeId, action);
        const sourceAspectRatio =
          typeof (sourceNode.data as { aspectRatio?: unknown }).aspectRatio === 'string'
            ? ((sourceNode.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
            : DEFAULT_ASPECT_RATIO;
        const position = findNodePosition(
          sourceNode.id,
          EXPORT_RESULT_NODE_DEFAULT_WIDTH,
          EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
        );
        const initialData = inheritMainlineFields(
          { data: sourceNode.data as Record<string, unknown> },
          {
            displayName: t('outpaintEditor.title'),
            imageUrl: null,
            previewImageUrl: null,
            aspectRatio: sourceAspectRatio,
            resultKind: 'generic',
            isGenerating: true,
            generationStartedAt: Date.now(),
          },
        );
        const nextNodeId = addNode(
          CANVAS_NODE_TYPES.exportImage,
          position,
          initialData as unknown as Parameters<typeof addNode>[2],
        );
        addEdge(sourceNode.id, nextNodeId);
        selectAndFocusCanvasNode(nextNodeId);

        void (async () => {
          try {
            const imageModels = getFreezoneImageModelsSnapshot(project).models;
            const selectedModel =
              imageModels.find((model) => model.id === DEFAULT_SHARED_MODEL_ID)
              ?? imageModels[0]
              ?? SHARED_MODELS.find((model) => model.id === DEFAULT_SHARED_MODEL_ID);
            const ref = await submitFreezoneOutpaint(project, {
              sourceUrl: imageSource.split('?')[0],
              targetAspectRatio: DEFAULT_OUTPAINT_ASPECT_RATIO,
              numImages: 1,
              imageSize: DEFAULT_OUTPAINT_IMAGE_SIZE,
              model: selectedModel?.apiModel ?? DEFAULT_SHARED_MODEL_ID,
            });
            useCanvasStore.getState().updateNodeData(nextNodeId, generationTaskDescriptor(ref));
            const completed = await awaitTaskCompletion(ref.task_key, project);
            const directUrl = completed.result?.['output_url'] as string | undefined;
            const url = directUrl
              ?? (await fetchFreezoneJobResult(project, ref.task_type, ref.job_id)).url;
            useCanvasStore.getState().updateNodeData(nextNodeId, {
              imageUrl: url,
              previewImageUrl: url,
              isGenerating: false,
              generationStartedAt: null,
              generationError: null,
            });
            publishNodeActionSuccess(requestId, nodeId, action, {
              nodeId: nextNodeId,
              imageUrl: url,
              previewImageUrl: url,
              task_key: ref.task_key,
              job_id: ref.job_id,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            useCanvasStore.getState().updateNodeData(nextNodeId, {
              isGenerating: false,
              generationStartedAt: null,
              generationError: message,
            });
            publishNodeActionError(requestId, nodeId, action, error);
          }
        })();
        return;
      }

      if (action === 'run_upscale_tool') {
        const sourceNode = nodes.find((node) => node.id === nodeId) ?? null;
        const imageSource = resolveNodeSourceImageUrl(sourceNode);
        if (!sourceNode || !imageSource) {
          publishNodeActionError(requestId, nodeId, action, "目标节点没有可用于高清放大的图片");
          return;
        }
        const project = readUrl().project;
        if (!project) {
          publishNodeActionError(requestId, nodeId, action, "当前 URL 缺少 project，无法提交生成");
          return;
        }

        publishNodeActionAccepted(requestId, nodeId, action);
        const sourceAspectRatio =
          typeof (sourceNode.data as { aspectRatio?: unknown }).aspectRatio === 'string'
            ? ((sourceNode.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
            : DEFAULT_ASPECT_RATIO;
        const position = findNodePosition(
          sourceNode.id,
          EXPORT_RESULT_NODE_DEFAULT_WIDTH,
          EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
        );
        const nextNodeId = addNode(
          CANVAS_NODE_TYPES.exportImage,
          position,
          {
            displayName: t('upscaleEditor.title'),
            imageUrl: null,
            previewImageUrl: imageSource,
            aspectRatio: sourceAspectRatio,
            resultKind: 'upscale',
            isGenerating: true,
            generationStartedAt: Date.now(),
            upscaleSourceUrl: imageSource,
            upscaleModelId: DEFAULT_UPSCALE_MODEL_ID,
            upscaleImageSize: '2K',
            upscaleScaleFactor: 2,
          },
        );
        addEdge(sourceNode.id, nextNodeId);
        selectAndFocusCanvasNode(nextNodeId);

        void (async () => {
          try {
            const imageModels = getFreezoneImageModelsSnapshot(project).models;
            const selectedModel =
              imageModels.find((model) => model.id === DEFAULT_UPSCALE_MODEL_ID)
              ?? imageModels[0];
            const ref = await submitFreezoneUpscale(project, {
              sourceUrl: imageSource.split('?')[0],
              scaleFactor: 2,
              imageSize: '2K',
              model: selectedModel?.apiModel ?? DEFAULT_UPSCALE_MODEL_ID,
            });
            useCanvasStore.getState().updateNodeData(nextNodeId, generationTaskDescriptor(ref));
            const completed = await awaitTaskCompletion(ref.task_key, project);
            const directUrl = completed.result?.['output_url'] as string | undefined;
            const url = directUrl
              ?? (await fetchFreezoneJobResult(project, ref.task_type, ref.job_id)).url;
            useCanvasStore.getState().updateNodeData(nextNodeId, {
              imageUrl: url,
              previewImageUrl: url,
              isGenerating: false,
              generationStartedAt: null,
              generationError: null,
            });
            publishNodeActionSuccess(requestId, nodeId, action, {
              nodeId: nextNodeId,
              imageUrl: url,
              previewImageUrl: url,
              task_key: ref.task_key,
              job_id: ref.job_id,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            useCanvasStore.getState().updateNodeData(nextNodeId, {
              isGenerating: false,
              generationStartedAt: null,
              generationError: message,
            });
            publishNodeActionError(requestId, nodeId, action, error);
          }
        })();
        return;
      }

      if (action === 'run_scene360_tool') {
        const sourceNode = nodes.find((node) => node.id === nodeId) ?? null;
        const imageSource = resolveNodeSourceImageUrl(sourceNode);
        if (!sourceNode || !imageSource) {
          publishNodeActionError(requestId, nodeId, action, "目标节点没有可用于生成的图片");
          return;
        }
        const project = readUrl().project;
        if (!project) {
          publishNodeActionError(requestId, nodeId, action, "当前 URL 缺少 project，无法提交生成");
          return;
        }

        publishNodeActionAccepted(requestId, nodeId, action);
        const aspectRatio = DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO;
        const position = findNodePosition(
          sourceNode.id,
          EXPORT_RESULT_NODE_DEFAULT_WIDTH,
          EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
        );
        const nextNodeId = addNode(
          CANVAS_NODE_TYPES.exportImage,
          position,
          {
            displayName: t('scene360.label'),
            imageUrl: null,
            previewImageUrl: null,
            aspectRatio,
            resultKind: 'generic',
            output_role: 'scene_360_candidate',
            media_kind: 'pano360',
            isGenerating: true,
            generationStartedAt: Date.now(),
          },
        );
        addEdge(sourceNode.id, nextNodeId);
        selectAndFocusCanvasNode(nextNodeId);

        void (async () => {
          try {
            const ref = await submitFreezoneScene360(project, {
              referenceUrl: imageSource.split('?')[0],
              aspectRatio,
            });
            useCanvasStore.getState().updateNodeData(nextNodeId, generationTaskDescriptor(ref));
            const completed = await awaitTaskCompletion(ref.task_key, project);
            const directUrl = completed.result?.['output_url'] as string | undefined;
            const url = directUrl
              ?? (await fetchFreezoneJobResult(project, ref.task_type, ref.job_id)).url;
            useCanvasStore.getState().updateNodeData(nextNodeId, {
              imageUrl: url,
              previewImageUrl: url,
              aspectRatio,
              output_role: 'scene_360_candidate',
              media_kind: 'pano360',
              isGenerating: false,
              generationStartedAt: null,
              generationError: null,
            });

            const viewerPosition = findNodePosition(
              nextNodeId,
              PANO_VIEWER_LAYOUT_WIDTH,
              PANO_VIEWER_LAYOUT_HEIGHT,
            );
            const viewerNodeId = addNode(CANVAS_NODE_TYPES.pano360Viewer, viewerPosition);
            addEdge(nextNodeId, viewerNodeId);
            selectAndFocusCanvasNode(viewerNodeId);
            publishNodeActionSuccess(requestId, nodeId, action, {
              nodeId: nextNodeId,
              viewerNodeId,
              imageUrl: url,
              previewImageUrl: url,
              task_key: ref.task_key,
              job_id: ref.job_id,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            useCanvasStore.getState().updateNodeData(nextNodeId, {
              isGenerating: false,
              generationStartedAt: null,
              generationError: message,
            });
            publishNodeActionError(requestId, nodeId, action, error);
          }
        })();
        return;
      }

      const runAction = GRID_RUN_ACTIONS[action];
      if (!runAction) return;

      const sourceNode = nodes.find((node) => node.id === nodeId) ?? null;
      const imageSource = resolveNodeSourceImageUrl(sourceNode);
      if (!sourceNode || !imageSource) {
        publishNodeActionError(requestId, nodeId, action, "目标节点没有可用于生成的图片");
        return;
      }
      const project = readUrl().project;
      if (!project) {
        publishNodeActionError(requestId, nodeId, action, "当前 URL 缺少 project，无法提交生成");
        return;
      }

      publishNodeActionAccepted(requestId, nodeId, action);
      const label = t(runAction.i18nKey);
      const sourceAspectRatio =
        typeof (sourceNode.data as { aspectRatio?: unknown }).aspectRatio === 'string'
          ? ((sourceNode.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
          : DEFAULT_ASPECT_RATIO;
      const position = findNodePosition(
        sourceNode.id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
      );
      const nextNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        position,
        {
          displayName: label,
          imageUrl: null,
          previewImageUrl: null,
          aspectRatio: sourceAspectRatio,
          resultKind: 'generic',
          isGenerating: true,
          generationStartedAt: Date.now(),
        },
      );
      addEdge(sourceNode.id, nextNodeId);
      selectAndFocusCanvasNode(nextNodeId);

      void (async () => {
        try {
          const ref = await submitFreezoneTemplateEdit(project, {
            sourceUrl: imageSource.split('?')[0],
            mode: runAction.mode,
            prompt: label,
          });
          useCanvasStore.getState().updateNodeData(nextNodeId, generationTaskDescriptor(ref));
          const completed = await awaitTaskCompletion(ref.task_key, project);
          const directUrl = completed.result?.['output_url'] as string | undefined;
          const url = directUrl
            ?? (await fetchFreezoneJobResult(project, ref.task_type, ref.job_id)).url;
          useCanvasStore.getState().updateNodeData(nextNodeId, {
            imageUrl: url,
            previewImageUrl: url,
            isGenerating: false,
            generationStartedAt: null,
            generationError: null,
          });
          publishNodeActionSuccess(requestId, nodeId, action, {
            nodeId: nextNodeId,
            imageUrl: url,
            previewImageUrl: url,
            task_key: ref.task_key,
            job_id: ref.job_id,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          useCanvasStore.getState().updateNodeData(nextNodeId, {
            isGenerating: false,
            generationStartedAt: null,
            generationError: message,
          });
          publishNodeActionError(requestId, nodeId, action, error);
        }
      })();
    });
  }, [addEdge, addNode, findNodePosition, nodes, selectAndFocusCanvasNode, t]);

  // 任意二级功能浮层（全景 / 多角度 / 打光 / 重绘 / 扩图 / 旋转 / 九宫格）打开时，
  // 记录它的目标节点 id。节点自身的 `selected` 操作面板会据此让位，避免和浮层
  // 在节点下方重叠——功能浮层优先级更高。(放大/高清 upscale 是在新建节点上原地
  // 展开面板，不参与此互斥。)
  const activeOverlayNodeId =
    multiAngleNodeId
    ?? activeLightEditorNodeId
    ?? scene360NodeId
    ?? redrawNodeId
    ?? eraseNodeId
    ?? outpaintNodeId
    ?? rotateNodeId
    ?? null;

  useEffect(() => {
    // 只在自己有浮层时写入，清理时也只清自己注册的值——节点组件（叠卡画册）
    // 也会往同一个 store 槽位注册，无条件写 null 会把它们的注册抹掉（工具条 /
    // 替换素材把手 / + 派生按钮会重新叠回还开着的画册上）。
    if (!activeOverlayNodeId) return;
    setActiveOverlayNodeId(activeOverlayNodeId);
    return () => {
      if (useCanvasStore.getState().activeOverlayNodeId === activeOverlayNodeId) {
        setActiveOverlayNodeId(null);
      }
    };
  }, [activeOverlayNodeId, setActiveOverlayNodeId]);

  // 节点自己也可以往 store 注册 overlay（如图片节点展开叠卡画册）——这里的
  // 本地派生值看不到它，工具条/替换素材把手要一并尊重 store 里的注册，
  // 否则拖动画册时 React Flow 重新选中节点，工具条又会叠出来。
  const externalOverlayNodeId = useCanvasStore((state) => state.activeOverlayNodeId);
  const effectiveOverlayNodeId = activeOverlayNodeId ?? externalOverlayNodeId;

  // 故事片段「播放器形态」(故事组内视频节点且未进入编辑态):抑制顶部视频工具条
  // (剪辑/高清/去字幕/...) 与智能素材把手 —— 这些是画布创作能力,故事语境下收起。
  const storyEditNodeId = useCanvasStore((state) => state.storyEditNodeId);
  const selectedIsStoryPlayer =
    selectedNode != null &&
    isNodeStoryClip(nodes, selectedNodeId) &&
    storyEditNodeId !== selectedNodeId;

  return (
    <>
      {selectedNode
        && !rotateNodeId
        && !effectiveOverlayNodeId && (
        <ReactFlowNodeToolbar
          nodeId={selectedNode.id}
          isVisible
          position={Position.Top}
          align={
            nodeHasResourceForToolbar(selectedNode) ? "center" : "start"
          }
          offset={NODE_ID_BADGE_OFFSET}
        >
          <NodeIdBadge nodeId={selectedNode.id} />
        </ReactFlowNodeToolbar>
      )}
      {selectedNode
        && !rotateNodeId
        && !effectiveOverlayNodeId
        && !selectedIsStoryPlayer
        && nodeHasResourceForToolbar(selectedNode) && (
        <NodeActionToolbar
          // 按节点 id 重挂载，确保每次「激活某个节点」都重放顶部菜单的入场动画
          // ——否则直接在两个节点间切换时组件实例复用，CSS 动画只在首次挂载时跑。
          key={selectedNode.id}
          node={selectedNode}
          onOpenMultiAngleEditor={handleOpenMultiAngleEditor}
          onOpenLightEditor={handleOpenLightEditor}
          onOpenScene360={handleOpenScene360}
          onOpenUpscale={handleOpenUpscale}
          onOpenOutpaint={handleOpenOutpaint}
          onSpawnGridActionNode={handleSpawnGridActionNode}
          onOpenRedraw={handleOpenRedraw}
          onOpenErase={handleOpenErase}
          onOpenRotate={handleOpenRotate}
        />
      )}
      {selectedNode && !rotateNodeId && !effectiveOverlayNodeId && !selectedIsStoryPlayer && (
        <AssetCommitHandle node={selectedNode} />
      )}
      {multiAngleNode && multiAngleImageSource && (
        <MultiAngleEditorOverlay
          node={multiAngleNode}
          imageSource={multiAngleImageSource}
          onClose={handleCloseMultiAngleEditor}
        />
      )}
      {redrawNode && redrawImageSource && (
        <RedrawOverlay
          node={redrawNode}
          imageSource={redrawImageSource}
          onClose={handleCloseRedraw}
        />
      )}
      {eraseNode && eraseImageSource && (
        <EraseOverlay
          node={eraseNode}
          imageSource={eraseImageSource}
          onClose={handleCloseErase}
        />
      )}
      {scene360Node && scene360ImageSource && (
        <Scene360Overlay
          node={scene360Node}
          imageSource={scene360ImageSource}
          onClose={handleCloseScene360}
        />
      )}
      {upscalePanelNode && (
        <UpscaleEditorOverlay node={upscalePanelNode} />
      )}
      {videoUpscalePanelNode && (
        <VideoUpscaleEditorOverlay node={videoUpscalePanelNode} />
      )}
      {outpaintNode && outpaintImageSource && (
        <OutpaintEditorOverlay
          node={outpaintNode}
          imageSource={outpaintImageSource}
          onClose={handleCloseOutpaint}
        />
      )}
      {rotateNode && rotateImageSource && (
        <RotateEditorOverlay
          node={rotateNode}
          imageSource={rotateImageSource}
          onClose={handleCloseRotate}
        />
      )}
    </>
  );
});

SelectedNodeOverlay.displayName = 'SelectedNodeOverlay';
