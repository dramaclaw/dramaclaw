// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { FreezoneTemplateEditMode } from '@/api/ops';
import type { GridActionKey } from '../gridTemplateAction';
import type { CanvasEnvironment } from '../../core/environment';
import type { CanvasNode } from '../../domain/canvasNodes';
import {
  CANVAS_NODE_TYPES, DEFAULT_ASPECT_RATIO, EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT, resolveNodeSourceImageUrl,
} from '../../domain/canvasNodes';
import { DEFAULT_SHARED_MODEL_ID } from '../../domain/defaultModelIds';
import { DEFAULT_UPSCALE_MODEL_ID, SHARED_MODELS } from '../../domain/modelOptions';
import type { ModelOption } from '../../domain/modelOptions';
import { inheritMainlineFields } from '../../domain/inheritMainlineFields';

export const GRID_RUN_ACTIONS: Record<string, {
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

export type GridRunAction = (typeof GRID_RUN_ACTIONS)[string];
export type ImageToolAction =
  | 'run_outpaint_tool'
  | 'run_upscale_tool'
  | 'run_scene360_tool'
  | 'run_grid_multi_camera'
  | 'run_grid_plot_four'
  | 'run_grid_face_three_view'
  | 'run_grid_product_three_view'
  | 'run_grid_serial_storyboard_25'
  | 'run_grid_cinematic_light_correction'
  | 'run_grid_character_three_view'
  | 'run_grid_scene_setting_sheet'
  | 'run_grid_frame_projection_3s_later'
  | 'run_grid_frame_projection_5s_earlier';

export interface ImageToolRequestContext {
  action: ImageToolAction;
  nodes: readonly CanvasNode[];
  nodeId: string;
  projectId: string | null | undefined;
  imageModels: readonly ModelOption[];
  translate: CanvasEnvironment['translate'];
  nowMs: number;
}
export interface ImageToolLayout {
  anchorNodeId: string;
  width: number;
  height: number;
}
export type ImageToolRequestResult =
  | { ok: false; message: string }
  | {
      ok: true;
      /** HTTP path relative to /api/v1/. Caller performs the POST. */
      route: string;
      body: Record<string, unknown>;
      child: {
        type: typeof CANVAS_NODE_TYPES.exportImage;
        data: Record<string, unknown>;
        layout: ImageToolLayout;
      };
      edge: { source: string; target: 'child' };
      label?: string;
    };

/**
 * SelectedNodeOverlay's direct-action subscriber, through the ops JSON serializers.
 * Caller supplies the image snapshot and clock, computes positions with
 * findNodePosition(layout.anchorNodeId, layout.width, layout.height), and replaces
 * the child placeholder with the allocated id. Event parameters are ignored.
 * Unlike the browser's upload/forward paths, inline sources are refused here.
 */
export function buildImageToolRequest(ctx: ImageToolRequestContext): ImageToolRequestResult {
  const { action, projectId, imageModels, translate, nowMs } = ctx;
  const sourceNode = ctx.nodes.find(node => node.id === ctx.nodeId);
  const imageSource = resolveNodeSourceImageUrl(sourceNode);
  if (!sourceNode || !imageSource) {
    const message = action === 'run_outpaint_tool'
      ? '目标节点没有可用于扩图的图片' // i18n-exempt -- exact subscriber refusal
      : action === 'run_upscale_tool'
        ? '目标节点没有可用于高清放大的图片' // i18n-exempt -- exact subscriber refusal
        : '目标节点没有可用于生成的图片'; // i18n-exempt -- exact subscriber refusal
    return { ok: false, message };
  }
  if (!projectId) {
    return { ok: false, message: '当前 URL 缺少 project，无法提交生成' }; // i18n-exempt -- exact subscriber refusal
  }
  if (imageSource.startsWith('data:') || imageSource.startsWith('blob:')) {
    return { ok: false, message: 'Inline image sources must be prepared before building an image tool request.' };
  }
  const sourceData: Record<string, unknown> = { ...sourceNode.data };
  const sourceAspectRatio = typeof sourceData.aspectRatio === 'string' ? sourceData.aspectRatio : DEFAULT_ASPECT_RATIO;
  const sourceUrl = imageSource.split('?')[0];
  const finish = (suffix: string, body: Record<string, unknown>, data: Record<string, unknown>, label?: string): ImageToolRequestResult => ({
    ok: true,
    route: `projects/${encodeURIComponent(projectId)}/freezone/${suffix}`,
    body,
    child: { type: CANVAS_NODE_TYPES.exportImage, data, layout: {
      anchorNodeId: sourceNode.id, width: EXPORT_RESULT_NODE_DEFAULT_WIDTH, height: EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
    } },
    edge: { source: sourceNode.id, target: 'child' },
    ...(label === undefined ? {} : { label }),
  });
  const initialData = {
    imageUrl: null, previewImageUrl: null, aspectRatio: sourceAspectRatio,
    resultKind: 'generic', isGenerating: true, generationStartedAt: nowMs,
  };
  if (action === 'run_outpaint_tool') {
    const selectedModel = imageModels.find(model => model.id === DEFAULT_SHARED_MODEL_ID)
      ?? imageModels[0] ?? SHARED_MODELS.find(model => model.id === DEFAULT_SHARED_MODEL_ID);
    const model = selectedModel?.apiModel ?? DEFAULT_SHARED_MODEL_ID;
    return finish('outpaint', {
      source_url: sourceUrl, target_aspect_ratio: 'original', num_images: 1,
      image_size: '2K', ...(model ? { model } : {}),
    }, { ...inheritMainlineFields({ data: sourceData }, { ...initialData, displayName: translate('outpaintEditor.title') }) });
  }
  if (action === 'run_upscale_tool') {
    const selectedModel = imageModels.find(model => model.id === DEFAULT_UPSCALE_MODEL_ID) ?? imageModels[0];
    const model = selectedModel?.apiModel ?? DEFAULT_UPSCALE_MODEL_ID;
    return finish('upscale', {
      source_url: sourceUrl, scale_factor: 2, image_size: '2K', ...(model ? { model } : {}),
    }, {
      ...initialData, displayName: translate('upscaleEditor.title'), previewImageUrl: imageSource,
      resultKind: 'upscale', upscaleSourceUrl: imageSource, upscaleModelId: DEFAULT_UPSCALE_MODEL_ID,
      upscaleImageSize: '2K', upscaleScaleFactor: 2,
    });
  }
  if (action === 'run_scene360_tool') {
    // The serializer drops the component's aspectRatio and sends no model.
    return finish('scene-360', { reference_url: sourceUrl, image_size: '2K', mode: 'candidate' }, {
      ...initialData, displayName: translate('scene360.label'), aspectRatio: '2:1',
      output_role: 'scene_360_candidate', media_kind: 'pano360',
    });
  }
  const runAction = GRID_RUN_ACTIONS[action];
  const label = translate(runAction.i18nKey);
  return finish('template-edit', {
    source_url: sourceUrl, mode: runAction.mode, prompt: label, image_size: '2K',
  }, { ...initialData, displayName: label }, label);
}
