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
  'resize',
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
  'cutHere',
  'live',
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

const CUT_KEYS = ['camera'] as const;

const AUDIO_CLIP_KEYS = ['source', 'offset', 'relocate'] as const;

const PROGRAM_KEYS = ['title', 'cutTo', 'empty', 'noRoom', 'limit', 'noCamera'] as const;

const AUDIO_KEYS = [
  'title',
  'add',
  'local',
  'upstream',
  'noUpstream',
  'uploading',
  'badExtension',
  'tooLarge',
  'noRoom',
  'limit',
  'uploadFailed',
  'noProject',
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

/**
 * 创建人物对话框。字段标签（体型、身高、基础姿势、姿态微调）刻意不在这张表里：
 * 那几栏与属性面板问的是同一件事，复用 `previz.inspector.*`——同一个字段在两处叫
 * 两个名字，用户会以为它们是两回事。
 */
const CHARACTER_CREATE_KEYS = [
  'title',
  'pickHint',
  'pickHintAgain',
  'preview',
  'name',
  'color',
  'customColor',
  'poseValue',
  'awaitPreview',
  'awaitFields',
  'spot',
  'spotLabel',
  'create',
  'cancel',
] as const;

/** 入场遮罩：标题、两个阶段（`PrevizBootPhase`）、超时撤场的提示。 */
const BOOT_KEYS = ['title', 'chunk', 'assets', 'slow'] as const;

/**
 * 属性面板里两张按联合类型排的小表。逐条写死而不是从 `BodyType` / `HeightPolicy` 取：
 * 跟着被测对象一起变的期望值等于没有期望值，而少一条的表现是下拉框里那一项显示成
 * 原始 key——选得中，读不出是什么。
 */
const INSPECTOR_BODY_TYPES = ['capsule', 'slim', 'average', 'heavy', 'tall'] as const;
const INSPECTOR_HEIGHT_POLICIES = ['follow', 'ground', 'plane'] as const;
/** Y 被策略接管时那行说明，两档各一句：`follow` 档不置灰，所以没有第三条。 */
const INSPECTOR_HEIGHT_NOTES = ['ground', 'plane'] as const;

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
    it(`${name} carries every boot overlay key`, () => {
      expect(Object.keys(bundle.previz.boot).sort()).toEqual([...BOOT_KEYS].sort());
    });

    it(`${name} carries every timeline key`, () => {
      expect(Object.keys(bundle.previz.timeline).sort()).toEqual([...TIMELINE_KEYS].sort());
    });

    it(`${name} carries every clip key`, () => {
      const { point, closeup, cut, audio, ...rest } = bundle.previz.clip;
      expect(Object.keys(rest).sort()).toEqual([...CLIP_KEYS].sort());
      expect(Object.keys(point).sort()).toEqual([...POINT_KEYS].sort());
      const { part, ...closeupRest } = closeup;
      expect(Object.keys(closeupRest).sort()).toEqual([...CLOSEUP_KEYS].sort());
      expect(Object.keys(part).sort()).toEqual([...CLOSEUP_PART_KEYS].sort());
      expect(Object.keys(cut).sort()).toEqual([...CUT_KEYS].sort());
      expect(Object.keys(audio).sort()).toEqual([...AUDIO_CLIP_KEYS].sort());
    });

    it(`${name} carries every camera create key`, () => {
      const { bodies, lenses, focalClasses, depthOfField, ...rest } = bundle.previz.cameraCreate;
      expect(Object.keys(rest).sort()).toEqual([...CAMERA_CREATE_KEYS].sort());
      expect(Object.keys(bodies).sort()).toEqual([...CAMERA_CREATE_TABLES.bodies].sort());
      expect(Object.keys(lenses).sort()).toEqual([...CAMERA_CREATE_TABLES.lenses].sort());
      expect(Object.keys(focalClasses).sort()).toEqual([...CAMERA_CREATE_TABLES.focalClasses].sort());
      expect(Object.keys(depthOfField).sort()).toEqual([...CAMERA_CREATE_TABLES.depthOfField].sort());
    });

    it(`${name} carries every character create key`, () => {
      expect(Object.keys(bundle.previz.characterCreate).sort()).toEqual(
        [...CHARACTER_CREATE_KEYS].sort(),
      );
    });

    it(`${name} carries every body type and height policy label`, () => {
      const inspector = bundle.previz.inspector;
      expect(Object.keys(inspector.bodyTypes).sort()).toEqual([...INSPECTOR_BODY_TYPES].sort());
      expect(Object.keys(inspector.heightPolicies).sort()).toEqual(
        [...INSPECTOR_HEIGHT_POLICIES].sort(),
      );
      expect(Object.keys(inspector.heightNote).sort()).toEqual([...INSPECTOR_HEIGHT_NOTES].sort());
      // 移动辅助那两个开关的文案挂在 `previz.inspector` 下：创建对话框与属性面板两处
      // 都要用，同一个开关在两处叫两个名字，用户会以为它们是两回事。
      for (const key of [
        'heightPolicy',
        'planeY',
        'moveAssist',
        'moveAssistNote',
        'avoidCollision',
        'stayInBounds',
      ] as const) {
        expect(inspector[key], key).toBeTruthy();
      }
    });

    // 视口顶上那条 HUD 已经拆开：摆场景的工具进了左侧菜单列（`previz.toolbar`），
    // 撤销重做、显示模式、切视角与聚焦浮回视口两角（`previz.viewport`）。这里钉的是
    // 拆完之后两边都齐全，而不是拆没了。
    it(`${name} carries every toolbar group and mode key`, () => {
      const toolbar = bundle.previz.toolbar;
      expect(Object.keys(toolbar.group).sort()).toEqual(['create', 'tool', 'gizmo'].sort());
      expect(Object.keys(toolbar.tool).sort()).toEqual(['draw', 'mark', 'navigate', 'select']);
      expect(Object.keys(toolbar.gizmo).sort()).toEqual(['rotate', 'scale', 'translate']);
      for (const key of ['collapseTimeline', 'expandTimeline', 'markHint'] as const) {
        expect(toolbar[key], key).toBeTruthy();
      }
    });

    it(`${name} carries every viewport control key`, () => {
      const viewport = bundle.previz.viewport;
      expect(Object.keys(viewport.group).sort()).toEqual(
        ['axis', 'display', 'draw', 'view'].sort(),
      );
      expect(Object.keys(viewport.display).sort()).toEqual(['clay', 'solid', 'translucent']);
      // 六个方向是坐标轴小球那六颗球的名字，少一个就是一颗点不出名字的球。
      expect(Object.keys(viewport.view).sort()).toEqual(
        ['front', 'back', 'left', 'right', 'top', 'bottom'].sort(),
      );
      expect(Object.keys(viewport.quad).sort()).toEqual(['camera', 'side', 'top']);
      for (const key of [
        'resetView',
        'pathSpacing',
        'pathSpeed',
        'axis',
        'focus',
        'focusHint',
        'quadView',
        'quadNoCamera',
      ] as const) {
        expect(viewport[key], key).toBeTruthy();
      }
    });
  }

  it('translates every key in both languages', () => {
    // 两边 key 集合一致才算翻完；少一个的表现是英文界面上蹦出一行原始 key。
    expect(Object.keys(en.previz).sort()).toEqual(Object.keys(zh.previz).sort());
  });
});

describe('previz program and audio locale', () => {
  for (const [name, bundle] of [
    ['zh', zh],
    ['en', en],
  ] as const) {
    it(`${name} carries the program and audio keys`, () => {
      expect(Object.keys(bundle.previz.program).sort()).toEqual([...PROGRAM_KEYS].sort());
      expect(Object.keys(bundle.previz.audio).sort()).toEqual([...AUDIO_KEYS].sort());
      expect(bundle.previz.monitor).toHaveProperty('follow');
      expect(bundle.previz.monitor).toHaveProperty('following');
      expect(bundle.previz.node).toHaveProperty('audioSummary');
      expect(bundle.previz.editor.record).toHaveProperty('noAudioMix');
      // 撤销重做从视口两角搬进了顶栏，键也跟着搬；漏搬的表现是顶栏上两颗按钮的
      // 无障碍名字变成原始 key。
      for (const key of ['undo', 'redo'] as const) {
        expect(bundle.previz.editor[key], key).toBeTruthy();
      }
      // 上传失败要把后端原话带出来，占位符不能丢。
      expect(bundle.previz.audio.uploadFailed).toContain('{{message}}');
      expect(bundle.previz.node.audioSummary).toContain('{{count}}');
    });
  }
});
