// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Check,
  FlipHorizontal,
  FlipVertical,
  Loader2,
  RotateCw,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  isIdentityRotateTransform,
  rotateImageInPlace,
} from '@/features/canvas/application/imageRotate';

import { CANVAS_NODE_TOOLBAR_PILL_CLASS } from './nodeFrameStyles';

/**
 * 「旋转与镜像」编辑器的**外壳无关**内容层：状态机 + 那条控制条。
 *
 * 抽出来是因为同一套交互要挂在两种外壳上：工作流把它塞进节点上方的
 * `ReactFlowNodeToolbar`（RotateEditorOverlay），故事板详情没有 React Flow，走
 * portal 到 body 的全屏弹窗（AssetBoardRotateDialog）。两边共用这里的 hook 与
 * 控制条，行为/视觉才不会各长各的。
 *
 * 预览图不在这里：两个外壳的取景框差太多（工作流按节点尺寸裁切，故事板是大图
 * 居中），各自渲染 `<img style={{ transform }}>` 即可，transform 由 hook 给。
 */

// 旋转锚点：用户每次点击"顺时针 90°"都从角度滑块的当前值上加 90°，
// 而镜像则是布尔切换（再次按下会取消），与 libtv 行为一致。
function normalizeAngle(angle: number): number {
  const n = angle % 360;
  return n < 0 ? n + 360 : n;
}

export interface RotateEditorController {
  angle: number;
  mirrorH: boolean;
  mirrorV: boolean;
  isSaving: boolean;
  /** 实时预览用的 CSS transform（旋转 + 双向镜像）。 */
  transform: string;
  onAngleChange: (value: number) => void;
  onRotate90: () => void;
  onToggleMirrorH: () => void;
  onToggleMirrorV: () => void;
  onExit: () => void;
  onSave: () => void;
}

export interface UseRotateEditorOptions {
  /** 旋转写回的目标节点（调用方进入编辑器前预建的「旋转结果」节点）。 */
  nodeId: string;
  imageSource: string;
  /**
   * 关闭编辑器。`committed` 表示是否真正提交了一次旋转（开始写回节点）：
   *   - `false`：用户退出 / 按 Esc / 无任何变换直接关闭 —— 调用方应把进入旋转时
   *     预创建的「旋转结果」节点删掉，避免凭空多出一个节点。
   *   - `true` ：已开始把旋转结果写回该节点，调用方保留它。
   */
  onClose: (committed: boolean) => void;
  /**
   * 提交成功、写回任务已起飞时把它的 completion 交给宿主，在 `onClose(true)` 之前
   * 触发。故事板拿它挂 busy 态与失败反馈（源节点详情面板上那行红字）；工作流不需要，
   * 不传即可。
   */
  onCommitted?: (completion: Promise<void>) => void;
}

export function useRotateEditor({
  nodeId,
  imageSource,
  onClose,
  onCommitted,
}: UseRotateEditorOptions): RotateEditorController {
  const [angle, setAngle] = useState(0);
  const [mirrorH, setMirrorH] = useState(false);
  const [mirrorV, setMirrorV] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const transform = useMemo(() => {
    const sx = mirrorH ? -1 : 1;
    const sy = mirrorV ? -1 : 1;
    return `rotate(${angle}deg) scale(${sx}, ${sy})`;
  }, [angle, mirrorH, mirrorV]);

  const onRotate90 = useCallback(() => {
    setAngle((prev) => normalizeAngle(prev + 90));
  }, []);

  const onAngleChange = useCallback((value: number) => {
    if (Number.isFinite(value)) {
      setAngle(normalizeAngle(value));
    }
  }, []);

  const onToggleMirrorH = useCallback(() => setMirrorH((prev) => !prev), []);
  const onToggleMirrorV = useCallback(() => setMirrorV((prev) => !prev), []);
  const onExit = useCallback(() => onClose(false), [onClose]);

  const onSave = useCallback(() => {
    if (isSaving) return;
    const rotateTransform = { angleDeg: angle, mirrorH, mirrorV };
    // 没有任何变换时直接关闭，不必上传重写。视作「未提交」，让调用方把预创建
    // 的结果节点删掉（等同退出）。
    if (isIdentityRotateTransform(rotateTransform)) {
      onClose(false);
      return;
    }

    // isGenerating 置位与后续写回都在 application 函数内完成；缺 project 时返回
    // null，此处不改变编辑态（与原「直接 return、不关闭」行为一致）。
    const completion = rotateImageInPlace(nodeId, imageSource, rotateTransform);
    if (!completion) return;

    setIsSaving(true);
    onCommitted?.(completion);
    // 已开始写回旋转结果到该节点 —— 标记为已提交，调用方保留节点。
    onClose(true);
    void completion.finally(() => setIsSaving(false));
  }, [
    angle,
    imageSource,
    isSaving,
    mirrorH,
    mirrorV,
    nodeId,
    onClose,
    onCommitted,
  ]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving) {
        onClose(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSaving, onClose]);

  return {
    angle,
    mirrorH,
    mirrorV,
    isSaving,
    transform,
    onAngleChange,
    onRotate90,
    onToggleMirrorH,
    onToggleMirrorV,
    onExit,
    onSave,
  };
}

const ICON_BUTTON_CLASS =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-dark transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-50';

/**
 * 控制条：退出 · 角度 · 顺时针 90° · 水平/垂直镜像 · 保存。
 *
 * @param showTitle 是否在退出钮右边显示「旋转与镜像」标题。工作流那条挂在节点正
 *   上方、宽度跟着节点走，加标题会顶出节点边界，所以默认关；故事板浮在大图上方，
 *   空间充裕且需要说明当前处于哪个编辑器，开着。
 */
export function RotateEditorToolbar({
  controller,
  showTitle = false,
}: {
  controller: RotateEditorController;
  showTitle?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { angle, isSaving, mirrorH, mirrorV } = controller;

  return (
    <div
      className={`flex w-max items-center gap-1 whitespace-nowrap ${CANVAS_NODE_TOOLBAR_PILL_CLASS}`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-dark/70 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-50"
        onClick={controller.onExit}
        title={t('rotateEditor.exit')}
        aria-label={t('rotateEditor.exit')}
        disabled={isSaving}
      >
        <X className="h-4 w-4" />
      </button>

      {showTitle && (
        <>
          <span className="shrink-0 px-1.5 text-xs font-medium text-text-dark">
            {t('rotateEditor.title')}
          </span>
          <span className="mx-0.5 h-5 w-px shrink-0 bg-white/10" aria-hidden />
        </>
      )}

      <div className="flex shrink-0 items-center gap-2 px-2" title={t('rotateEditor.angleLabel')}>
        {/* 已经有「旋转与镜像」标题时不再重复一遍「旋转角度」，只留输入框（无障碍名
            由 input 自己的 aria-label 提供），与 libtv 那条控制条一致。 */}
        {!showTitle && (
          <span className="shrink-0 text-[11px] text-text-dark/90">
            {t('rotateEditor.angleLabel')}
          </span>
        )}
        <div className="relative shrink-0">
          <input
            type="number"
            min={0}
            max={360}
            step={1}
            value={Math.round(angle)}
            disabled={isSaving}
            aria-label={t('rotateEditor.angleLabel')}
            onChange={(event) => controller.onAngleChange(Number(event.target.value))}
            className="h-7 w-16 rounded-md border border-[rgba(255,255,255,0.14)] bg-bg-dark/60 px-1.5 pr-5 text-center text-xs text-text-dark outline-none focus:border-accent disabled:opacity-50"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-muted">
            {t('rotateEditor.angleSuffix')}
          </span>
        </div>
      </div>

      <button
        type="button"
        className={ICON_BUTTON_CLASS}
        onClick={controller.onRotate90}
        title={t('rotateEditor.rotate90')}
        aria-label={t('rotateEditor.rotate90')}
        disabled={isSaving}
      >
        <RotateCw className="h-4 w-4" />
      </button>

      <button
        type="button"
        className={ICON_BUTTON_CLASS}
        onClick={controller.onToggleMirrorH}
        title={t('rotateEditor.mirrorH')}
        aria-label={t('rotateEditor.mirrorH')}
        aria-pressed={mirrorH}
        disabled={isSaving}
      >
        <FlipHorizontal className="h-4 w-4" />
      </button>

      <button
        type="button"
        className={ICON_BUTTON_CLASS}
        onClick={controller.onToggleMirrorV}
        title={t('rotateEditor.mirrorV')}
        aria-label={t('rotateEditor.mirrorV')}
        aria-pressed={mirrorV}
        disabled={isSaving}
      >
        <FlipVertical className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={controller.onSave}
        disabled={isSaving}
        className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-3 text-xs font-medium text-bg-dark transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        title={t('rotateEditor.save')}
      >
        {isSaving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Check className="h-4 w-4" />
        )}
        {isSaving ? t('rotateEditor.saving') : t('rotateEditor.save')}
      </button>
    </div>
  );
}
