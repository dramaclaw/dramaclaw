// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { PREVIZ_APERTURE, PREVIZ_FOCAL_MM, clampToRange, type PrevizRange } from './camera';
import { PREVIZ_HEIGHT_CM_RANGE, PREVIZ_OBJECT_BASE_NAME } from './objects';
import { PREVIZ_DEFAULT_POSE_ID } from './poses';

/** 预演台里所有三元组的统一形状，顺序恒为 [x, y, z]，单位米 / 度。 */
export type Vec3 = [number, number, number];

export const PREVIZ_SCHEMA_VERSION = 1;
export const PREVIZ_FPS = 30;
export const PREVIZ_MIN_DURATION_FRAMES = 1;
export const PREVIZ_MAX_DURATION_FRAMES = 360;
export const PREVIZ_DEFAULT_DURATION_FRAMES = 120;

/**
 * 灯光强度区间，属性面板的滑杆与 parseScene 的夹取共用同一份边界。强度必须非负：
 * 负值在 three 里等于从场景里反向减光，画面会出现无解的黑块。上限取 10 是为了让滑杆
 * 整条行程都有用——P1 没有任何东西要把灯推到 10 倍以上，真存了更大值的场景是少数，
 * 夹回来是老实的做法；反过来做一条四分之三行程都用不到的滑杆，是天天都在的别扭。
 */
export const PREVIZ_INTENSITY_RANGE = { min: 0, max: 10, default: 1 } as const;

/**
 * 缩放分量区间。为 0 会压出退化几何（法线全零、包围盒没厚度），手柄跟着抓不住；
 * 负值翻转面朝向、打乱光照，而 P1 没有镜像需求。两头都挡在正区间内。
 *
 * 下界取 1e-4 而不是「刚好不退化」：`assetFormat` 收了 'obj'，而 OBJ 不带单位元数据，
 * 一个按毫米建模的道具进到米制场景就得靠 0.001 才对得上——夹在 0.01 的后果不是报错，
 * 是每次重新读场景都把它悄悄放大十倍。1e-4 离退化仍然很远：1 单位的网格缩到 0.1 mm，
 * float32 还剩六七位有效数字，法线与包围盒都照常算得出来。
 * 上界 100 挡的是另一回事——不是单位换算，是拖坏的手柄：包围盒是取景距离
 * （`view.ts` 的 `boundsRadius` / `framingDistance`）的输入，一个失控的大值会把镜头推到
 * 看不见场景的地方。220 cm 的人物放大 100 倍已是 220 m，超过任何预演场景的尺度，
 * 再大只可能是错值。两头不对称是故意的：下界服务导入时的单位换算，上界服务交互里的
 * 失控值，本来就是两件事，没有理由取成对称区间。
 */
export const PREVIZ_SCALE_RANGE = { min: 1e-4, max: 100, default: 1 } as const;

/**
 * 姿势微调三轴的区间，单位度，零点是基础姿势本身。取值不是拍的：照抄参照实现那三条
 * 滑杆（见 `output/previz-research/REPORT.md`「创建人物对话框」一节的属性表：
 * 前倾 -30..45 / 转身 -60..60 / 侧倾 -35..35）。这三个角分别是髋部弯曲、躯干扭转、
 * 侧向倾斜，超出区间的值木偶做不出来，只会把关节拧穿——`lean: 1e9` 不产生 NaN，
 * 但它渲染出来是个绕着自己转了两百万圈的人。三条区间各不对称也是照抄的：
 * 人向前屈得比向后仰得多。
 */
export const PREVIZ_POSE_ADJUST_RANGE: Readonly<
  Record<keyof PrevizCharacter['poseAdjust'], PrevizRange>
> = {
  pitch: { min: -30, max: 45, default: 0 },
  turn: { min: -60, max: 60, default: 0 },
  lean: { min: -35, max: 35, default: 0 },
};

export type BodyType = 'slim' | 'average' | 'heavy';
export type DisplayMode = 'solid' | 'translucent' | 'clay';
export type OutputAspect = '16:9' | '9:16' | '1:1' | '4:3';
export type RigMotion = 'static' | 'orbit' | 'push' | 'pull';

/**
 * 特写片段挂在被跟踪对象身上的哪一处。比例见 `domain/closeup.ts`——那里是几何，
 * 这里只声明有哪几处。
 */
export type RigAnchorPart = 'pelvis' | 'body' | 'chest' | 'face' | 'head';

/**
 * 水平角是从哪儿量起的。`front` 从被跟踪对象的正面量（人一转身机位跟着转到他脸前），
 * `custom` 从世界坐标量（人怎么转机位都停在同一个方位）。
 */
export type RigBearing = 'front' | 'custom';

export interface PrevizTransform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export interface PrevizObjectBase {
  id: string;
  name: string;
  transform: PrevizTransform;
  visible: boolean;
  locked: boolean;
}

export interface PrevizCharacter extends PrevizObjectBase {
  kind: 'character';
  bodyType: BodyType;
  heightCm: number;
  /**
   * 刻意留成 string 而不是 PrevizPoseId：新版客户端存进来的姿势要原样活过一次
   * 读写，静默改写成默认姿势是无声的数据损坏。认不出的 id 现在没有任何消费者——
   * `basePoseId` 出了这份 schema 还没人读——所以「读不出来怎么办」是 Task 3 接引擎
   * 时才需要回答的问题（viewer-kit 的 `requirePoseName` 给的答案是抛异常，不是回落）。
   * 那是渲染层的决定，读取层不该提前替它把数据改掉。
   */
  basePoseId: string;
  poseAdjust: { pitch: number; turn: number; lean: number };
}

export interface PrevizCamera extends PrevizObjectBase {
  kind: 'camera';
  focalMm: number;
  aperture: number;
  sensor: 'ff' | 's35';
  /**
   * 机身与镜头系列只是标签：视场角由焦距与 `sensor` 算出来，这两个字段一个像素都不改。
   * 存下来是因为用户在创建对话框里挑过它们——不存的话重开面板看到的是默认值而不是
   * 自己的选择，那两个 stepper 就成了摆设。
   */
  cameraBody: 'cine' | 'virtual' | 'handheld';
  lensSeries: 'prime' | 'zoom' | 'anamorphic';
}

export interface PrevizLight extends PrevizObjectBase {
  kind: 'light';
  lightType: 'key' | 'point' | 'spot';
  color: string;
  intensity: number;
}

export interface PrevizProp extends PrevizObjectBase {
  kind: 'prop';
  assetUrl: string;
  assetFormat: 'glb' | 'gltf' | 'obj';
}

export type PrevizObject = PrevizCharacter | PrevizCamera | PrevizLight | PrevizProp;

/** 派生自 PrevizObject 的 kind 字面量集合，避免和四个具体类型的 `kind` 字段维护两份真相。 */
export type PrevizObjectKind = PrevizObject['kind'];

/** 路径点的 u 是片段内归一化参数；rotationEdited 标记用户显式改过朝向的点。 */
export interface PrevizPathPoint {
  id: string;
  u: number;
  position: Vec3;
  rotation: Vec3;
  rotationEdited?: boolean;
}

export interface PrevizPathClip {
  id: string;
  kind: 'path';
  startFrame: number;
  endFrame: number;
  points: PrevizPathPoint[];
  /**
   * 沿路走的时候始终看向谁。null / 缺省表示照常沿切线自动朝向。
   *
   * 可选而不是必填：`parseScene` 把片段原样透传，老场景里根本没有这个字段，
   * 写成必填就是在类型上撒谎。
   */
  aimObjectId?: string | null;
}

export interface PrevizActionClip {
  id: string;
  kind: 'action';
  startFrame: number;
  endFrame: number;
  poseId: string;
}

/**
 * 特写片段：机位不自己走位，而是由「跟着谁、离多远、从哪个方位看」反推出来。
 *
 * 跟踪目标存的是**对象** id 而不是对方那条路径片段的 id：片段会被剃刀切成两半、
 * 会被删掉重画，而「这台机位在拍谁」不该跟着断。新建时从目标片段抄一份起止帧，
 * 之后两者各走各的。
 */
export interface PrevizRigClip {
  id: string;
  kind: 'rig';
  startFrame: number;
  endFrame: number;
  anchorObjectId: string;
  anchorPart: RigAnchorPart;
  /** 看向谁。null 表示不接管朝向，机位保持自己的角度。 */
  aimObjectId: string | null;
  /** 水平角，单位度，起量处由 `bearing` 决定。 */
  azimuth: number;
  /** 俯仰，单位度，正值表示机位在锚点之上俯拍。 */
  elevation: number;
  /** 机位到锚点的球面距离，单位米。 */
  distance: number;
  /** 在锚点之上再抬多少，单位米。抬的是机位，不是视线落点。 */
  height: number;
  bearing: RigBearing;
  motion: RigMotion;
}

export type PrevizClip = PrevizPathClip | PrevizActionClip | PrevizRigClip;

export interface PrevizTrack {
  id: string;
  objectId: string;
  clips: PrevizClip[];
}

export interface PrevizSceneSettings {
  fps: typeof PREVIZ_FPS;
  durationFrames: number;
  displayMode: DisplayMode;
  /** 场景级单一画幅，全部机位共用——见设计文档「场景数据结构」一节的取舍说明。 */
  outputAspect: OutputAspect;
}

export interface PrevizScene {
  schemaVersion: typeof PREVIZ_SCHEMA_VERSION;
  settings: PrevizSceneSettings;
  objects: PrevizObject[];
  timeline: { tracks: PrevizTrack[] };
}

/** 卡片上不打开编辑器就能看到规模的摘要，随场景一起写回 node.data。 */
export interface PrevizNodeSummary {
  objectCount: number;
  durationFrames: number;
}

export function createDefaultScene(): PrevizScene {
  return {
    schemaVersion: PREVIZ_SCHEMA_VERSION,
    settings: {
      fps: PREVIZ_FPS,
      durationFrames: PREVIZ_DEFAULT_DURATION_FRAMES,
      displayMode: 'solid',
      outputAspect: '16:9',
    },
    objects: [],
    timeline: { tracks: [] },
  };
}

/** 场景版本高于本实现时抛出；调用方据此提示「版本过新」而不是做有损降级。 */
export class PrevizSceneVersionError extends Error {
  readonly schemaVersion: number;

  constructor(schemaVersion: number) {
    super(`previz scene schemaVersion ${schemaVersion} is newer than ${PREVIZ_SCHEMA_VERSION}`);
    this.name = 'PrevizSceneVersionError';
    this.schemaVersion = schemaVersion;
  }
}

function clampDuration(value: unknown): number {
  const frames =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.round(value)
      : PREVIZ_DEFAULT_DURATION_FRAMES;
  return Math.min(PREVIZ_MAX_DURATION_FRAMES, Math.max(PREVIZ_MIN_DURATION_FRAMES, frames));
}

/**
 * 枚举白名单一律写成 Record 而不是数组：Record 的键必须覆盖联合类型的全部成员，
 * 往 `assetFormat` 加了 'fbx' 却忘了改这里，编译期就红；数组只查得出「多写」，
 * 查不出「漏写」，而漏写的后果是 parseObject 把已经落盘的新值静默改回默认值。
 */
const DISPLAY_MODES: Record<DisplayMode, true> = { solid: true, translucent: true, clay: true };
const OUTPUT_ASPECTS: Record<OutputAspect, true> = {
  '16:9': true,
  '9:16': true,
  '1:1': true,
  '4:3': true,
};
const OBJECT_KINDS: Record<PrevizObjectKind, true> = {
  character: true,
  camera: true,
  light: true,
  prop: true,
};
const BODY_TYPES: Record<BodyType, true> = { slim: true, average: true, heavy: true };
const LIGHT_TYPES: Record<PrevizLight['lightType'], true> = { key: true, point: true, spot: true };
const SENSORS: Record<PrevizCamera['sensor'], true> = { ff: true, s35: true };
const CAMERA_BODIES: Record<PrevizCamera['cameraBody'], true> = {
  cine: true,
  virtual: true,
  handheld: true,
};
const LENS_SERIES: Record<PrevizCamera['lensSeries'], true> = {
  prime: true,
  zoom: true,
  anamorphic: true,
};
const ASSET_FORMATS: Record<PrevizProp['assetFormat'], true> = { glb: true, gltf: true, obj: true };

function isMember<T extends string>(table: Record<T, true>, value: unknown): value is T {
  // hasOwnProperty 而不是 `in`：`in` 会把 'constructor' 这类原型链上的键也认成合法值。
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(table, value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 夹取本身不在这里实现，一律走 camera.ts 的 `clampToRange`：domain 层只留一份夹取
 * 语义，两处各写一遍迟早会对非有限输入给出不同答案。这个包装只补上 `clampToRange`
 * 没有的那一层——它收 number，而 parseScene 拿到的是 unknown。非数字与非有限值一样
 * 落到 `range.default`（不是落到边界值）：NaN 更可能是上游算错了或输入框空着，
 * 把它夹成 min 等于替用户做了个他没提过的选择。
 */
function clampRange(value: unknown, range: PrevizRange): number {
  return typeof value === 'number' ? clampToRange(value, range) : range.default;
}

function vec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  return [num(value[0], fallback[0]), num(value[1], fallback[1]), num(value[2], fallback[2])];
}

function scaleVec3(value: unknown): Vec3 {
  const fallback = PREVIZ_SCALE_RANGE.default;
  const raw = vec3(value, [fallback, fallback, fallback]);
  return [
    clampRange(raw[0], PREVIZ_SCALE_RANGE),
    clampRange(raw[1], PREVIZ_SCALE_RANGE),
    clampRange(raw[2], PREVIZ_SCALE_RANGE),
  ];
}

/** 三轴各自夹回 `PREVIZ_POSE_ADJUST_RANGE`：越界的角度不会算出 NaN，只会拧穿关节。 */
function parsePoseAdjust(value: unknown): PrevizCharacter['poseAdjust'] {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    pitch: clampRange(source.pitch, PREVIZ_POSE_ADJUST_RANGE.pitch),
    turn: clampRange(source.turn, PREVIZ_POSE_ADJUST_RANGE.turn),
    lean: clampRange(source.lean, PREVIZ_POSE_ADJUST_RANGE.lean),
  };
}

function parseTransform(value: unknown): PrevizTransform {
  const source = (value ?? {}) as Partial<PrevizTransform>;
  return {
    position: vec3(source.position, [0, 0, 0]),
    rotation: vec3(source.rotation, [0, 0, 0]),
    scale: scaleVec3(source.scale),
  };
}

/**
 * 把一条不可信的对象记录读成 `PrevizObject`。**只有三种情况返回 null**：记录本身不是
 * 对象、没有可用的 id（缺失、不是字符串，或者是空串）、kind 不认识——这三样都没法修，
 * 留着只会在场景图同步时变成幽灵条目（空串 id 尤其毒：`nodes` 那张按 id 索引的 Map 会
 * 让所有空 id 的对象互相覆盖成同一个节点）。其余字段一律就地修复回默认值或夹回合法
 * 区间：用户手改坏一个数字，不该让整个人物凭空消失，但也不能让 `focalMm: 0` 这种值把
 * three 的投影矩阵算成 NaN。
 *
 * 导出是给 store 的 `normalizeObject` 用的：改完一条记录就地复校一次，不必为此拼一份
 * 只装它一个的临时场景。**它保证的只到「这一条记录自身合法」为止**——id 去重、悬空轨道
 * 清理这些跨对象的一致性都在 `parseScene` 里，不在这里。所以读一整份不可信场景仍然一律
 * 走 `parseScene`：拿 `raw.objects.map(parseObject)` 代替它会把重复 id 原样放行，而 store
 * 与场景图都按 id 索引对象，表现是「图层面板里有它，选中却改到了另一个」。
 */
export function parseObject(raw: unknown): PrevizObject | null {
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const id = typeof source.id === 'string' && source.id.length > 0 ? source.id : null;
  if (!id) return null;
  if (!isMember(OBJECT_KINDS, source.kind)) return null;
  const kind = source.kind;

  const base = {
    id,
    // 名字空着或缺失都回落到类型基名：图层面板要按名字列条目，空串是一行看不见的
    // 东西，uuid 则是一串对用户没有意义的字符。代价是这个回落值不唯一——四个都没名字
    // 的机位会一起解析成「机位」，图层面板上就是四行同名条目。选中与改属性都按 id 走，
    // 重名只影响可读性，不会让操作落到另一个对象上；真要唯一就得在读取时按顺序补编号，
    // 那等于读一遍改一次数据，比重名更难交代。
    name:
      typeof source.name === 'string' && source.name.trim().length > 0
        ? source.name
        : PREVIZ_OBJECT_BASE_NAME[kind],
    transform: parseTransform(source.transform),
    // 缺字段时按「可见、未锁定」兜底：反过来兜会让读进来的场景整个是空的，
    // 用户看到的是「我的东西全没了」而不是「有一项属性没读出来」。
    visible: source.visible !== false,
    locked: source.locked === true,
  };

  switch (kind) {
    case 'character':
      return {
        ...base,
        kind: 'character',
        bodyType: isMember(BODY_TYPES, source.bodyType) ? source.bodyType : 'average',
        heightCm: clampRange(source.heightCm, PREVIZ_HEIGHT_CM_RANGE),
        basePoseId:
          typeof source.basePoseId === 'string' ? source.basePoseId : PREVIZ_DEFAULT_POSE_ID,
        poseAdjust: parsePoseAdjust(source.poseAdjust),
      };
    case 'camera':
      return {
        ...base,
        kind: 'camera',
        focalMm: clampRange(source.focalMm, PREVIZ_FOCAL_MM),
        aperture: clampRange(source.aperture, PREVIZ_APERTURE),
        sensor: isMember(SENSORS, source.sensor) ? source.sensor : 'ff',
        cameraBody: isMember(CAMERA_BODIES, source.cameraBody) ? source.cameraBody : 'cine',
        lensSeries: isMember(LENS_SERIES, source.lensSeries) ? source.lensSeries : 'prime',
      };
    case 'light':
      return {
        ...base,
        kind: 'light',
        lightType: isMember(LIGHT_TYPES, source.lightType) ? source.lightType : 'key',
        color: typeof source.color === 'string' ? source.color : '#ffffff',
        intensity: clampRange(source.intensity, PREVIZ_INTENSITY_RANGE),
      };
    case 'prop':
      return {
        ...base,
        kind: 'prop',
        assetUrl: typeof source.assetUrl === 'string' ? source.assetUrl : '',
        assetFormat: isMember(ASSET_FORMATS, source.assetFormat) ? source.assetFormat : 'glb',
      };
  }
}

function parseTracks(raw: unknown, objectIds: ReadonlySet<string>): PrevizTrack[] {
  if (!Array.isArray(raw)) return [];
  const tracks: PrevizTrack[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const source = entry as Partial<PrevizTrack>;
    if (typeof source.id !== 'string' || typeof source.objectId !== 'string') continue;
    // 悬空轨道直接丢：求值器（P3）拿到指向已删对象的轨道只会报错或静默出错。
    if (!objectIds.has(source.objectId)) continue;
    tracks.push({
      id: source.id,
      objectId: source.objectId,
      // clips 只做浅拷贝，片段内部原样透传：片段校验是 P3 求值器落地时的事，
      // 现在没有任何代码读它，提前写一遍只会和那时的真实需求对不上。
      clips: Array.isArray(source.clips) ? [...source.clips] : [],
    });
  }
  return tracks;
}

/**
 * 把 node.data.scene 这类不可信 JSON 读成 PrevizScene：缺字段或非法枚举回落默认值，
 * 版本过新抛 PrevizSceneVersionError。对象逐条校验（见 parseObject），认不出 kind 或
 * 没有 id 的丢弃，其余字段就地修复；轨道指向已不存在的对象时一并丢弃。
 */
export function parseScene(raw: unknown): PrevizScene {
  if (raw === null || typeof raw !== 'object') return createDefaultScene();

  const source = raw as Partial<PrevizScene>;
  const version =
    typeof source.schemaVersion === 'number' ? source.schemaVersion : PREVIZ_SCHEMA_VERSION;
  if (version > PREVIZ_SCHEMA_VERSION) throw new PrevizSceneVersionError(version);

  const fallback = createDefaultScene();
  const settings = (source.settings ?? {}) as Partial<PrevizSceneSettings>;

  const objects: PrevizObject[] = [];
  const objectIds = new Set<string>();
  for (const entry of Array.isArray(source.objects) ? source.objects : []) {
    const object = parseObject(entry);
    // 同 id 的第二条直接丢（先到者留下）：场景图与 store 都按 id 取对象，留着等于让
    // 两条记录互相覆盖，表现是「图层面板里有它，选中却改到了另一个」。
    if (!object || objectIds.has(object.id)) continue;
    objectIds.add(object.id);
    objects.push(object);
  }

  return {
    schemaVersion: PREVIZ_SCHEMA_VERSION,
    settings: {
      fps: PREVIZ_FPS,
      durationFrames: clampDuration(settings.durationFrames),
      displayMode: isMember(DISPLAY_MODES, settings.displayMode)
        ? settings.displayMode
        : fallback.settings.displayMode,
      outputAspect: isMember(OUTPUT_ASPECTS, settings.outputAspect)
        ? settings.outputAspect
        : fallback.settings.outputAspect,
    },
    objects,
    timeline: { tracks: parseTracks(source.timeline?.tracks, objectIds) },
  };
}
