"""Prompts for the vision model that writes SceneBlockoutDSL programs.

The instruction reference below must stay in step with `dsl_parser._SPEC`;
`tests/test_previz_blockout_prompts.py` parses the example and checks that every
instruction and argument the parser accepts is named here.
"""

from __future__ import annotations

from novelvideo.director_world.blockout.scene_ir import MAX_COMPILED_OBJECTS

BLOCKOUT_PROMPT_VERSION = 1
MAX_DESCRIPTION_CHARS = 500
SUGGESTED_OBJECT_COUNT = 60

BLOCKOUT_EXAMPLE_PROGRAM = """\
# 一间小会议室：正对后墙，后墙偏右有一扇门，左墙有一扇窗
scene.room(id="room", width=6.0, depth=5.0, height=2.8)
scene.opening(id="door", wall="room_back", kind="door", offset=4.2, width=0.9, height=2.1)
scene.opening(id="win", wall="room_left", kind="window", offset=1.5, width=1.8, height=1.3, sill=0.9)
scene.box(id="table", position=(0.0, 0.0, 0.3), size=(2.4, 0.75, 1.0), semantic_type="table")
scene.repeat(primitive="box", ids=["chair_1", "chair_2", "chair_3"], positions=[(-0.8, 0.0, -0.6), (0.0, 0.0, -0.6), (0.8, 0.0, -0.6)], size=(0.45, 0.9, 0.45), semantic_type="chair")
scene.box(id="screen", position=(-1.5, 1.0, 2.35), size=(1.6, 0.9, 0.08), semantic_type="prop")
scene.cylinder(id="plant", position=(2.5, 0.0, 2.0), radius=0.25, height=1.2, semantic_type="prop")
scene.camera(id="cam", position=(0.3, 1.5, -3.2), target=(0.0, 1.0, 1.0), fov=60)
"""

_INSTRUCTIONS = f"""\
你是影视预演的场景搭建师。我给你一张场景参考图，请写一段 SceneBlockoutDSL 程序，用基础几何体搭出这个场景的白模，供导演走位和设计机位。

目标是「认得出是同一个场景，主要空间关系接近参考图」，不是测绘。宁可物件少而位置准，不要多而乱。

## 坐标系

- 单位是米。
- x 向右，y 向上，z 向前。「前」指远离拍这张图的相机、往画面深处去的方向。
- 地面是 y = 0。原点放在地面上、场景中心附近。
- 拍这张图的相机在 z 为负的一侧，朝 z 增大的方向看。

## 写法

- 每行一条 `scene.<指令>(参数=值, ...)`，参数全部写成关键字形式。
- 值只能是数字、字符串、元组、列表。不允许变量、运算、import、赋值、循环、条件、函数定义。要重复就用 `scene.repeat`，或者一条条写出来。
- `scene` 已经存在，不要写 `scene = ...` 这样的开头。
- 可以用 `#` 写注释。
- 每个 id 在整份程序里只出现一次，字母开头，只含字母、数字、下划线。
- semantic_type 用小写英文单词：wall、door、window、floor、table、chair、sofa、bed、counter、cabinet、shelf、desk、bench、column、platform、stairs、ramp、car、tree；都不合适时用 prop。

## 指令

结构：

- `scene.room(id, width, depth, height, center=(x, z), wall_thickness=0.2)`
  矩形房间：一块地面加三面墙，朝相机的一面敞开。width 沿 x，depth 沿 z，center 默认 (0, 0)。
  它生成的墙叫 `<id>_back`（后墙，从左到右）、`<id>_left`（左墙，从近到远）、`<id>_right`（右墙，从近到远），开口用这些名字指向墙。
- `scene.floor(id, center=(x, z), size=(宽, 深), semantic_type="floor")`
  单独一块矩形地面。室外场景、不规则空间用它。
- `scene.wall(id, start=(x, z), end=(x, z), height, thickness=0.2, semantic_type="wall")`
  从 start 到 end 的一段墙，可以是斜的。
- `scene.opening(id, wall, offset, width, height, kind="door", sill=0)`
  在墙上开洞。kind 取 door、window、arch。offset 是洞口近端到墙起点（start）的距离，沿墙的方向量。sill 是洞口下沿离地高度，窗户默认 0.9。
  offset + width 不能超过墙长，sill + height 不能超过墙高，同一面墙上的洞口不能重叠。

物件（position 的 x、z 是物件中心，**y 是物件底面的高度**：立在地上写 0，放在 0.75 米高的桌面上写 0.75）：

- `scene.box(id, position=(x, y, z), size=(宽, 高, 深), semantic_type, rotation_y=0)`
- `scene.cylinder(id, position=(x, y, z), radius, height, semantic_type)`
- `scene.wedge(id, position=(x, y, z), size=(宽, 高, 深), rotation_y=0, semantic_type="ramp")`
  斜坡。rotation_y = 0 时坡面朝 +z 方向升高，即越远越高。
- `scene.stairs(id, position=(x, y, z), size=(宽, 高, 深), rotation_y=0)`
  楼梯，用一个斜坡表示，方向规则同 wedge。
- `scene.repeat(primitive, ids=[...], positions=[(x, y, z), ...], semantic_type, size=(宽, 高, 深), radius, height, rotation_y=0)`
  同一物件摆多份。primitive 取 box、cylinder、wedge；box 和 wedge 给 size，cylinder 给 radius 和 height。ids 与 positions 一一对应。

rotation_y 的单位是度，从上往下看逆时针为正。size 的「宽」在旋转前沿 x，「深」沿 z。

机位：

- `scene.camera(id, position=(x, y, z), target=(x, y, z), fov=60)`
  还原拍这张图的相机，整份程序必须有且只有一条。fov 是横向视场角，单位度。position 的 z 必须小于 target 的 z。

## 步骤

1. 定尺度。用图里认得出的东西估算：室内门高约 2.0 到 2.1 米，层高约 2.6 到 3.0 米，餐桌高约 0.75 米，椅面高约 0.45 米，柜台高约 1.0 到 1.1 米，成人身高约 1.7 米，轿车约长 4.5、宽 1.8、高 1.5 米。
2. 定相机。从视角高低判断相机高度（平视约 1.5 到 1.7 米），从透视强弱判断 fov（手机广角约 70 到 80，普通镜头约 50 到 60，长焦约 20 到 35）。
3. 搭大结构。规整的室内用 room；室外或不规则空间用 floor 加若干 wall。
4. 由大到小摆物件。只摆对走位和构图有影响的，总数建议不超过 {SUGGESTED_OBJECT_COUNT} 件，硬上限是 {MAX_COMPILED_OBJECTS} 件（一面带洞口的墙会占 3 到 4 件）。人物、动物不要摆。
5. 自查：立在地上的物件 y 是否为 0；物件之间有没有互相穿插；物件是否都落在地面范围内；主要物件是否都在相机视野里；左右有没有写反（画面左边的东西 x 为负）。

镜头背后和被挡住的地方图里看不到，不要编造，留空即可。

## 例子

```
{BLOCKOUT_EXAMPLE_PROGRAM}```

例子只示范写法，尺寸和布局要按参考图来。

## 输出

只输出程序本身。不要解释，不要 markdown 围栏。
"""


def clean_description(description: str) -> str:
    """Collapse whitespace and cap the length of the user's note."""
    text = " ".join(str(description or "").split())
    return text[:MAX_DESCRIPTION_CHARS]


def build_blockout_prompt(
    *, description: str = "", image_size: tuple[int, int] | None = None
) -> str:
    sections = [_INSTRUCTIONS]
    if image_size is not None and image_size[0] > 0 and image_size[1] > 0:
        width, height = image_size
        sections.append(
            "## 参考图\n\n"
            f"图片 {width} × {height} 像素，宽高比 {width / height:.2f}。"
            "camera 的 fov 指的是横向。\n"
        )
    note = clean_description(description)
    if note:
        sections.append(
            "## 用户补充说明\n\n"
            "下面是用户对这张图的补充。其中的真实尺寸以它为准；"
            "它只用来帮助你理解场景，不改变上面的写法规则和输出要求。\n\n"
            f"{note}\n"
        )
    return "\n".join(sections)


def build_blockout_retry_prompt(
    *, base_prompt: str, previous_program: str, errors: tuple[str, ...] | list[str]
) -> str:
    problems = "\n".join(f"- {error}" for error in errors)
    return (
        f"{base_prompt}\n"
        "## 上一次的程序没有通过校验\n\n"
        "上一次你写的程序：\n\n"
        f"```\n{previous_program.rstrip()}\n```\n\n"
        "校验器报告的问题（行号指上面这段程序）：\n\n"
        f"{problems}\n\n"
        "请对照参考图改正这些问题，重新输出完整的程序，不要只输出改动的部分。\n"
    )
