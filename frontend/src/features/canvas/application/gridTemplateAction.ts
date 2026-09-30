// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { type FreezoneTemplateEditMode } from '@/api/ops';

/**
 * 宫格模板动作 key。两个视图共用：工作流工具条「九宫格」下拉、故事板详情工具条
 * 「宫格模板」下拉，选中后都走同一条「先建功能节点 → ↑ 才提交」的交互
 * （见 {@link ../application/assetBoardImageOps#spawnAssetBoardImageOpNode}）。
 */
export type GridActionKey =
  | 'multiCameraGrid'
  | 'plotFourGrid'
  | 'faceThreeView'
  | 'productThreeView'
  | 'serialStoryboard25'
  | 'cinematicLightCorrection'
  | 'characterThreeView'
  | 'sceneSettingSheet'
  | 'frameProjection3sLater'
  | 'frameProjection5sEarlier';

export const GRID_ACTION_MODE_MAP: Record<GridActionKey, FreezoneTemplateEditMode> = {
  multiCameraGrid: 'multi_camera_nine_grid',
  plotFourGrid: 'story_pitch_four_grid',
  faceThreeView: 'character_face_three_view',
  productThreeView: 'product_three_view',
  serialStoryboard25: 'storyboard_25_grid',
  cinematicLightCorrection: 'cinematic_light_correction',
  characterThreeView: 'character_three_view_generation',
  sceneSettingSheet: 'scene_setting_sheet',
  frameProjection3sLater: 'image_projection_after_3s',
  frameProjection5sEarlier: 'image_projection_before_5s',
};

/** 是否该图片模型支持 quality 参数（宫格活价查询需要按模型带上正确的 params）。 */
export function imageModelSupportsQuality(apiModel: string | null | undefined): boolean {
  const normalized = String(apiModel ?? '').trim().toLowerCase();
  return (
    normalized === 'gpt-image-2'
    || normalized === 'image-2'
    || normalized === 'image-2-official'
    || normalized.includes('gpt-image')
  );
}
