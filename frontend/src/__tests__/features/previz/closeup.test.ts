// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  PREVIZ_RIG_ANCHOR_FRACTION,
  PREVIZ_RIG_DISTANCE_RANGE,
  PREVIZ_RIG_ORBIT_DEG,
  PREVIZ_RIG_PULL_RATIO,
  PREVIZ_RIG_PUSH_RATIO,
  anchorHeightM,
  lookAtEulerDeg,
  rigAnchorPoint,
  rigCameraPosition,
  rigFramingAt,
} from '@/features/previz/domain/closeup';
import { createPrevizObject } from '@/features/previz/domain/objects';
import type { PrevizRigClip } from '@/features/previz/domain/scene';

function rigClip(patch: Partial<PrevizRigClip> = {}): PrevizRigClip {
  return {
    id: 'rig',
    kind: 'rig',
    startFrame: 0,
    endFrame: 120,
    anchorObjectId: 'anchor',
    anchorPart: 'face',
    aimObjectId: 'anchor',
    azimuth: 0,
    elevation: 0,
    distance: 3,
    height: 0,
    bearing: 'custom',
    motion: 'static',
    ...patch,
  };
}

describe('rig anchor', () => {
  it('orders the body parts bottom to top, all inside the body', () => {
    const { pelvis, body, chest, face, head } = PREVIZ_RIG_ANCHOR_FRACTION;
    expect(pelvis).toBeLessThan(body);
    expect(body).toBeLessThan(chest);
    expect(chest).toBeLessThan(face);
    expect(face).toBeLessThan(head);
    // 全部落在身体之内：超过 1 的比例会把「头部」特写架到人物头顶的空气里。
    for (const fraction of Object.values(PREVIZ_RIG_ANCHOR_FRACTION)) {
      expect(fraction).toBeGreaterThan(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
  });

  it('lifts the anchor off the ground by a share of the body height', () => {
    expect(rigAnchorPoint([1, 0, -2], 1.8, 'face')).toEqual([
      1,
      1.8 * PREVIZ_RIG_ANCHOR_FRACTION.face,
      -2,
    ]);
  });

  it('keeps the anchor at the origin for a body with no height', () => {
    // 机位、灯、道具没有身高可分。硬套人物比例只会把特写架到道具原点上方一米处。
    expect(rigAnchorPoint([0, 1, 0], 0, 'head')).toEqual([0, 1, 0]);
  });

  it('reads the body height in metres, scale included', () => {
    const character = createPrevizObject('character', []);
    character.heightCm = 180;
    expect(anchorHeightM(character)).toBeCloseTo(1.8, 6);

    // 缩放是渲染出来的实际高度的一部分：只看 heightCm 的话，放大一倍的人物
    // 特写会卡在他胸口。
    character.transform.scale = [1, 2, 1];
    expect(anchorHeightM(character)).toBeCloseTo(3.6, 6);

    expect(anchorHeightM(createPrevizObject('camera', []))).toBe(0);
  });
});

describe('rigCameraPosition', () => {
  it('puts the camera in front of the anchor at azimuth zero', () => {
    // 零朝向的对象面朝 -Z（全局约定），「正面」就是 -Z 那一侧。
    const at = rigCameraPosition([0, 1.6, 0], 0, rigClip(), 0);
    expect(at[0]).toBeCloseTo(0, 6);
    expect(at[1]).toBeCloseTo(1.6, 6);
    expect(at[2]).toBeCloseTo(-3, 6);
  });

  it('swings the camera around the anchor with the azimuth', () => {
    const at = rigCameraPosition([0, 0, 0], 0, rigClip({ azimuth: 90 }), 0);
    expect(at[0]).toBeCloseTo(-3, 6);
    expect(at[2]).toBeCloseTo(0, 6);
  });

  it('follows the anchor around when the bearing is its front', () => {
    // 人物转过身，「正面」跟着转到 +Z 一侧——不跟的话人一转身镜头就拍到后脑勺。
    const at = rigCameraPosition([0, 0, 0], 180, rigClip({ bearing: 'front' }), 0);
    expect(at[2]).toBeCloseTo(3, 6);
  });

  it('ignores where the anchor faces when the bearing is a world angle', () => {
    const at = rigCameraPosition([0, 0, 0], 180, rigClip({ bearing: 'custom' }), 0);
    expect(at[2]).toBeCloseTo(-3, 6);
  });

  it('lifts the camera with the elevation and shortens its reach', () => {
    const at = rigCameraPosition([0, 0, 0], 0, rigClip({ elevation: 30 }), 0);
    expect(at[1]).toBeCloseTo(3 * Math.sin(Math.PI / 6), 6);
    // 距离是球面半径，不是水平半径：仰角抬起来的同时水平距离要收，否则「距离 3」
    // 在俯角 60° 时实际离了 6 米。
    expect(Math.hypot(at[0], at[2])).toBeCloseTo(3 * Math.cos(Math.PI / 6), 6);
  });

  it('adds the height offset on top of the anchor', () => {
    const at = rigCameraPosition([0, 1, 0], 0, rigClip({ height: 0.5 }), 0);
    expect(at[1]).toBeCloseTo(1.5, 6);
  });
});

describe('rigFramingAt', () => {
  it('holds the framing still for a static shot', () => {
    const clip = rigClip();
    expect(rigFramingAt(clip, 0)).toEqual(rigFramingAt(clip, 1));
  });

  it('carries the azimuth a full turn around for an orbit', () => {
    const clip = rigClip({ motion: 'orbit', azimuth: 10 });
    expect(rigFramingAt(clip, 0).azimuth).toBeCloseTo(10, 6);
    expect(rigFramingAt(clip, 0.5).azimuth).toBeCloseTo(10 + PREVIZ_RIG_ORBIT_DEG / 2, 6);
  });

  it('closes in on a push and backs off on a pull', () => {
    expect(rigFramingAt(rigClip({ motion: 'push' }), 1).distance).toBeCloseTo(
      3 * PREVIZ_RIG_PUSH_RATIO,
      6,
    );
    expect(rigFramingAt(rigClip({ motion: 'pull' }), 1).distance).toBeCloseTo(
      3 * PREVIZ_RIG_PULL_RATIO,
      6,
    );
  });

  it('never lets a push run the camera through the anchor', () => {
    // 距离夹在下界之上：推到 0 的话机位穿进人物身体里，画面是一片模型内壁。
    const at = rigFramingAt(rigClip({ distance: PREVIZ_RIG_DISTANCE_RANGE.min, motion: 'push' }), 1);
    expect(at.distance).toBeGreaterThanOrEqual(PREVIZ_RIG_DISTANCE_RANGE.min);
  });
});

describe('lookAtEulerDeg', () => {
  it('leaves a camera already facing -Z at zero', () => {
    expect(lookAtEulerDeg([0, 0, 3], [0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('turns to face the target', () => {
    const [pitch, yaw, roll] = lookAtEulerDeg([3, 0, 0], [0, 0, 0]);
    expect(pitch).toBeCloseTo(0, 6);
    expect(yaw).toBeCloseTo(90, 6);
    expect(roll).toBe(0);
  });

  it('tips down to a target below it', () => {
    const [pitch] = lookAtEulerDeg([0, 3, 3], [0, 0, 3]);
    expect(pitch).toBeCloseTo(-90, 6);
  });

  it('keeps the horizon level', () => {
    // 横滚恒为 0。摄影机绕视线轴翻转在预演里没有来源，算出个非零值只会是数值噪声。
    expect(lookAtEulerDeg([1, 2, 3], [-4, 5, -6])[2]).toBe(0);
  });

  it('gives a usable angle when the camera sits on its target', () => {
    // 距离被拖到 0 时视线是零向量。返回 NaN 会一路流进节点的 rotation，
    // 症状是机位凭空消失，病因隔着五层。
    expect(lookAtEulerDeg([2, 1, 2], [2, 1, 2])).toEqual([0, 0, 0]);
  });
});
