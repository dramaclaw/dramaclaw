// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { v4 as uuidv4 } from 'uuid';

import { clampToRange, RAD_TO_DEG, type PrevizRange } from './camera';
import { evaluateSceneAt } from './evaluate';
import {
  PREVIZ_FPS,
  PREVIZ_MAX_DURATION_FRAMES,
  PREVIZ_MIN_DURATION_FRAMES,
  type PrevizPathPoint,
  type PrevizScene,
  type Vec3,
} from './scene';

/**
 * 「在视口按住左键连续画一条轨迹」的纯数学部分：平滑 → 等距重采样 → 按弧长分配时间。
 * 引擎层只负责把屏幕坐标打到一个水平面上，拿到一串世界坐标点之后就全交给这里，所以整条
 * 管线在 jsdom 里测得动。
 */

/**
 * 轨迹点间距，单位米。照抄参照实现的「轨迹设置 → 轨迹点间距」（默认 1 m，0.05–5）。
 * 下界 0.05 不是随手取的：手绘笔画每帧一个采样点，间距再小就等于不重采样，一条两米
 * 的轨迹能出四十个关键帧，时间轴上挤成一团没法点。
 */
export const PREVIZ_PATH_SPACING_M: PrevizRange = { min: 0.05, max: 5, default: 1 };

/**
 * 画笔速度，米/秒：一笔轨迹在时间轴上占多久由它和这一笔的长度一起定出来（见
 * [strokeDurationFrames]）。
 *
 * 必须是可调的，不能写死一个系数。同一条 12 米的轨迹，人物散步走过去是 8 秒多，
 * 汽车开过去不到 1 秒——写死之后总有一头需要画完再回时间轴上手动改长度，而那正是
 * 这个功能要省掉的一步。
 *
 * 默认 1.4 是成年人正常步行的速度（约 5 km/h）：预演台里画得最多的就是人物走位。
 * 上界 20 m/s（72 km/h）留给车辆与快速推轨，下界 0.1 m/s 留给慢摇。
 */
export const PREVIZ_PATH_SPEED_MPS: PrevizRange = { min: 0.1, max: 20, default: 1.4 };

/** 默认平滑轮数。三轮之后手抖基本没了，再多就开始削掉用户真的画出来的转角。 */
export const PREVIZ_SMOOTH_PASSES = 3;

/**
 * 一笔轨迹该画在多高的水平面上：被画的那个对象在当前帧**看得见的**高度。
 *
 * 绘制是把二维笔画打到一个水平面上，整笔共用一个高度。钉死在地面上的话，给 4 米高的
 * 机位画一条走位，画完机位就掉到地上了——用户得回头逐个轨迹点把它抬回去，而轨迹点
 * 可能有几十个。
 *
 * 取解算后的高度而不是静态 transform：重画一条已有的轨迹是常事，那时对象正沿着旧轨迹
 * 飞在半空，静态 transform 停留在它出生的位置，而那个高度用户早就不记得了。
 *
 * 没选中对象、或选中的对象刚被删掉，都退回地面：这一笔本来也无处可去，但抛异常会让
 * 整个画布罢工。
 */
export function drawPlaneHeight(
  scene: PrevizScene,
  objectId: string | null,
  frame: number,
): number {
  if (!objectId) return 0;
  return evaluateSceneAt(scene, frame).get(objectId)?.position[1] ?? 0;
}

/**
 * 机位画轨迹时，这一笔的起手朝向；人物返回 null，表示照旧完全按笔画切线来。
 *
 * 人物直接用切线就对了——人走路就是朝行进方向走。机位不行：切线只给得出 yaw，机位
 * 原来的俯角会被一起抹平，而且推轨镜头多半不是正对着车头，而是偏着一个角度盯住被
 * 摄体。所以机位交出整份朝向，由 [pathPointSeeds] 把俯仰横滚原样留住，再让 yaw
 * **跟着切线一起转**（见那里的说明）。
 *
 * 和 [drawPlaneHeight] 一样取解算后的值：重画已有轨迹时机位正按旧轨迹转着，静态
 * transform 停在它出生时的朝向。
 */
export function drawSeedRotation(
  scene: PrevizScene,
  objectId: string | null,
  frame: number,
): Vec3 | null {
  if (!objectId) return null;
  const object = scene.objects.find((entry) => entry.id === objectId);
  if (object?.kind !== 'camera') return null;
  const evaluated = evaluateSceneAt(scene, frame).get(objectId);
  return [...(evaluated?.rotation ?? object.transform.rotation)];
}

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

/** 折线的总弧长，单位米。少于两个点就是 0。 */
export function polylineLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

/**
 * 这一笔该占多少帧：长度 ÷ 速度，再换算成帧。
 *
 * 之前画完一律铺满时间轴，于是画多长都是同样的时长，长的轨迹只是走得更快——一条
 * 30 米的走位和一条 2 米的走位在时间轴上一样长，而用户想表达的恰恰是「这段路要走
 * 很久」。按长度定时长之后，画笔本身就是节奏。
 *
 * 收进 `[PREVIZ_MIN_DURATION_FRAMES, PREVIZ_MAX_DURATION_FRAMES]`：上界是场景时长
 * 自己的上界，超出去的片段一部分永远落在时间轴外面，既播不到也剪不着；下界挡住
 * 0 帧片段，那样的片段 `frameToU` 无解、时间轴上也点不中。
 *
 * 传进来的应当是**重采样之后**的点列，也就是真正成为关键帧的那些点：用户手绘的原始
 * 笔画每帧一个采样点，手抖会把弧长撑长，同一条路画慢一点就会变长。
 */
export function strokeDurationFrames(points: readonly Vec3[], speedMps: number): number {
  const speed = clampToRange(speedMps, PREVIZ_PATH_SPEED_MPS);
  const frames = Math.round((polylineLength(points) / speed) * PREVIZ_FPS);
  // 非有限值（上游漏了护栏的 NaN 坐标）走这条分支，别把 NaN 写进场景。
  if (!Number.isFinite(frames) || frames < PREVIZ_MIN_DURATION_FRAMES) {
    return PREVIZ_MIN_DURATION_FRAMES;
  }
  return Math.min(PREVIZ_MAX_DURATION_FRAMES, frames);
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
 * 把角度收进 `[-180, 180)`。
 *
 * 切线朝向出自 `atan2`，本来就落在这个区间；机位的 yaw 却存在 `[0, 360)`
 * （见 `normalizeYawDeg`）。两者相加会一路越界，而轨迹点检查器上那三根角度滑杆只到
 * ±180——越界的点在面板上就调不动了。
 */
function wrapYawDeg(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

/**
 * 点列 → 轨迹点。u 按**累计弧长**分配而不是按序号等分：实测参照实现一笔得到的关键帧是
 * 0/40/45/56/67/78/89/101/111/120，等分给不出这种分布。等分的实际后果是匀速笔画在
 * 长段上突然加速——重采样后段长大体相等，但笔画首尾那两段总是不齐的。
 *
 * `seedRotation` 非空（机位，见 [drawSeedRotation]）时，朝向按「相对行进方向的夹角」
 * 铺开：俯仰与横滚原样留住（切线给不出），yaw 取起手那一刻的 yaw 加上这一点的切线相
 * 对**首段**切线转过的角度。也就是说，画的时候镜头偏着行进方向多少度，全程就偏着多少
 * 度——轨迹一拐弯，画面跟着摇过去。
 *
 * 两个都不选是不行的：整条轨迹共用一个绝对朝向，机位会一路盯死一个方向，轨迹拐了它
 * 也不摇；纯切线又等于把摄影机焊在轨道车头上，起手的取景角度和俯角当场就没了。
 *
 * 要让机位真的盯死一个方向（比如全程对着门口）也还做得到：把首个轨迹点的朝向手调一
 * 次，`resolvePathRotations` 会把它传播到后面所有点。想全程对准某个对象，则用片段上
 * 的「看向」。
 *
 * 每个点各拿一份朝向拷贝，共享同一个数组的话，在检查器里调一个轨迹点的朝向会让整条
 * 轨迹一起转。
 */
export function pathPointSeeds(
  positions: readonly Vec3[],
  seedRotation?: Vec3 | null,
): PrevizPathPoint[] {
  if (positions.length === 0) return [];
  if (positions.length === 1) {
    return [
      {
        id: uuidv4(),
        u: 0,
        position: [...positions[0]],
        rotation: seedRotation ? [...seedRotation] : [0, 0, 0],
      },
    ];
  }

  const cumulative: number[] = [0];
  for (let i = 1; i < positions.length; i++) {
    cumulative.push(cumulative[i - 1] + distance(positions[i - 1], positions[i]));
  }
  const total = cumulative[cumulative.length - 1];
  // 首段切线就是「行进方向」的起量处：机位的起手 yaw 相对它偏多少，全程就偏多少。
  const baseYaw = tangentYawDeg(positions[0], positions[1]);

  return positions.map((position, index) => {
    // 末点没有下一个点可求切线，沿用上一段的朝向——掉回 0 的话人物走到终点会突然转向 -Z。
    const yaw =
      index < positions.length - 1
        ? tangentYawDeg(position, positions[index + 1])
        : tangentYawDeg(positions[index - 1], position);
    const rotation: Vec3 = seedRotation
      ? [seedRotation[0], wrapYawDeg(seedRotation[1] + yaw - baseYaw), seedRotation[2]]
      : [0, yaw, 0];
    return {
      id: uuidv4(),
      // 整笔长度为 0（点一下没拖）时全部落在 0，而不是 0/0 = NaN。
      u: total > 0 ? cumulative[index] / total : 0,
      position: [...position] as Vec3,
      rotation,
    };
  });
}
