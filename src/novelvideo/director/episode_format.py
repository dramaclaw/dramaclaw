"""Visible structure diagnostics are not a literary-quality score or an auto-repair."""

import re


FIELDS = {
    "duration": ("目标时长", "Target duration", "Thời lượng mục tiêu"),
    "genre": ("题材 / 口味", "题材/口味", "Genre / flavor", "Thể loại / sắc thái"),
    "beats": ("节拍", "Beats", "Nhịp truyện"),
    "mood": ("核心氛围", "Core mood", "Không khí chủ đạo"),
    "continuity": ("本集承接", "Continuity", "Tiếp nối"),
    "hook": ("本集钩子", "Episode hook", "Điểm móc tập"),
    "assets": ("关联资产", "Linked assets", "Tài nguyên liên quan"),
    "synopsis": ("剧情梗概", "Synopsis", "Tóm tắt"),
    "body": ("正文", "Screenplay", "Kịch bản"),
}


def inspect_episode(text: str) -> dict:
    """Check labels and scene headers, never invent missing facts to satisfy a form."""
    missing = [key for key, aliases in FIELDS.items()
               if not any(re.search(r"(?im)^\s*(?:[-*#]+\s*)?(?:\*\*)?" + re.escape(alias)
                                    + r"(?:\*\*)?\s*(?:[:：]|$)", text) for alias in aliases)]
    scenes = re.findall(r"(?m)^###\s+\d+[-－]\d+\s*[｜|].+", text)
    if not scenes:
        missing.append("scenes")
    return {"contract": "episode-screenplay/1.0.0", "missing": missing,
            "sceneCount": len(scenes), "qualityVerified": False}
