// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useTranslation } from 'react-i18next';

import { useCanvasStore } from '@/stores/canvasStore';
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
  resolveNodeSourceImageUrl,
  type CanvasNode,
  type ExportImageNodeResultKind,
} from '@/features/canvas/domain/canvasNodes';
import { isNodeStoryClip } from '@/features/canvas/story/storySelectors';
import { NodeActionToolbar } from './NodeActionToolbar';
import { AssetCommitHandle } from './AssetCommitHandle';
import { MultiAngleEditorOverlay } from './MultiAngleEditorOverlay';
import { LightEditorOverlay } from './LightEditorOverlay';
import { RedrawOverlay } from './RedrawOverlay';
import { EraseOverlay } from './EraseOverlay';
import { Scene360Overlay } from './Scene360Overlay';
import { UpscaleEditorOverlay } from './UpscaleEditorOverlay';
import { VideoUpscaleEditorOverlay } from './VideoUpscaleEditorOverlay';
import { OutpaintEditorOverlay } from './OutpaintEditorOverlay';
import { RotateEditorOverlay } from './RotateEditorOverlay';
import {
  GridActionConfirmOverlay,
  type GridActionRequest,
} from './GridActionConfirmOverlay';

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

const GRID_ACTION_FOCUS_ZOOM = 1.2;
const GRID_ACTION_FOCUS_DURATION = 320;
const GRID_ACTION_DEFAULT_NODE_HEIGHT = 320;
const SCENE_360_FOCUS_ZOOM = 1.2;
const SCENE_360_FOCUS_DURATION = 320;
const SCENE_360_DEFAULT_NODE_HEIGHT = 320;

export const SelectedNodeOverlay = memo(() => {
  const { t } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const setActiveOverlayNodeId = useCanvasStore((state) => state.setActiveOverlayNodeId);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
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
  const [multiAngleNodeId, setMultiAngleNodeId] = useState<string | null>(null);
  const [lightEditorNodeId, setLightEditorNodeId] = useState<string | null>(null);
  const [scene360NodeId, setScene360NodeId] = useState<string | null>(null);
  const [redrawNodeId, setRedrawNodeId] = useState<string | null>(null);
  const [eraseNodeId, setEraseNodeId] = useState<string | null>(null);
  const [outpaintNodeId, setOutpaintNodeId] = useState<string | null>(null);
  const [rotateNodeId, setRotateNodeId] = useState<string | null>(null);
  const [gridActionRequest, setGridActionRequest] = useState<GridActionRequest | null>(null);

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

  const lightEditorNode = useMemo(() => {
    if (!lightEditorNodeId) {
      return null;
    }
    return nodes.find((node) => node.id === lightEditorNodeId) ?? null;
  }, [nodes, lightEditorNodeId]);

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

  const lightEditorImageSource = useMemo(
    () => resolveNodeSourceImageUrl(lightEditorNode),
    [lightEditorNode]
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

  const gridActionNode = useMemo(() => {
    if (!gridActionRequest) {
      return null;
    }
    return nodes.find((node) => node.id === gridActionRequest.nodeId) ?? null;
  }, [gridActionRequest, nodes]);

  const gridActionImageSource = useMemo(
    () => resolveNodeSourceImageUrl(gridActionNode),
    [gridActionNode]
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

  const handleCloseLightEditor = useCallback(() => {
    setLightEditorNodeId(null);
  }, []);

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
      const sourceNode = nodes.find((n) => n.id === sourceNodeId);
      if (!sourceNode) return;
      if (
        !isUploadNode(sourceNode)
        && !isImageEditNode(sourceNode)
        && !isImageGenNode(sourceNode)
        && !isExportImageNode(sourceNode)
      ) {
        return;
      }
      const sourceImageUrl =
        sourceNode.data.imageUrl || sourceNode.data.previewImageUrl || null;
      if (!sourceImageUrl) return;

      const sourceAspectRatio =
        typeof (sourceNode.data as { aspectRatio?: unknown }).aspectRatio === 'string'
          ? ((sourceNode.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
          : DEFAULT_ASPECT_RATIO;
      const position = findNodePosition(
        sourceNode.id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
      );
      const newNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        position,
        {
          displayName: t('rotateEditor.resultTitle'),
          imageUrl: null,
          previewImageUrl: sourceImageUrl,
          aspectRatio: sourceAspectRatio,
          resultKind: 'generic',
          isGenerating: false,
        },
      );
      addEdge(sourceNode.id, newNodeId);
      setRotateNodeId(newNodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [addEdge, addNode, clearFlowSelection, findNodePosition, nodes, setSelectedNode, t]
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
        deleteNode(rotateNodeId);
      }
      setRotateNodeId(null);
    },
    [deleteNode, rotateNodeId]
  );

  const handleOpenUpscale = useCallback(
    (sourceNodeId: string) => {
      const sourceNode = nodes.find((n) => n.id === sourceNodeId);
      if (!sourceNode) return;
      if (
        !isUploadNode(sourceNode)
        && !isImageEditNode(sourceNode)
        && !isExportImageNode(sourceNode)
      ) {
        return;
      }
      const sourceImageUrl =
        sourceNode.data.imageUrl || sourceNode.data.previewImageUrl || null;
      if (!sourceImageUrl) return;

      const sourceAspectRatio =
        typeof (sourceNode.data as { aspectRatio?: unknown }).aspectRatio === 'string'
          ? ((sourceNode.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
          : DEFAULT_ASPECT_RATIO;
      const position = findNodePosition(
        sourceNode.id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
      );
      const placeholderNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        position,
        {
          displayName: t('upscaleEditor.title'),
          imageUrl: null,
          previewImageUrl: sourceImageUrl,
          aspectRatio: sourceAspectRatio,
          resultKind: 'upscale',
          isGenerating: false,
          // Persist enough to (re-)run the upscale and to drive the always-attached panel.
          upscaleSourceUrl: sourceImageUrl,
          upscaleModelId: 'huimeng/gpt-image-2',
          upscaleImageSize: '2K',
          upscaleScaleFactor: 2,
        },
      );
      addEdge(sourceNode.id, placeholderNodeId);
      setSelectedNode(placeholderNodeId);
    },
    [addEdge, addNode, findNodePosition, nodes, setSelectedNode, t],
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

  const handleOpenGridAction = useCallback(
    (request: GridActionRequest) => {
      const targetNode = nodes.find((node) => node.id === request.nodeId);
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
              : GRID_ACTION_DEFAULT_NODE_HEIGHT;
        // 组内成员的 position 是相对父组坐标；setCenter 需要绝对坐标，否则视野跳偏。
        const absolute =
          reactFlow.getInternalNode(request.nodeId)?.internals.positionAbsolute ??
          targetNode.position;
        const centerX = absolute.x + width / 2;
        const centerY = absolute.y + height / 2;
        reactFlow.setCenter(centerX, centerY, {
          zoom: GRID_ACTION_FOCUS_ZOOM,
          duration: GRID_ACTION_FOCUS_DURATION,
        });
      }
      setGridActionRequest(request);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, nodes, reactFlow, setSelectedNode]
  );

  const handleCloseGridAction = useCallback(() => {
    setGridActionRequest(null);
  }, []);

  // 任意二级功能浮层（全景 / 多角度 / 打光 / 重绘 / 扩图 / 旋转 / 九宫格）打开时，
  // 记录它的目标节点 id。节点自身的 `selected` 操作面板会据此让位，避免和浮层
  // 在节点下方重叠——功能浮层优先级更高。(放大/高清 upscale 是在新建节点上原地
  // 展开面板，不参与此互斥。)
  const activeOverlayNodeId =
    multiAngleNodeId
    ?? lightEditorNodeId
    ?? scene360NodeId
    ?? redrawNodeId
    ?? eraseNodeId
    ?? outpaintNodeId
    ?? rotateNodeId
    ?? gridActionRequest?.nodeId
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
          onOpenGridAction={handleOpenGridAction}
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
      {lightEditorNode && lightEditorImageSource && (
        <LightEditorOverlay
          node={lightEditorNode}
          imageSource={lightEditorImageSource}
          onClose={handleCloseLightEditor}
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
      {gridActionRequest && gridActionNode && gridActionImageSource && (
        <GridActionConfirmOverlay
          node={gridActionNode}
          imageSource={gridActionImageSource}
          request={gridActionRequest}
          onClose={handleCloseGridAction}
        />
      )}
    </>
  );
});

SelectedNodeOverlay.displayName = 'SelectedNodeOverlay';
