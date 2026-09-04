// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import en from '../../../public/locales/en/translation.json';
import zh from '../../../public/locales/zh/translation.json';

/** 每个 key 都写成字面量：跟着被测文件一起变的期望值等于没有期望值。 */
const TIMELINE_KEYS = [
  'play',
  'pause',
  'stop',
  'prevFrame',
  'nextFrame',
  'goToStart',
  'goToEnd',
  'playhead',
  'rate',
  'duration',
  'razor',
  'pinTrack',
  'removeTrack',
  'expandTrack',
  'collapseTrack',
  'motionPath',
  'prevKeyframe',
  'insertKeyframe',
  'nextKeyframe',
  'clearPath',
  'trimStart',
  'trimEnd',
  'clipLabel',
  'closeupLabel',
  'addCloseup',
  'closeupTarget',
  'appendClip',
  'zoomIn',
  'zoomOut',
  'zoomFit',
  'addObject',
  'empty',
  'emptyHint',
  'emptyNoObjects',
  'emptyNoObjectsHint',
  'createCharacter',
  'createCamera',
] as const;

const CLIP_KEYS = [
  'empty',
  'startFrame',
  'endFrame',
  'aim',
  'aimNone',
  'aimHintFree',
  'aimHintLocked',
  'trimStart',
  'trimEnd',
  'insertPoint',
  'clearPoints',
  'remove',
  'slider',
] as const;

const POINT_KEYS = [
  'section',
  'frame',
  'position',
  'deselect',
  'empty',
  'x',
  'y',
  'z',
  'pitch',
  'yaw',
  'roll',
  'reface',
  'remove',
] as const;

/** 特写片段的取景面板。`part` 是嵌套的一张小表，与平铺的键分开比。 */
const CLOSEUP_KEYS = [
  'sectionTracking',
  'sectionFraming',
  'sectionMotion',
  'target',
  'anchor',
  'aim',
  'aimTrack',
  'aimFree',
  'bearing',
  'bearing_front',
  'bearing_custom',
  'azimuth',
  'elevation',
  'distance',
  'height',
  'motion',
  'motion_static',
  'motion_orbit',
  'motion_push',
  'motion_pull',
  'bake',
] as const;

const CLOSEUP_PART_KEYS = ['pelvis', 'body', 'chest', 'face', 'head'] as const;

/** 摄影机创建对话框。嵌套的四张小表单列，与顶层平铺的键分开比。 */
const CAMERA_CREATE_KEYS = [
  'title',
  'close',
  'previewLabel',
  'dragHint',
  'previewCaption',
  'properties',
  'body',
  'bodyPrev',
  'bodyNext',
  'lens',
  'lensPrev',
  'lensNext',
  'focal',
  'focalDown',
  'focalUp',
  'aperture',
  'apertureDown',
  'apertureUp',
  'sensor',
  'position',
  'viewReadout',
  'viewReadoutLabel',
  'yaw',
  'yawSlider',
  'yawInput',
  'pitch',
  'pitchSlider',
  'pitchInput',
  'roll',
  'rollSlider',
  'rollInput',
  'footerHint',
  'submit',
] as const;

/** 这四张表的键各自等于一个联合类型：少一个的表现是界面上直接蹦出原始 key。 */
const CAMERA_CREATE_TABLES = {
  bodies: ['cine', 'virtual', 'handheld'],
  lenses: ['prime', 'zoom', 'anamorphic'],
  focalClasses: ['ultrawide', 'wide', 'standard', 'teleShort', 'tele'],
  depthOfField: ['shallow', 'standard', 'deep'],
} as const;

describe('previz P3 locale keys', () => {
  for (const [name, bundle] of [
    ['zh', zh],
    ['en', en],
  ] as const) {
    it(`${name} carries every timeline key`, () => {
      expect(Object.keys(bundle.previz.timeline).sort()).toEqual([...TIMELINE_KEYS].sort());
    });

    it(`${name} carries every clip key`, () => {
      const { point, closeup, ...rest } = bundle.previz.clip;
      expect(Object.keys(rest).sort()).toEqual([...CLIP_KEYS].sort());
      expect(Object.keys(point).sort()).toEqual([...POINT_KEYS].sort());
      const { part, ...closeupRest } = closeup;
      expect(Object.keys(closeupRest).sort()).toEqual([...CLOSEUP_KEYS].sort());
      expect(Object.keys(part).sort()).toEqual([...CLOSEUP_PART_KEYS].sort());
    });

    it(`${name} carries every camera create key`, () => {
      const { bodies, lenses, focalClasses, depthOfField, ...rest } = bundle.previz.cameraCreate;
      expect(Object.keys(rest).sort()).toEqual([...CAMERA_CREATE_KEYS].sort());
      expect(Object.keys(bodies).sort()).toEqual([...CAMERA_CREATE_TABLES.bodies].sort());
      expect(Object.keys(lenses).sort()).toEqual([...CAMERA_CREATE_TABLES.lenses].sort());
      expect(Object.keys(focalClasses).sort()).toEqual([...CAMERA_CREATE_TABLES.focalClasses].sort());
      expect(Object.keys(depthOfField).sort()).toEqual([...CAMERA_CREATE_TABLES.depthOfField].sort());
    });

    it(`${name} carries the new hud keys`, () => {
      expect(bundle.previz.hud.group.tool).toBeTruthy();
      expect(Object.keys(bundle.previz.hud.tool).sort()).toEqual(['draw', 'select']);
      expect(bundle.previz.hud.pathSpacing).toBeTruthy();
    });
  }

  it('translates every key in both languages', () => {
    // 两边 key 集合一致才算翻完；少一个的表现是英文界面上蹦出一行原始 key。
    expect(Object.keys(en.previz).sort()).toEqual(Object.keys(zh.previz).sort());
  });
});
