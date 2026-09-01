// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { v4 as uuidv4 } from 'uuid';

import { RAD_TO_DEG, type PrevizRange } from './camera';
import type { PrevizPathPoint, Vec3 } from './scene';

/**
 * 「在视口按住左键连续画一条轨迹」的纯数学部分：平滑 → 等距重采样 → 按弧长分配时间。
 * 引擎层只负责把屏幕坐标打到地面上，拿到一串世界坐标点之后就全交给这里，所以整条
 * 管线在 jsdom 里测得动。
 */

/**
 * 轨迹点间距，单位米。照抄参照实现的「轨迹设置 → 轨迹点间距」（默认 1 m，0.05–5）。
 * 下界 0.05 不是随手取的：手绘笔画每帧一个采样点，间距再小就等于不重采样，一条两米
 * 的轨迹能出四十个关键帧，时间轴上挤成一团没法点。
 */
export const PREVIZ_PATH_SPACING_M: PrevizRange = { min: 0.05, max: 5, default: 1 };

/** 默认平滑轮数。三轮之后手抖基本没了，再多就开始削掉用户真的画出来的转角。 */
export const PREVIZ_SMOOTH_PASSES = 3;

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * 三点移动平均，跑若干轮，**两端固定**。端点是用户按下与松开的位置，平滑把它们挪走
 * 的话轨迹的起终点就对不上手感了。
 */
export function smoothStroke(stroke: readonly Vec3[], passes = PREVIZ_SMOOTH_PASSES): Vec3[] {
  let current = stroke.map((point) => [...point] as Vec3);
  if (current.length < 3) return current;

  for (let pass = 0; pass < passes; pass++) {
    const next = current.map((point) => [...point] as Vec3);
    for (let i = 1; i < current.length - 1; i++) {
      for (let axis = 0; axis < 3; axis++) {
        next[i][axis] = (current[i - 1][axis] + current[i][axis] + current[i + 1][axis]) / 3;
      }
    }
    current = next;
  }
  return current;
}

/**
 * 按弧长等距重采样。
 *
 * `carried` 是「上一段走完还差多少才凑够一个间距」。少了它，每段都从零起算，折线的每个
 * 拐点都会多挤出一个点——手绘笔画有几百段，出来的就不是等距点列而是原笔画。
 */
export function resampleByDistance(stroke: readonly Vec3[], spacing: number): Vec3[] {
  if (stroke.length === 0) return [];
  const step = Math.max(PREVIZ_PATH_SPACING_M.min, spacing);
  const out: Vec3[] = [[...stroke[0]]];
  let carried = 0;

  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1];
    const b = stroke[i];
    const segment = distance(a, b);
    if (segment <= 0) continue;

    let travelled = step - carried;
    while (travelled <= segment) {
      out.push(lerpVec3(a, b, travelled / segment));
      travelled += step;
    }
    carried = segment - (travelled - step);
  }

  // 末点必须落在笔画终点：松手的地方就是轨迹尽头。差得远就补一个点，差得近就把最后
  // 那个点挪过去（免得末尾出现一对贴在一起的关键帧）。
  const last = stroke[stroke.length - 1];
  const tail = distance(out[out.length - 1], last);
  if (tail > 0) {
    if (out.length === 1 || tail > step / 2) out.push([...last]);
    else out[out.length - 1] = [...last];
  }
  return out;
}

/**
 * 由一段位移推水平朝向，单位度。
 *
 * three 的对象在 rotation 全零时朝 **-Z**（`domain/objects.ts` 里机位的默认朝向注释是
 * 同一条约定）：R_y(θ)·(0,0,-1) = (-sinθ, 0, -cosθ)。要让它朝向 (dx, dz)，解出
 * θ = atan2(-dx, -dz)。写成常见的 atan2(dx, dz) 会让人物背朝行进方向走。
 */
export function tangentYawDeg(from: Vec3, to: Vec3): number {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  if (dx === 0 && dz === 0) return 0;
  return Math.atan2(-dx, -dz) * RAD_TO_DEG;
}

/**
 * 点列 → 轨迹点。u 按**累计弧长**分配而不是按序号等分：实测参照实现一笔得到的关键帧是
 * 0/40/45/56/67/78/89/101/111/120，等分给不出这种分布。等分的实际后果是匀速笔画在
 * 长段上突然加速——重采样后段长大体相等，但笔画首尾那两段总是不齐的。
 */
export function pathPointSeeds(positions: readonly Vec3[]): PrevizPathPoint[] {
  if (positions.length === 0) return [];
  if (positions.length === 1) {
    return [{ id: uuidv4(), u: 0, position: [...positions[0]], rotation: [0, 0, 0] }];
  }

  const cumulative: number[] = [0];
  for (let i = 1; i < positions.length; i++) {
    cumulative.push(cumulative[i - 1] + distance(positions[i - 1], positions[i]));
  }
  const total = cumulative[cumulative.length - 1];

  return positions.map((position, index) => {
    // 末点没有下一个点可求切线，沿用上一段的朝向——掉回 0 的话人物走到终点会突然转向 -Z。
    const yaw =
      index < positions.length - 1
        ? tangentYawDeg(position, positions[index + 1])
        : tangentYawDeg(positions[index - 1], position);
    return {
      id: uuidv4(),
      // 整笔长度为 0（点一下没拖）时全部落在 0，而不是 0/0 = NaN。
      u: total > 0 ? cumulative[index] / total : 0,
      position: [...position] as Vec3,
      rotation: [0, yaw, 0] as Vec3,
    };
  });
}
