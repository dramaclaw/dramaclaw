// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { PREVIZ_DROP_EPSILON, dropPositionY, dropRayOriginY } from '@/features/previz/domain/drop';

describe('dropPositionY', () => {
  it('raises the object by the gap between its bottom and the surface', () => {
    // 底面在 -1，地面在 0：整体抬 1 米，底面正好落在 0 上。
    expect(dropPositionY(0, -1, 0)).toBe(1);
  });

  it('lowers the object when its bottom is above the surface', () => {
    expect(dropPositionY(3, 2, 0)).toBe(1);
  });

  it('leaves an already-seated object where it is', () => {
    expect(dropPositionY(2, 0, 0)).toBe(2);
  });

  it('lands on a raised surface, not on the ground', () => {
    // 桌面在 0.75：命中的是桌子而不是地板时，落点必须跟着抬起来。
    expect(dropPositionY(0, -0.4, 0.75)).toBeCloseTo(1.15, 12);
  });

  it('moves by the offset instead of snapping the origin onto the surface', () => {
    // 导入的 obj 原点常在几何中心：原点在 5、底面在 4（即原点下方 1 米）。
    // 直接把 y 赋成 surfaceY 会得到 0，对象一半埋进地里——这条用例就是钉死这个区别。
    const y = dropPositionY(5, 4, 0);
    expect(y).toBe(1);
    expect(y).not.toBe(0);
  });

  it('lowers a model whose origin sits below its geometry', () => {
    // 反方向的 pivot 真实存在：壁挂搁板、吊灯、以世界原点导出的 obj——原点在地面，
    // 几何体整个悬在 2 米高。落到地面上正确答案是 -2，是个**负数**。
    // 别的用例的 currentY 全都在盒底之上，期望值全是非负，于是任何一句
    // 「别掉到地板下面」式的下限钳制（`Math.max(0, …)`）都能安然混过去。
    expect(dropPositionY(0, 2, 0)).toBe(-2);
  });

  it('is idempotent once the object has been seated', () => {
    // 第二次落地时包围盒跟着对象一起位移过了，再落一次不该有任何变化。
    // 不成立的话每帧贴地的人物会逐帧漂移。
    const boxMinY = -0.25;
    const first = dropPositionY(1.25, boxMinY, 0.5);
    expect(first).toBe(2);
    expect(dropPositionY(first, boxMinY + (first - 1.25), 0.5)).toBe(first);
  });

  it('keeps the current y when the bounding box is empty', () => {
    // 空包围盒的 min.y 是 +Infinity（max.y 是 -Infinity），两边都不能算出位移。
    expect(dropPositionY(2.5, Number.POSITIVE_INFINITY, 0)).toBe(2.5);
    expect(dropPositionY(2.5, Number.NEGATIVE_INFINITY, 0)).toBe(2.5);
    expect(dropPositionY(2.5, Number.NaN, 0)).toBe(2.5);
  });

  it('keeps the current y when the surface is not finite', () => {
    // 射线没命中却仍把 Infinity 当命中点传进来时，对象不该被甩到无穷远。
    expect(dropPositionY(2.5, -1, Number.POSITIVE_INFINITY)).toBe(2.5);
    expect(dropPositionY(2.5, -1, Number.NEGATIVE_INFINITY)).toBe(2.5);
    expect(dropPositionY(2.5, -1, Number.NaN)).toBe(2.5);
  });

  it('returns a non-finite current y unchanged instead of turning it into NaN', () => {
    // 兜底也只是「不动」：把已经坏掉的 y 换成 0 会让对象在坏帧上跳到原点。
    expect(dropPositionY(Number.NaN, -1, 0)).toBeNaN();
    expect(dropPositionY(Number.POSITIVE_INFINITY, -1, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(dropPositionY(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN)).toBeNaN();
  });
});

describe('dropRayOriginY', () => {
  it('lifts the ray origin above the top of the box', () => {
    expect(dropRayOriginY(2)).toBe(2 + PREVIZ_DROP_EPSILON);
  });

  it('lifts by more than intersection round-off yet far less than the clearance above', () => {
    // 下界：抬高要压过几何求交的浮点误差才挡得住共面。three 的 position 是 float32，
    // 十米量级上一个 ulp 就有 1e-6 米——`toBeGreaterThan(0)` 放得过 1e-9，那种抬高
    // 淹在舍入里，共面自相交会原样回来而这条照绿。
    expect(PREVIZ_DROP_EPSILON).toBeGreaterThan(1e-5);
    // 上界不是「肉眼看不见」：抬高只改射线起点，表面高度取自命中点，抬多少都不进
    // 输出。它管的是别把起点抬过压在对象上方的那个邻居，否则对象被顶到邻居身上。
    // 所以这里只夹数量级，不钉具体值——毫米量级上下都远在余隙之内。
    expect(PREVIZ_DROP_EPSILON).toBeLessThan(0.01);
  });

  it('stays non-finite for an empty box rather than becoming NaN', () => {
    // 空包围盒的 max.y 是 -Infinity。保持 -Infinity 让调用方一眼判掉，
    // 而 dropPositionY 对同一个盒子也正好是空操作，两边不会各走各的。
    expect(dropRayOriginY(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });
});
