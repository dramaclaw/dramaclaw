"""Prompts for the vision model that writes SceneBlockoutDSL programs.

The instruction reference below must stay in step with `dsl_parser._SPEC`;
`tests/test_previz_blockout_prompts.py` parses the example and checks that every
instruction and argument the parser accepts is named here.
"""

from __future__ import annotations

from novelvideo.director_world.blockout.scene_ir import MAX_COMPILED_OBJECTS

BLOCKOUT_PROMPT_VERSION = 11
MAX_DESCRIPTION_CHARS = 2000
SUGGESTED_OBJECT_COUNT = 40

BLOCKOUT_EXAMPLE_PROGRAM = """\
# 机位：正对后墙，平视，相机在房间敞开一侧的中间偏右；后墙占画面宽度约六成，fov 60，相机离后墙 6 ÷ 0.6 ÷ 1.15 ≈ 8.7 米
# 靠墙：文件柜靠左墙，在窗的远端；屏幕挂在后墙偏左；绿植靠右墙，在右后角；会议桌不靠墙，在房间中间，三把椅子在桌子靠相机的一侧；笔记本电脑放在会议桌上
# 占地：文件柜占左墙约四分之一；会议桌长占房间宽度的四成，宽占进深的两成
# 一间小会议室：后墙偏右有一扇门，左墙有一扇窗
scene.room(id="room", width=6.0, depth=5.0, height=2.8)
scene.opening(id="door", wall="room_back", kind="door", offset=4.2, width=0.9, height=2.1)
scene.opening(id="win", wall="room_left", kind="window", offset=1.5, width=1.8, height=1.3, sill=0.9)
scene.box(id="cabinet", against="room_left", offset=3.6, size=(1.2, 1.8, 0.45), semantic_type="cabinet", label="文件柜")
scene.box(id="screen", against="room_back", offset=0.7, bottom=1.0, size=(1.6, 0.9, 0.08), semantic_type="prop", label="屏幕")
scene.cylinder(id="plant", against="room_right", offset=4.2, radius=0.25, height=1.2, semantic_type="prop", label="绿植")
scene.box(id="table", position=(0.0, 0.0, 0.3), size=(2.4, 0.75, 1.0), semantic_type="table", label="会议桌")
scene.repeat(primitive="box", ids=["chair_1", "chair_2", "chair_3"], positions=[(-0.8, 0.0, -0.6), (0.0, 0.0, -0.6), (0.8, 0.0, -0.6)], size=(0.45, 0.9, 0.45), semantic_type="chair", label="椅子")
scene.box(id="laptop", on="table", shift=(0.4, 0.0), size=(0.35, 0.03, 0.25), semantic_type="prop", label="笔记本电脑")
scene.camera(id="cam", position=(0.3, 1.5, -6.2), target=(0.0, 1.0, 1.0), fov=60)
"""

# Appended to the example only when the picture check is on (see
# `build_blockout_prompt`); the numbers are read off the picture the example
# describes and agree with its camera.
BLOCKOUT_EXAMPLE_SIGHTINGS = """\
# 画面核对：后墙从画面宽度的两成到八成，墙脚在画面高度的三分之二处；会议桌从三成到六成半；文件柜从一成半到两成半
scene.seen(id="room_back", left=0.2, right=0.8, bottom=0.66)
scene.seen(id="table", left=0.32, right=0.67, bottom=0.78)
scene.seen(id="cabinet", left=0.16, right=0.26, bottom=0.7)
"""

_SIGHTING_REFERENCE = """\
画面核对：

- `scene.seen(id, left=0.2, right=0.8, bottom=0.7)`
  写下某件东西在参考图里的位置：left、right 是它左右两端离画面左边缘的距离，占画面宽度的几分之几；bottom 是它落地那条边离画面上边缘的距离，占画面高度的几分之几，可不写。画面左边缘是 0，右边缘是 1，被画面边缘切掉的一端写 0 或 1。id 可以是任何物件或墙，room 的墙叫 `<room id>_back`、`_left`、`_right`。
  这些数字是读图读出来的，不是从坐标算出来的。编译器会把你写的场景通过你写的相机投影回画面，和这里的数字对照，对不上就把差在哪里退回给你改；它是用来发现坐标、尺寸和相机互相矛盾的，所以要照图老实写，不要反过来凑坐标。

"""

_SIGHTING_STEP = """\
6. 画面核对：至少给三件东西写 scene.seen：画面里最大的一件结构（通常是后墙），离相机最近的一件大家具，离相机最远的一件大家具。直接在图上量，写占比；量完再看一眼第 3 步算的相机距离和这几个占比是否说得通。
"""

_SIGHTING_SELF_CHECK = "；scene.seen 写的是不是图上看到的位置，而不是从坐标反推的"


def _instructions(*, picture_check: bool) -> str:
    sighting_reference = _SIGHTING_REFERENCE if picture_check else ""
    sighting_step = _SIGHTING_STEP if picture_check else ""
    self_check_number = 7 if picture_check else 6
    sighting_self_check = _SIGHTING_SELF_CHECK if picture_check else ""
    example = BLOCKOUT_EXAMPLE_PROGRAM + (
        BLOCKOUT_EXAMPLE_SIGHTINGS if picture_check else ""
    )
    return f"""\
你是影视预演的场景搭建师。我给你一张场景参考图，请写一段 SceneBlockoutDSL 程序，用基础几何体搭出这个场景的白模，供导演走位和设计机位。

目标是「认得出是同一个场景，主要空间关系接近参考图」，不是测绘，也不是雕刻细节。每件东西一个整体，位置准比细节多重要。

## 坐标系

- 单位是米。
- x 向右，y 向上，z 向前。「前」指远离拍这张图的相机、往画面深处去的方向。
- 地面是 y = 0。原点放在地面上、场景中心附近。
- 拍这张图的相机在 z 为负的一侧，朝 z 增大的方向看。
- 坐标轴跟着房间走：后墙沿 x 方向，左墙和右墙沿 z 方向。斜着拍的图，房间仍然摆正，转的是相机。

## 写法

- 每行一条 `scene.<指令>(参数=值, ...)`，参数全部写成关键字形式。
- 值只能是数字、字符串、元组、列表。不允许变量、运算、import、赋值、循环、条件、函数定义。要重复就用 `scene.repeat`，或者一条条写出来。
- `scene` 已经存在，不要写 `scene = ...` 这样的开头。
- 可以用 `#` 写注释。
- 每个 id 在整份程序里只出现一次，字母开头，只含字母、数字、下划线。
- label 写这件东西的中文名，比如 "八仙桌"、"炕"、"屏风"，不超过 12 个字。它是用户在物件列表里看到的名字，每件物件都要写；同名的多件会自动编号。
- semantic_type 用小写英文单词：wall、door、window、floor、table、chair、sofa、bed、counter、cabinet、shelf、desk、bench、column、platform、stairs、ramp、car、tree；都不合适时用 prop。

## 指令

结构：

- `scene.room(id, width, depth, height, center=(x, z), wall_thickness=0.2)`
  矩形房间：一块地面加三面墙，朝相机的一面敞开。width 沿 x，depth 沿 z，center 默认 (0, 0)。
  它生成的墙叫 `<id>_back`（后墙，从左到右）、`<id>_left`（左墙，从近到远）、`<id>_right`（右墙，从近到远），开口用这些名字指向墙。
- `scene.floor(id, center=(x, z), size=(宽, 深), semantic_type="floor", label="")`
  单独一块矩形地面。室外场景、不规则空间用它。
- `scene.wall(id, start=(x, z), end=(x, z), height, thickness=0.2, semantic_type="wall", label="")`
  从 start 到 end 的一段墙，可以是斜的。
- `scene.opening(id, wall, offset, width, height, kind="door", sill=0)`
  在墙上开洞。kind 取 door、window、arch。offset 是洞口近端到墙起点（start）的距离，沿墙的方向量。sill 是洞口下沿离地高度，窗户默认 0.9。
  offset + width 不能超过墙长，sill + height 不能超过墙高。同一面墙上的洞口不能互相重叠：沿墙和竖直两个方向都有交集才算重叠，门正上方开一扇高窗是可以的，只要窗的 sill 不低于门的顶。
  墙上的门窗一律用它开洞，不要拿薄盒子贴在墙上冒充。

物件。box 和 cylinder 的位置有三种写法，每件选一种。能写关系就写关系，坐标由程序去算：

- 靠墙的物件用 against 写：
  `scene.box(id, against, offset, size=(宽, 高, 深), semantic_type, label, bottom=0, gap=0)`
  `scene.cylinder(id, against, offset, radius, height, semantic_type, label, bottom=0, gap=0)`
  against 写墙的 id。物件贴在这面墙朝房间里的那一面上，朝向跟着墙走，不用写坐标，也不能写 rotation_y。
  size 的「宽」顺着墙，「深」是从墙面往房间里伸出来的距离；cylinder 的宽就是直径。
  offset 是物件近端到墙起点的距离，和 opening 的 offset 是同一把尺：后墙从左端量起，左墙和右墙从靠相机的一端量起。offset + 宽 不能超过墙长。
  bottom 是物件底面的离地高度：立在地上的不用写；挂在墙上的画、屏幕、搁板，写它下沿的高度。gap 是物件离墙面的距离，贴着墙的不用写。
- 放在别的物件上的用 on 写：
  `scene.box(id, on, size=(宽, 高, 深), semantic_type, label, shift=(0, 0), rotation_y)`
  `scene.cylinder(id, on, radius, height, semantic_type, label, shift=(0, 0))`
  on 写下面那件的 id。物件落在它的顶面上，默认在正中间，朝向跟着它。
  shift=(dx, dz) 是相对它中心挪开的距离：dx 沿下面那件的宽、dz 沿它的深，和它的 size 同一口径（贴墙的柜台宽沿着墙，沿柜台摆就只写 dx），不能挪到顶面外面。
  下面那件必须写在这一行的上面，只能是 box 或 cylinder。
- 只有不靠墙、也不放在别的物件上的，才用 position 写坐标：
  `scene.box(id, position=(x, y, z), size=(宽, 高, 深), semantic_type, label, rotation_y=0)`
  `scene.cylinder(id, position=(x, y, z), radius, height, semantic_type, label)`
  x、z 是物件中心，**y 是物件底面的高度**，立在地上写 0。

下面三种只能用 position 写坐标：

- `scene.wedge(id, position=(x, y, z), size=(宽, 高, 深), rotation_y=0, semantic_type="ramp", label="")`
  斜坡。rotation_y = 0 时坡面朝 +z 方向升高，即越远越高。
- `scene.stairs(id, position=(x, y, z), size=(宽, 高, 深), rotation_y=0, label="")`
  楼梯，用一个斜坡表示，方向规则同 wedge。
- `scene.repeat(primitive, ids=[...], positions=[(x, y, z), ...], semantic_type, label, size=(宽, 高, 深), radius, height, rotation_y=0)`
  同一物件摆多份。primitive 取 box、cylinder、wedge；box 和 wedge 给 size，cylinder 给 radius 和 height。ids 与 positions 一一对应。

rotation_y 的单位是度，从上往下看逆时针为正。size 的「宽」在旋转前沿 x，「深」沿 z。

机位：

- `scene.camera(id, position=(x, y, z), target=(x, y, z), fov=60)`
  还原拍这张图的相机，整份程序必须有且只有一条。fov 是横向视场角，单位度。position 的 z 必须小于 target 的 z。

{sighting_reference}## 步骤

1. 先看懂布局，再动手。把结论用 `#` 注释写在程序最前面，三四行即可：
   - 机位：相机是正对后墙，还是斜着拍？斜着拍的图里，有一面墙会沿纵深往远处收拢，那是左墙或右墙，不是后墙。
     斜着拍时相机在哪一侧：画面里看得见墙面（看得见上面的窗、门、挂画）的那面侧墙，相机在它对面那一侧、朝它看，那面墙在画面里越宽，相机偏得越远；只露出一条边贴着画面边缘的侧墙，相机就贴近它。
   - 靠墙：每件大家具靠哪面墙，四选一：左墙、后墙、右墙、不靠墙。每件都要写出来。
     判断办法：家具的长边通常顺着它靠的那面墙；窗下的炕、榻、长椅，靠的是窗所在的那面墙；沿着往远处收拢的那面墙排开的东西，靠的是左墙或右墙，不是后墙。
   - 占地：每件大家具占多大一块地，用房间来量，不要凭感觉写米数。靠墙的，写它占这面墙的几分之几（通长、一半、三分之一），再写它从墙面伸进房间多远，占房间宽度或进深的几分之几；不靠墙的，写它的长和宽各占房间宽度、进深的几分之几。
     沿着视线方向的长度在图里被压短了，不要照着图上的长短写：一件东西沿着左墙或右墙从画面近处一直排到后墙，它就和这面墙一样长，哪怕它在图里只占一小段。
     炕、榻、地台、舞台这类上面还放着桌子、垫子的大平台，平台本身是一件大家具，要整块写出来；上面的桌子、垫子是放在平台上的，不要把它们摆到地上。
2. 定尺度。用图里认得出的东西估算：室内门高约 2.0 到 2.1 米，层高约 2.6 到 3.0 米，餐桌高约 0.75 米，椅面高约 0.45 米，柜台高约 1.0 到 1.1 米，成人身高约 1.7 米，轿车约长 4.5、宽 1.8、高 1.5 米。
   常见家具的占地：双人床约长 2.0、宽 1.5 米，三人沙发约长 2.0、深 0.9 米，餐桌约长 1.4、宽 0.8 米，书桌约长 1.3、宽 0.65 米，椅子约 0.45 见方，炕的进深约 1.8 到 2.2 米，炕桌约长 0.9、宽 0.6、高 0.35 米。这些只用来核对，大小先按第 1 步的占比定。
3. 定相机。从视角高低判断相机高度（平视约 1.5 到 1.7 米），从透视强弱判断 fov（手机广角约 70 到 80，普通镜头约 50 到 60，长焦约 20 到 35）。斜着拍时，position 和 target 的 x 要错开，让相机朝斜前方看。
   相机离后墙多远，不要凭感觉写。先看后墙在画面里占了画面宽度的几分之几，再算：距离 = 后墙宽 ÷ 占比 ÷ k，k 由 fov 决定：fov 30 取 0.54，40 取 0.73，fov 50 取 0.93，60 取 1.15，70 取 1.40，80 取 1.68。例如后墙宽 6 米、占画面宽度的一半、fov 60，距离 = 6 ÷ 0.5 ÷ 1.15 ≈ 10.4 米，相机的 z 就是后墙的 z 减去 10.4。把占比和算式写进最前面的机位注释。这样算出来的相机往往在房间敞开一侧的外面好几米，这是正常的：照片里能看见的通常只是房间靠里的一段，侧墙靠相机的那一头在画面外。
   相机的 x 要落在左墙和右墙之间，z 不能越过后墙：照片是在房间里面或者敞开的那一侧拍的，相机不会站在墙的外面。想斜着看，挪的是 target 的 x。
4. 搭大结构。规整的室内用 room；室外或不规则空间用 floor 加若干 wall。
5. 由大到小摆物件：
   - 一件家具只用一个几何体，取它的外轮廓。桌腿、椅背、台面不要单独摆。
   - 小摆件也摆，同样一件只用一个几何体：花瓶一个圆柱，一摞书一个盒子，挂画一个薄盒子。画框和画芯、瓶身和瓶口不要分开摆。
   - 第 1 步判断为靠墙的，一律用 against 写，墙就写第 1 步选的那一面；挂在墙上的画、屏幕也用 against，加上 bottom。
   - 大家具的宽和深，用第 1 步写的占比乘以房间的宽和深得到，再拿第 2 步的常见尺寸核对一遍。
   - 先摆完大家具，再摆小摆件。放在家具上的小摆件用 on 写，不要自己算高度。
   - 总数建议不超过 {SUGGESTED_OBJECT_COUNT} 件，硬上限是 {MAX_COMPILED_OBJECTS} 件（一面带洞口的墙会占 3 到 4 件）。
   - 沿纵深铺开：离相机近的 z 小，离相机远的 z 大，不要把东西都挤在后墙跟前。
   - 人物、动物不要摆。
{sighting_step}{self_check_number}. 自查：每件靠墙的物件，against 写的墙和第 1 步写下的是不是同一面；每件大家具的宽和深，和第 1 步写的占比对得上吗；同一面墙上的物件和洞口，offset 到 offset + 宽 的范围有没有互相重叠；用 position 写的物件，立在地上的 y 是否为 0；物件之间有没有互相穿插；主要物件是否都在相机视野里；左右有没有写反（画面左边的东西 x 为负）；相机是不是在左墙和右墙之间；相机离后墙的距离是不是按后墙的占比算出来的{sighting_self_check}。

镜头背后和被挡住的地方图里看不到，不要编造，留空即可。

## 例子

```
{example}```

例子只示范写法，尺寸和布局要按参考图来。

## 输出

只输出程序本身。不要解释，不要 markdown 围栏。
"""


def clean_description(description: str) -> str:
    """Collapse whitespace and cap the length of the user's note."""
    text = " ".join(str(description or "").split())
    return text[:MAX_DESCRIPTION_CHARS]


def build_blockout_prompt(
    *,
    description: str = "",
    image_size: tuple[int, int] | None = None,
    picture_check: bool = False,
) -> str:
    """The prompt for one picture.

    `picture_check` asks the model for `scene.seen` lines so the plausibility
    check can project the scene back onto the picture; off, the instruction is
    not mentioned at all (a program that still writes it is parsed as usual).
    """
    sections = [_instructions(picture_check=picture_check)]
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


def build_blockout_review_prompt(*, base_prompt: str, previous_program: str) -> str:
    """The render check: the model sees the picture and a render of its own scene.

    Structure first (what to add, what to drop, whether the camera and the room
    are right), then per-piece differences in picture terms, then the whole
    program again. Big rewrites are allowed on purpose: a wrong structure does
    not get fixed by nudging numbers.
    """
    return (
        f"{base_prompt}\n"
        "## 渲染核对\n\n"
        "第一张图是参考图。第二张图是把你上一次写的程序编译后、从程序里的 camera "
        "渲染出来的白模；每件东西上标着它的 id（墙和地面不标），"
        "颜色只用来区分类型，没有别的含义。\n\n"
        "上一次的程序：\n\n"
        f"```\n{previous_program.rstrip()}\n```\n\n"
        "先把两张图逐块对照，用普通文字（不要用代码块）列出最多 12 条最明显的差别，"
        "按影响从大到小排。先答三个问题："
        "(a) 参考图里有、渲染图里没有的结构和大件是什么"
        "（比如楼层、廊台、隔墙、台阶、柱子、大家具），要新增；"
        "(b) 渲染图里有、参考图里没有或明显多余的是什么，要删掉；"
        "(c) 相机离场景的远近、高度、俯仰、fov 和房间的宽深高对不对。"
        "然后再逐件写：是哪件东西（写 id）还是相机；"
        "参考图里它在什么位置、多大（用画面占比说，比如「桌子左端在画面两成处、"
        "桌面在画面高度七成处」）；渲染图里它在哪、多大；要把哪个数值改成多少。"
        "允许大改：结构不对就重写结构，不要只微调数字。\n\n"
        "然后按改正后的样子重新输出完整的程序，不要只输出改动的部分，放在一个代码块里。\n"
    )
