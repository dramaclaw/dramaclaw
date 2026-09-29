"""逐帧拉片：把一段参考视频的镜头语言反编译成可复用的「运镜素材」。

## 它和画布全局镜头语言的区别

`shotMetadataStore` 里那套 `ShotMetadata` 是**作者意图**——我想把片子拍成什么样。
拉片产出的是**反编译结果**——这段参考片实际是怎么拍的。两者不是同一层东西：
素材跟着视频走，挂到哪个生成节点上，就由它给那个节点供镜头语言；没挂的仍用全局默认。

## 为什么归纳这一步必须做

逐帧分析出来的是每个关键帧一条记录（`run_freezone_analyze_shots` 已经在产，字段
和 `ShotMetadata` 一一对应）。但二十条逐帧记录不是「素材」——素材得能一句话回答
「这片子是什么镜头语言」。所以要在逐帧之上再收一层：统计主导景别、主导运镜、
基调与色调，把长尾噪声压掉。

统计而不是让模型再总结一遍，是因为：逐帧结果已经是模型输出，再套一层模型
只会引入新的漂移，而众数统计是确定性的、可解释的、零成本的。
"""

from __future__ import annotations

from collections import Counter
from typing import Any, Iterable

# 与前端 shotMetadataStore.ShotMetadata 对齐的字段。
# 顺序即优先级：前两个是「镜头怎么拍」，后两个是「画面什么气质」。
LENS_FIELDS = ("shot_type", "angle", "camera_movement")
MOOD_FIELDS = ("mood", "color_tone")

# 主导项的入选门槛：占比低于它的一律不算「主导」，避免把一次性的镜头
# 当成整片风格。1/4 是经验值——四个镜头里出现一次才算有代表性。
DOMINANT_MIN_RATIO = 0.25

# 最多保留几个主导项。取三是因为再多就不叫「主导」了，
# 拼进提示词也只会互相稀释。
DOMINANT_MAX = 3


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _dominant(values: Iterable[str], *, total: int) -> list[str]:
    """按出现频次取主导项，低于门槛的丢掉。

    返回列表而不是单值：一段片子完全可能「近景为主、间以特写」，
    硬压成一个值会丢掉真实的镜头节奏。
    """
    counter = Counter(value for value in values if value)
    if not counter or total <= 0:
        return []
    picked = [
        value
        for value, count in counter.most_common(DOMINANT_MAX)
        if count / total >= DOMINANT_MIN_RATIO
    ]
    # 一个都没过门槛说明分布极其平均，那就退回出现最多的那个，
    # 不要返回空——空的素材对下游毫无用处。
    return picked or [counter.most_common(1)[0][0]]


def summarize_shot_analyses(analyses: list[dict[str, Any]]) -> dict[str, Any]:
    """把逐帧分析收敛成一份运镜素材摘要。"""
    rows = [row for row in analyses if isinstance(row, dict)]
    total = len(rows)
    summary: dict[str, Any] = {"shot_count": total}
    for field in (*LENS_FIELDS, *MOOD_FIELDS):
        summary[field] = _dominant((_clean(row.get(field)) for row in rows), total=total)
    return summary


def build_lens_material(
    *,
    analyses: list[dict[str, Any]],
    frame_urls: list[str],
    source_url: str | None = None,
    duration_sec: float | None = None,
) -> dict[str, Any]:
    """组装「运镜素材」。

    同时保留**逐镜明细**和**整片摘要**：摘要用来一眼看懂和喂提示词，
    明细用来让用户挑其中某几个镜头单独复用——只留摘要就等于把反编译的结果
    又压回了一句话，那还不如不拆。
    """
    rows = [row for row in analyses if isinstance(row, dict)]
    shots: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        shot: dict[str, Any] = {"index": index}
        if index < len(frame_urls):
            shot["keyframe_url"] = frame_urls[index]
        for field in (*LENS_FIELDS, *MOOD_FIELDS, "subject_action", "suggested_prompt"):
            value = _clean(row.get(field))
            if value:
                shot[field] = value
        shots.append(shot)

    return {
        "schema": "shot_breakdown.v1",
        "kind": "lens_material",
        "source_url": source_url,
        "duration_sec": duration_sec,
        "summary": summarize_shot_analyses(rows),
        "shots": shots,
    }


def lens_material_to_prompt(material: dict[str, Any]) -> str:
    """把运镜素材拼成可以追加进生成提示词的一段中文。

    和 `renderShotMetadataForPrompt` 同一口径——都是「标签：值」的形式，
    这样素材供的镜头语言和用户手选的在提示词里长得一样，模型不会区别对待。
    """
    summary = material.get("summary") or {}
    labels = {
        "shot_type": "景别",
        "angle": "镜头角度",
        "camera_movement": "运镜",
        "mood": "氛围",
        "color_tone": "色调",
    }
    parts: list[str] = []
    for field, label in labels.items():
        values = summary.get(field) or []
        if isinstance(values, str):
            values = [values]
        values = [value for value in values if value]
        if values:
            parts.append(f"{label}：{'、'.join(values)}")
    return "；".join(parts)


# ============================================================
# v2：把拉片结果落成「可以直接再用的素材」
#
# 实测 LibTV 的逐帧拉片（见 docs 里的拆解）之后改的。它和我们 v1 最大的差别
# 不在分析质量，在**产物形态**：我们出的是一份喂提示词的摘要，它出的是用户
# 拿来就能用的素材件——按镜头切出来的首尾帧、剪好的片段、分离出的音轨。
#
# 所以这一层不替换 `build_lens_material`（结构化摘要是它没有、值得留的东西），
# 而是在它旁边再长出一组「素材描述」，由 runner 落成画布节点。
# ============================================================

#: 拆解维度。和 LibTV 的 `dimensions` 取同一批 key，便于以后对齐埋点和排错。
DIMENSION_STORYBOARD = "storyboard"
DIMENSION_CAMERA_MOVES = "cameraMoves"
DIMENSION_MUSIC_REF = "musicRef"
ALL_DIMENSIONS = (DIMENSION_STORYBOARD, DIMENSION_CAMERA_MOVES, DIMENSION_MUSIC_REF)

#: 任务跑完之前，已经产好的分组推在 `task.metadata` 的这个 key 下。
#: 前后端共用一个常量，省得哪天改名只改一边。
STREAMED_GROUPS_KEY = "shot_breakdown_groups"

#: 分组内的网格排布。数值取自实测的 LibTV 分组：格子 350×350、间距 36、
#: 左右下留白 36、顶部 66（给分组标题条）。照抄是为了导入/导出两边看起来一致。
GRID_CELL = 350
GRID_GAP = 36
GRID_PAD = 36
GRID_TOP = 66
GRID_COLUMNS = 2

#: 切点附近的过渡帧不要：每个镜头两端各内缩这么多秒再取帧/剪片。
#: LibTV 在 11s 的素材上丢掉了切点处整整 1 秒，同样的道理——转场帧既不能
#: 代表前一个镜头，也不能代表后一个。
SHOT_EDGE_TRIM_SEC = 0.25

#: 比这更短的片段不成其为「镜头」，多半是闪白/转场的误检，合并进前一个。
MIN_SHOT_SEC = 0.8


def spans_from_cut_times(
    cut_times: Iterable[float],
    *,
    duration_sec: float,
    min_shot_sec: float = MIN_SHOT_SEC,
) -> list[dict[str, float]]:
    """把 ffmpeg 报出来的切点时刻收敛成一串镜头区间。

    切点是「新镜头的第一帧」，所以区间是 [上一个切点, 这个切点)。

    过近的两个切点意味着中间夹出一小片 0.x 秒的碎片——闪白、快速转场、
    压缩噪声都会造成这种误检。处理方式是**丢掉靠后的那个切点**，让碎片并进
    后面的镜头，而不是并进前面：碎片的画面内容属于新场景，并进前一个镜头
    会让前一个镜头的尾帧取到新场景的画面，而尾帧正是要拿去当图生视频输入的。
    """
    if duration_sec <= 0:
        return []
    marks = sorted({round(float(t), 3) for t in cut_times if 0 < float(t) < duration_sec})

    kept: list[float] = [0.0]
    for mark in marks:
        if mark - kept[-1] >= min_shot_sec:
            kept.append(mark)
    boundaries = [*kept, float(duration_sec)]
    # 末尾那段可能不够长，但它后面没有可并入的镜头了，只能回并给前一个。
    if len(boundaries) > 2 and boundaries[-1] - boundaries[-2] < min_shot_sec:
        del boundaries[-2]

    spans: list[dict[str, float]] = [
        {"start": round(start, 3), "end": round(end, 3), "duration": round(end - start, 3)}
        for start, end in zip(boundaries, boundaries[1:])
    ]
    for index, span in enumerate(spans):
        span["index"] = index
    return spans


def cap_shot_spans(
    spans: list[dict[str, float]], *, max_shots: int
) -> list[dict[str, float]]:
    """把过多镜头均匀压到上限，同时保住片头和片尾。

    `max_frames` 是公开请求契约，但 scene cut 的数量由素材决定。直接切
    `spans[:max_shots]` 会让长片只分析开头，和“拉整条片”的用户预期相反；
    这里在完整时间序列上等距取样，使预算封顶时仍覆盖全片。

    返回浅拷贝并重排 `index`。后续文件名、视觉分析结果和节点顺序都依赖这个
    index；保留被跳过镜头的旧编号会让用户看到 S01、S09 这种假缺失。
    """
    limit = max(1, int(max_shots))
    if len(spans) <= limit:
        selected = spans
    elif limit == 1:
        selected = [spans[0]]
    else:
        last = len(spans) - 1
        indices = [round(position * last / (limit - 1)) for position in range(limit)]
        selected = [spans[index] for index in indices]
    return [{**span, "index": index} for index, span in enumerate(selected)]


def sample_points_for_span(
    span: dict[str, float], *, trim_sec: float = SHOT_EDGE_TRIM_SEC
) -> tuple[float, float]:
    """镜头内用来取首帧/尾帧的两个时刻（已避开切点附近的过渡帧）。

    镜头短到内缩会把两端交叉时，退回取中点前后一丁点——宁可两张图接近，
    也不要取到转场帧，那张图拿去当首帧会直接毁掉生成结果。
    """
    start = float(span["start"])
    end = float(span["end"])
    if end - start <= trim_sec * 2:
        middle = (start + end) / 2
        return (max(start, middle - 0.01), max(start, middle))
    return (start + trim_sec, end - trim_sec)


def _label(analysis: dict[str, Any] | None, field: str, fallback: str = "") -> str:
    if not isinstance(analysis, dict):
        return fallback
    return _clean(analysis.get(field)) or fallback


def format_frame_node_name(order: int, analysis: dict[str, Any] | None) -> str:
    """`S01｜中景·固定｜三人同框演奏` —— 镜头语言写进名字。

    LibTV 把全部语义都编码在节点名里，`data` 中一个结构化字段都没有。
    好处是产物就是普通图片/视频节点，下游任何生成节点都能直接连，不用为
    「拉片素材」新增一种可连接类型。我们两样都要：名字这么写，结构化的
    那份留在 `lens_material` 里给程序消费。
    """
    size = _label(analysis, "shot_type", "镜头")
    move = _label(analysis, "camera_movement", "固定")
    action = _label(analysis, "subject_action")
    head = f"S{order:02d}｜{size}·{move}"
    return f"{head}｜{action}" if action else head


def format_clip_node_name(
    order: int, *, duration_sec: float, analysis: dict[str, Any] | None
) -> str:
    """`M01｜4s·中景固定｜三人演奏建立·场景开局参考`"""
    size = _label(analysis, "shot_type", "镜头")
    move = _label(analysis, "camera_movement", "固定")
    action = _label(analysis, "subject_action")
    head = f"M{order:02d}｜{round(duration_sec)}s·{size}{move}"
    return f"{head}｜{action}·运镜参考" if action else f"{head}｜运镜参考"


def format_audio_node_name(
    *,
    duration_sec: float | None,
    mood: str = "",
    bgm_only: bool = False,
    track: str = "background",
) -> str:
    """`BGM｜11s·温馨·伴奏` / `BGM｜11s·温馨·原声（含人声）` / `人声｜11s·对白轨`

    最后一段是**产物性质**，不是修饰语：人声分离跑成了就是纯伴奏，跑不成就是
    带对白的原声。两者铺到新片上效果天差地别，名字里必须分得开——这是用户在
    画布上唯一能看到的区别。
    """
    tail = []
    if duration_sec:
        tail.append(f"{round(duration_sec)}s")
    if mood:
        tail.append(mood)
    if track == "vocals":
        tail.append("对白轨")
        return f"人声｜{'·'.join(tail)}"
    tail.append("伴奏" if bgm_only else "原声（含人声）")
    return f"BGM｜{'·'.join(tail)}"


def grid_layout(count: int, *, columns: int = GRID_COLUMNS) -> dict[str, Any]:
    """分组的网格坐标 + 自适应尺寸。

    分组尺寸按子节点数算出来，不由调用方传——传进来就意味着两处各算一遍，
    早晚会对不上。
    """
    count = max(0, int(count))
    columns = max(1, int(columns))
    used_columns = min(columns, count) or 1
    rows = (count + columns - 1) // columns or 1
    step = GRID_CELL + GRID_GAP
    positions = [
        {"x": GRID_PAD + (index % columns) * step, "y": GRID_TOP + (index // columns) * step}
        for index in range(count)
    ]
    return {
        "mode": "grid",
        "cell": [GRID_CELL, GRID_CELL],
        "columns": columns,
        "padding": GRID_PAD,
        "positions": positions,
        "width": GRID_PAD * 2 + used_columns * GRID_CELL + (used_columns - 1) * GRID_GAP,
        "height": GRID_TOP + GRID_PAD + rows * GRID_CELL + (rows - 1) * GRID_GAP,
    }


def _storyboard_group_name(items: list[dict[str, Any]]) -> str:
    """`分镜组01｜演奏与聆听·建立→特写→反应` —— 用首尾两镜勾出叙事弧。"""
    actions = [item.get("subject_action") for item in items if item.get("subject_action")]
    if not actions:
        return "分镜组01｜关键帧"
    if len(actions) == 1:
        return f"分镜组01｜{actions[0]}"
    return f"分镜组01｜{actions[0]}→{actions[-1]}"


def build_breakdown_groups(
    *,
    frames: list[dict[str, Any]] | None = None,
    clips: list[dict[str, Any]] | None = None,
    audio: dict[str, Any] | None = None,
    vocals: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """把三个维度的产物各自装进一个分组。

    分组是分别返回的，因为三个维度是**各自跑完各自落盘**的（LibTV 实测：
    +87s / +94s / +119s，进度条那三跳就是这么来的）。让 runner 能一个维度
    产完就推一个，用户不必等最慢的音乐维度。
    """
    groups: list[dict[str, Any]] = []
    if frames:
        groups.append(
            {
                "key": DIMENSION_STORYBOARD,
                "name": _storyboard_group_name(frames),
                "layout": grid_layout(len(frames)),
                "items": frames,
            }
        )
    if clips:
        groups.append(
            {
                "key": DIMENSION_CAMERA_MOVES,
                "name": "动态｜运镜与动作参考",
                "layout": grid_layout(len(clips)),
                "items": clips,
            }
        )
    audio_items = [item for item in (audio, vocals) if item]
    if audio_items:
        groups.append(
            {
                "key": DIMENSION_MUSIC_REF,
                "name": "音乐｜参考音轨",
                "layout": grid_layout(len(audio_items)),
                "items": audio_items,
            }
        )
    return groups
