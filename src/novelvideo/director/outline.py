"""One outline contract for planning and direct edits, with a lossless old reader.

Craft remains in the shipped short-drama method. The host owns episode identity,
settings and display order so a fluent answer cannot silently change the brief.
"""

from __future__ import annotations

import json

from .schemas.planning import StoryPlan

OUTLINE_CONTRACT = "story-outline/2.2.0"


def parse_outline(raw: str, root: dict) -> dict:
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("OUTLINE_DUPLICATE_JSON_KEY")
            result[key] = value
        return result

    return validate_outline(json.loads(raw, object_pairs_hook=unique_object), root)


def validate_outline(value: dict, root: dict) -> dict:
    contract = root.get("outlineContract", OUTLINE_CONTRACT)
    if contract == "adaptation-outline/3.0.0":
        from .outline_delivery import validate_delivery

        if "outlineDeliveryContext" not in root:
            raise ValueError("OUTLINE_DELIVERY_CONTEXT_REQUIRED")
        return validate_delivery(value, root, root["outlineDeliveryContext"])
    if contract != OUTLINE_CONTRACT:
        raise ValueError("OUTLINE_CONTRACT_UNSUPPORTED")
    value = StoryPlan.from_wire(value).model_dump(mode="json", by_alias=True)
    # A decoder can satisfy field presence while collapsing every sentence to
    # one character. Reject systemic loss of prose, not concise titles/names.
    narrative = [value["logline"], value["synopsis"], value["ending"]] + [
        segment[key] for segment in value["segments"] for key in ("action", "result")
    ]
    if all(len(text.strip()) <= 1 for text in narrative):
        raise ValueError("OUTLINE_NARRATIVE_COLLAPSED")
    spec, episodes = root["preset"], root["episodes"]
    ordered = [ep["id"] for ep in episodes]
    ranks = {identifier: i for i, identifier in enumerate(ordered)}
    if len(ordered) != spec["episode_count"] or len(ranks) != len(ordered):
        raise ValueError("PLANNING_EPISODES_MISMATCH")
    if (
        value["structureId"] != spec["structure"]
        or value["totalDurationSeconds"]
        != spec["episode_count"] * spec["duration_seconds"]
    ):
        raise ValueError("PLANNING_SPEC_MISMATCH")
    mapped = {key for segment in value["segments"] for key in segment["episodeIds"]}
    if (
        mapped != set(ordered)
        or [row["episodeId"] for row in value["whyWatch"]] != ordered
    ):
        raise ValueError("PLANNING_EPISODES_MISMATCH")
    for segment in value["segments"]:
        ids = segment["episodeIds"]
        if ids != sorted(set(ids), key=ranks.__getitem__):
            raise ValueError("OUTLINE_SEGMENT_ORDER_INVALID")
    for item in value["hooks"] + value["reversals"]:
        if item["episodeId"] not in ranks:
            raise ValueError("OUTLINE_REFERENCE_EPISODE_MISSING")
    setup_ids = {row["id"] for row in value["setups"]}
    linked = {key for segment in value["segments"] for key in segment["setupIds"]}
    if linked != setup_ids:
        raise ValueError("OUTLINE_SETUP_LINK_MISMATCH")
    for item in value["setups"]:
        start, end = item["plantEpisodeId"], item["payoffEpisodeId"]
        if start not in ranks or end is not None and end not in ranks:
            raise ValueError("OUTLINE_REFERENCE_EPISODE_MISSING")
        if end is not None and ranks[end] < ranks[start]:
            raise ValueError("OUTLINE_PAYOFF_PRECEDES_PLANT")
        if end is None and spec["ending_type"] != "open":
            raise ValueError("OUTLINE_CLOSED_UNRESOLVED_SETUP")
    return value


# These are document headings, selected by output_language, not UI status text.
LABELS = {
    "summary": ("概要设计", "Overview design", "Thiết kế tổng quan"),
    "logline": ("故事简介", "Logline", "Tóm tắt một câu"),
    "highlights": ("核心看点", "Core attractions", "Điểm hấp dẫn chính"),
    "protagonist": (
        "主角 / 主要阻力",
        "Protagonist / main resistance",
        "Nhân vật chính / trở lực",
    ),
    "genre": ("题材 / 口味", "Genre / treatment", "Thể loại / sắc thái"),
    "scale": (
        "总集数 / 单集时长 / 总时长（目标）",
        "Episodes / seconds per episode / total seconds (target)",
        "Số tập / giây mỗi tập / tổng giây (mục tiêu)",
    ),
    "mode": ("创作模式", "Creation mode", "Chế độ sáng tác"),
    "original": ("原创", "Original", "Nguyên bản"),
    "adaptation": ("改编", "Adaptation", "Chuyển thể"),
    "source": ("来源与约束", "Sources and constraints", "Nguồn và ràng buộc"),
    "brief": ("用户要求", "User brief", "Yêu cầu người dùng"),
    "locked": ("锁定事实", "Locked facts", "Dữ kiện đã khóa"),
    "spec": ("已确认设置", "Confirmed settings", "Thiết lập đã xác nhận"),
    "assumptions": (
        "待确认假设（非既定事实）",
        "Proposed assumptions (not established facts)",
        "Giả định chờ xác nhận (không phải dữ kiện)",
    ),
    "emotion": ("情绪曲线", "Emotional curve", "Diễn tiến cảm xúc"),
    "synopsis": ("故事简述", "Story synopsis", "Tóm tắt câu chuyện"),
    "background": ("背景设定", "Background", "Bối cảnh"),
    "setting": ("故事背景", "Story setting", "Bối cảnh câu chuyện"),
    "rules": (
        "关键规则或现实条件",
        "Key rules or real-world conditions",
        "Quy tắc hoặc điều kiện thực tế",
    ),
    "pressure": ("主要关系与压力", "Relationships and pressure", "Quan hệ và áp lực"),
    "protagonistGoal": ("主角目标", "Protagonist goal", "Mục tiêu nhân vật chính"),
    "cannotRetreat": (
        "主角为什么不能退",
        "Why retreat is not an option",
        "Vì sao không thể rút lui",
    ),
    "habitualStrategy": (
        "主角惯用办法",
        "Habitual strategy",
        "Cách hành động quen thuộc",
    ),
    "opposition": (
        "主要阻力怎样拦住主角",
        "How resistance blocks the protagonist",
        "Trở lực cản nhân vật thế nào",
    ),
    "extraPressures": ("额外压力", "Additional pressure", "Áp lực bổ sung"),
    "segments": ("全剧分段", "Story segments", "Các phần câu chuyện"),
    "structure": ("叙事结构", "Narrative structure", "Cấu trúc tự sự"),
    "position": ("在全剧的位置", "Position in the story", "Vị trí trong toàn truyện"),
    "carryIn": ("承接", "Carry-in", "Tiếp nối"),
    "stageGoal": (
        "阶段目标（从什么到什么）",
        "Stage goal (from / to)",
        "Mục tiêu giai đoạn (từ / đến)",
    ),
    "mainConflict": ("主冲突", "Main conflict", "Xung đột chính"),
    "secondaryConflicts": ("次级冲突", "Secondary conflicts", "Xung đột phụ"),
    "oppositionTactic": (
        "阻力在本段的打法",
        "Opposition tactic",
        "Cách trở lực tác động",
    ),
    "action": ("可拍行动", "Visible action", "Hành động có thể quay"),
    "result": ("已发生结果", "Established result", "Kết quả đã xảy ra"),
    "characterArcs": ("人物弧光", "Character arcs", "Cung phát triển nhân vật"),
    "setupIds": ("本段伏笔", "Segment setups", "Chi tiết gieo trong phần"),
    "informationRelease": (
        "本段揭示了什么设定",
        "Information revealed",
        "Thông tin được hé lộ",
    ),
    "cost": ("本段的代价", "Cost", "Cái giá"),
    "audienceReward": (
        "本段观众得到什么",
        "Audience reward",
        "Điều khán giả nhận được",
    ),
    "distinction": (
        "与其他段的区别",
        "What makes this segment distinct",
        "Điểm khác biệt của phần",
    ),
    "carryOut": ("段末留下什么", "Carry-out", "Điều còn lại cuối phần"),
    "watch": ("为什么能追", "Why keep watching", "Vì sao tiếp tục xem"),
    "hooks": ("钩子预设", "Planned hooks", "Móc câu dự kiến"),
    "hookImage": (
        "钩子（一句话画面或一句台词）",
        "Hook image or line",
        "Hình ảnh hoặc câu thoại gợi tò mò",
    ),
    "question": ("它挑起什么疑问", "Question raised", "Câu hỏi được gợi ra"),
    "episode": ("落在", "Episode", "Tập"),
    "setups": ("伏笔预设", "Planned setups and payoffs", "Gieo và thu chi tiết"),
    "plant": ("埋什么", "Setup", "Gieo điều gì"),
    "plantAt": ("埋在", "Plant episode", "Tập gieo"),
    "visible": ("埋的具体形态", "Visible form", "Hình thức cụ thể"),
    "payoffAt": ("收在", "Payoff episode", "Tập thu"),
    "payoff": ("收的方式", "Payoff", "Cách thu"),
    "reversals": ("反转预设", "Planned reversals", "Đảo chiều dự kiến"),
    "expectation": ("原有预期", "Expectation", "Kỳ vọng ban đầu"),
    "truth": ("揭示真相", "Revealed truth", "Sự thật hé lộ"),
    "evidence": ("前置证据", "Prior evidence", "Bằng chứng trước đó"),
    "consequence": ("后果", "Consequence", "Hệ quả"),
    "bans": ("创作禁区", "Creative prohibitions", "Giới hạn sáng tác"),
    "appendix": ("创作策略补充", "Craft notes", "Ghi chú sáng tác"),
    "titles": ("剧名备选", "Title alternatives", "Tên phim đề xuất"),
    "conflicts": ("冲突轴", "Conflict axes", "Trục xung đột"),
    "arcs": ("全剧人物弧线", "Overall character arcs", "Cung nhân vật toàn truyện"),
    "setupNotes": ("伏笔回收策略", "Setup/payoff strategy", "Chiến lược gieo và thu"),
    "ending": ("结局设计", "Ending design", "Thiết kế kết thúc"),
    "risks": (
        "制作风险（时长未实测）",
        "Production risks (duration not measured)",
        "Rủi ro sản xuất (chưa đo thời lượng)",
    ),
    "none": ("无", "None", "Không có"),
    "open": (
        "未收束（开放结局）",
        "Unresolved (open ending)",
        "Chưa khép lại (kết mở)",
    ),
}

STRUCTURES = {
    "three_act": ("三幕结构", "Three acts", "Ba hồi"),
    "four_act": ("起承转合", "Four-part progression", "Bốn phần"),
    "five_act": ("五幕结构", "Five acts", "Năm hồi"),
    "hero": ("英雄之旅", "Hero's journey", "Hành trình anh hùng"),
    "parallel": ("平行结构", "Parallel", "Song song"),
    "cross": ("交叉结构", "Interwoven", "Đan xen"),
    "nonlinear": ("非线性结构", "Nonlinear", "Phi tuyến"),
    "loop": ("环形结构", "Circular", "Vòng tròn"),
    "unit": ("单元剧结构", "Episodic", "Từng tập độc lập"),
    "custom": ("自定义结构", "Custom", "Tùy chỉnh"),
}


def render_outline(story: dict, root: dict) -> str:
    """Render all required elements without generating new story facts."""
    contract = root.get("outlineContract", OUTLINE_CONTRACT)
    if contract == "adaptation-outline/3.0.0":
        from .outline_delivery import render_delivery

        if "outlineDeliveryContext" not in root:
            raise ValueError("OUTLINE_DELIVERY_CONTEXT_REQUIRED")
        return render_delivery(story, root, root["outlineDeliveryContext"])
    if contract != OUTLINE_CONTRACT:
        raise ValueError("OUTLINE_CONTRACT_UNSUPPORTED")
    language = root["preset"].get("output_language", "zh-CN").lower()
    locale = 1 if language.startswith("en") else 2 if language.startswith("vi") else 0

    def label(key: str) -> str:
        return LABELS[key][locale]

    spec = root["preset"]
    structure = STRUCTURES[story["structureId"]][locale]
    episodes = {ep["id"]: ep["deliveryLabel"] for ep in root["episodes"]}
    lines = [f"# {story['titleCandidates'][0]}", f"## {label('summary')}"]

    def field(key: str, value: object) -> None:
        if isinstance(value, list):
            value = "; ".join(str(item) for item in value) or label("none")
        lines.append(f"- **{label(key)}**：{value}")

    def section(key: str, text: str | None = None) -> None:
        lines.append(f"## {label(key)}")
        if text:
            lines.append(text)

    def table(headers: list[str], rows: list[list[object]]) -> None:
        def cell(value: object) -> str:
            return (
                str(value)
                .replace("\\", "\\\\")
                .replace("|", "\\|")
                .replace("\n", "<br>")
            )

        lines.append(
            "| "
            + " | ".join(headers)
            + " |\n| "
            + " | ".join("---" for _ in headers)
            + " |\n"
            + "\n".join(
                "| " + " | ".join(cell(value) for value in row) + " |" for row in rows
            )
        )

    field("logline", story["logline"])
    field("highlights", story["coreHighlights"])
    field("protagonist", story["protagonist"] + " / " + story["mainResistance"])
    field("genre", story["genreTreatment"])
    field(
        "scale",
        f"{spec['episode_count']} / {spec['duration_seconds']}s / {story['totalDurationSeconds']}s",
    )
    field("mode", label(spec["mode"]))
    field("emotion", story["emotionalCurve"])
    lines.append(f"### {label('source')}")
    field("brief", root.get("brief", "") or label("none"))
    field("locked", spec.get("locked_facts") or label("none"))
    field(
        "spec",
        " / ".join(
            structure if key == "structure" else str(spec.get(key, ""))
            for key in (
                "primary_genre",
                "fusion_genre",
                "visual_style",
                "narrative_tone",
                "structure",
            )
            if spec.get(key)
        ),
    )
    field("assumptions", story["assumptions"])
    section("synopsis", story["synopsis"])
    section("background")
    field("setting", story["setting"])
    field("rules", story["worldRules"])
    section("pressure")
    for key, value in story["pressure"].items():
        field(key, value)
    section("segments")
    field("structure", structure)
    for segment in story["segments"]:
        lines.append(
            f"### {segment['name']}（{' / '.join(episodes[key] for key in segment['episodeIds'])}）"
        )
        for key in (
            "position",
            "carryIn",
            "stageGoal",
            "mainConflict",
            "secondaryConflicts",
            "oppositionTactic",
            "action",
            "result",
            "characterArcs",
            "setupIds",
            "informationRelease",
            "cost",
            "audienceReward",
            "distinction",
            "carryOut",
        ):
            field(key, segment[key])
    section("watch")
    lines.extend(
        f"- **{episodes[row['episodeId']]}**：{row['reason']}"
        for row in story["whyWatch"]
    )
    section("hooks")
    table(
        ["ID", label("hookImage"), label("question"), label("episode")],
        [
            [row["id"], row["imageOrLine"], row["question"], episodes[row["episodeId"]]]
            for row in story["hooks"]
        ],
    )
    section("setups", story["setupsNote"])
    if story["setups"]:
        table(
            [
                "ID",
                label("plant"),
                label("plantAt"),
                label("visible"),
                label("payoffAt"),
                label("payoff"),
            ],
            [
                [
                    row["id"],
                    row["plant"],
                    episodes[row["plantEpisodeId"]],
                    row["visibleForm"],
                    episodes[row["payoffEpisodeId"]]
                    if row["payoffEpisodeId"]
                    else label("open"),
                    row["payoff"],
                ]
                for row in story["setups"]
            ],
        )
    section("reversals", story["reversalsNote"])
    if story["reversals"]:
        table(
            [
                "ID",
                label("episode"),
                label("expectation"),
                label("truth"),
                label("evidence"),
                label("consequence"),
            ],
            [
                [
                    row["id"],
                    episodes[row["episodeId"]],
                    row["expectation"],
                    row["truth"],
                    row["evidence"],
                    row["consequence"],
                ]
                for row in story["reversals"]
            ],
        )
    section("bans")
    lines.extend(f"- {value}" for value in story["creativeBans"])
    section("appendix")
    for key, value in (
        ("titles", story["titleCandidates"]),
        ("conflicts", story["conflicts"]),
        ("arcs", story["arcs"]),
        ("setupNotes", story["setupsPayoffs"]),
        ("ending", story["ending"]),
        ("risks", story["productionRisks"]),
    ):
        field(key, value)
    return "\n\n".join(lines) + "\n"
