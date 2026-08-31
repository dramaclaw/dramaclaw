from __future__ import annotations

import io
import os
import stat
import zipfile
from types import SimpleNamespace

import pytest
from fastapi import UploadFile

from novelvideo.api.schemas import IngestStart

pytestmark = pytest.mark.m03

NOVEL_TEXT = "第一章 启程\n秦王入宫。\n第二章 风起\n宫门起风。"
FANTASY_META_TEXT = (
    "第一章 穿书\n"
    "苏糖睁开眼，发现自己站在陌生宫殿里。\n"
    "苏糖 OS：原著第九章，北线兵假队遭遇伏击，损兵三十。\n"
    "他低声说：我记得第七章不是这样写的。\n"
    "第二章 破局\n"
    "苏糖决定亲自改写命运。\n"
    "旁白：这一幕其实发生在原书第十八章之前。\n"
)


class _NovelStore:
    def __init__(self, text: str):
        self.text = text

    def load_novel_content(self):
        return self.text


def _legacy_resolution(project_dir):
    return SimpleNamespace(
        ctx=None,
        username="admin",
        project_name="demo",
        project_dir=project_dir,
        output_dir=str(project_dir / "output"),
        state_dir=str(project_dir / "state"),
        runtime_dir=str(project_dir / "runtime"),
    )


def _project_scope_resolver(project_dir):
    async def resolve(*args, **kwargs):
        return _legacy_resolution(project_dir)

    return resolve


def _docx_bytes(paragraphs: list[str]) -> bytes:
    document_body = "".join(
        f"<w:p><w:r><w:t>{paragraph}</w:t></w:r></w:p>" for paragraph in paragraphs
    )
    document_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>{document_body}</w:body>
</w:document>
"""
    document_content_type = (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    )
    office_document_rel = (
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
                '  <Default Extension="rels" '
                'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
                '  <Default Extension="xml" ContentType="application/xml"/>\n'
                '  <Override PartName="/word/document.xml" '
                f'ContentType="{document_content_type}"/>\n'
                "</Types>\n"
            ),
        )
        archive.writestr(
            "_rels/.rels",
            (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
                f'  <Relationship Id="rId1" Type="{office_document_rel}" '
                'Target="word/document.xml"/>\n'
                "</Relationships>\n"
            ),
        )
        archive.writestr("word/document.xml", document_xml)
    return buffer.getvalue()


def _preview_lines(content: str) -> list[str]:
    return content.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def test_chapter_preview_ignores_embedded_chapter_references():
    from novelvideo.api.chapter_preview import build_chapter_preview

    data = build_chapter_preview(FANTASY_META_TEXT)

    assert data["count"] == 2
    assert [chapter["number"] for chapter in data["chapters"]] == [1, 2]
    assert "原著第九章" in data["chapters"][0]["content"]
    assert "原书第十八章" in data["chapters"][1]["content"]


def test_chapter_preview_does_not_split_episode_end_sentence():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "# 第一集",
            "开场就是高潮。",
            "第一集结束。",
            "第一集 结束。",
            "第一集 已经结束。",
            "第一集 至此结束。",
            "---",
            "# 第二集",
            "林远回家。",
        ]
    )

    data = build_chapter_preview(text)

    assert data["count"] == 2
    assert [chapter["number"] for chapter in data["chapters"]] == [1, 2]
    assert "第一集结束。" in data["chapters"][0]["content"]
    assert "第一集 已经结束。" in data["chapters"][0]["content"]
    assert "第一集 至此结束。" in data["chapters"][0]["content"]


def test_chapter_preview_does_not_split_english_episode_end_sentence():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "Episode 1: The Reset",
            "The opening is a shock.",
            "Episode 1 ends here.",
            "Episode 1 Ends here.",
            "Episode 1. Ends here.",
            "---",
            "Episode 2 - Aftermath",
            "He returns home.",
        ]
    )

    data = build_chapter_preview(text)

    assert data["count"] == 2
    assert [chapter["number"] for chapter in data["chapters"]] == [1, 2]
    assert "Episode 1 ends here." in data["chapters"][0]["content"]
    assert "Episode 1 Ends here." in data["chapters"][0]["content"]
    assert "Episode 1. Ends here." in data["chapters"][0]["content"]


def test_chapter_preview_accepts_dot_after_english_marker_number():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "Chapter 1. Introduction",
            "The story starts.",
            "Episode 2. Aftermath",
            "The aftermath unfolds.",
        ]
    )

    data = build_chapter_preview(text)

    assert data["count"] == 2
    assert [chapter["number"] for chapter in data["chapters"]] == [1, 2]
    assert data["chapters"][0]["title"] == "Chapter 1. Introduction"
    assert data["chapters"][1]["title"] == "Episode 2. Aftermath"


def test_chapter_preview_keeps_valid_titles_after_marker():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "第一集 完美计划",
            "林远开始布局。",
            "第二集 完整线索",
            "线索浮出水面。",
            "第三集 谁是凶手？",
            "疑问浮出水面。",
            "第四集 他回来了！",
            "门被推开。",
            "Episode 5 the reset",
            "The reset begins.",
            "Chapter6 What Happens Next?",
            "The question remains.",
            "Chapter7 The Return!",
            "He returns home.",
        ]
    )

    data = build_chapter_preview(text)

    assert data["count"] == 7
    assert [chapter["number"] for chapter in data["chapters"]] == [1, 2, 3, 4, 5, 6, 7]
    assert data["chapters"][0]["title"] == "第一集 完美计划"
    assert data["chapters"][2]["title"] == "第三集 谁是凶手？"
    assert data["chapters"][3]["title"] == "第四集 他回来了！"
    assert data["chapters"][4]["title"] == "Episode 5 the reset"
    assert data["chapters"][5]["title"] == "Chapter6 What Happens Next?"
    assert data["chapters"][6]["title"] == "Chapter7 The Return!"


def test_chapter_preview_includes_scene_blocks_within_each_episode():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "第一集 初遇",
            "1-1 雨巷 夜 外",
            "人物：林昭、苏然",
            "△ 林昭停在屋檐下。",
            "1-2 茶馆 日 内",
            "人物：苏然",
            "△ 苏然推门而入。",
            "第二集 重逢",
            "2-1 码头 黄昏 外",
            "人物：林昭",
            "△ 渡轮靠岸。",
        ]
    )

    data = build_chapter_preview(text, include_scene_blocks=True)

    assert data["count"] == 2
    first_scenes = data["chapters"][0]["scene_blocks"]
    second_scenes = data["chapters"][1]["scene_blocks"]
    assert [scene["scene_no"] for scene in first_scenes] == ["1", "2"]
    assert first_scenes[0] == {
        "header": "1-1 雨巷 夜 外",
        "scene_no": "1",
        "location": "雨巷",
        "time_of_day": "夜",
        "interior_exterior": "外",
        "characters": ["林昭", "苏然"],
        "content_start_line": 3,
        "content_end_line": 4,
    }
    assert (
        _preview_lines(data["chapters"][0]["content"])[
            first_scenes[0]["content_start_line"]
            : first_scenes[0]["content_end_line"]
        ]
        == ["△ 林昭停在屋檐下。"]
    )
    assert [scene["location"] for scene in second_scenes] == ["码头"]


def test_chapter_preview_skips_scene_parsing_unless_requested(monkeypatch):
    from novelvideo.api import chapter_preview

    monkeypatch.setattr(
        chapter_preview,
        "parse_scene_blocks",
        lambda _content: pytest.fail("scene parsing should be skipped"),
    )

    data = chapter_preview.build_chapter_preview("第一章 初遇\n正文")

    assert "scene_blocks" not in data["chapters"][0]


def test_chapter_preview_keeps_text_before_first_scene_header():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "第一集 初遇",
            "这段说明还没有归入任何场景。",
            "1-1 雨巷 夜 外",
            "人物：林昭",
            "△ 林昭停在屋檐下。",
        ]
    )

    data = build_chapter_preview(text, include_scene_blocks=True)

    chapter = data["chapters"][0]
    start = chapter["unparsed_content_start_line"]
    end = chapter["unparsed_content_end_line"]
    assert _preview_lines(chapter["content"])[start:end] == [
        "这段说明还没有归入任何场景。"
    ]


def test_chapter_preview_scene_ranges_keep_blank_lines():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "第一集 初遇",
            "1-1 雨巷 夜 外",
            "人物：林昭",
            "△ 林昭停在屋檐下。",
            "",
            "林昭：雨还没有停。",
        ]
    )

    data = build_chapter_preview(text, include_scene_blocks=True)

    chapter = data["chapters"][0]
    scene = chapter["scene_blocks"][0]
    assert _preview_lines(chapter["content"])[
        scene["content_start_line"] : scene["content_end_line"]
    ] == ["△ 林昭停在屋檐下。", "", "林昭：雨还没有停。"]


@pytest.mark.asyncio
async def test_upload_novel_returns_nicegui_chapter_preview(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    raw = NOVEL_TEXT.encode("utf-8")
    upload = UploadFile(file=io.BytesIO(raw), filename="novel.txt")

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    data = response["data"]
    assert data["filename"] == "novel.txt"
    assert data["size"] == len(raw)
    assert data["total_chars"] == len(NOVEL_TEXT)
    assert data["billable_chars"] == len("".join(NOVEL_TEXT.split()))
    assert data["count"] == 2
    assert data["chapters"][0]["number"] == 1
    assert data["chapters"][0]["title"] == "第一章 启程"
    assert data["chapters"][0]["content"].startswith("第一章")
    assert data["chapters"][0]["word_count"] == len(data["chapters"][0]["content"])
    uploads_dir = tmp_path / "uploads"
    assert (uploads_dir / "novel.txt").read_bytes() == raw
    assert list((uploads_dir / ".staging").glob("upload-*")) == []


@pytest.mark.asyncio
async def test_upload_novel_new_file_respects_restrictive_umask(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    previous_umask = os.umask(0o077)
    try:
        response = await ingest.upload_novel(
            project="demo",
            file=UploadFile(
                file=io.BytesIO(NOVEL_TEXT.encode("utf-8")),
                filename="novel.txt",
            ),
            user={"username": "admin"},
        )
    finally:
        os.umask(previous_umask)

    assert response["ok"] is True
    uploaded = tmp_path / "uploads" / "novel.txt"
    assert stat.S_IMODE(uploaded.stat().st_mode) == 0o600


@pytest.mark.asyncio
async def test_upload_novel_preserves_existing_file_mode(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    existing = uploads_dir / "novel.txt"
    existing.write_text("第一章 旧内容\n旧内容。", encoding="utf-8")
    existing.chmod(0o640)
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    raw = NOVEL_TEXT.encode("utf-8")
    response = await ingest.upload_novel(
        project="demo",
        file=UploadFile(file=io.BytesIO(raw), filename="novel.txt"),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert existing.read_bytes() == raw
    assert stat.S_IMODE(existing.stat().st_mode) == 0o640


@pytest.mark.asyncio
async def test_upload_narrated_novel_skips_scene_preview(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    raw = (
        "第一章 初遇\n1-1 雨巷 夜 外\n人物：林昭\n△ 林昭停在屋檐下。"
    ).encode()

    response = await ingest.upload_novel(
        project="demo",
        file=UploadFile(file=io.BytesIO(raw), filename="novel.txt"),
        spine_template="narrated",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert "scene_blocks" not in response["data"]["chapters"][0]


@pytest.mark.asyncio
async def test_upload_novel_returns_chapter_preview_for_docx(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    raw = _docx_bytes(["第一章 启程", "秦王入宫。", "第二章 风起", "宫门起风。"])
    upload = UploadFile(file=io.BytesIO(raw), filename="novel.docx")

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    data = response["data"]
    assert data["filename"] == "novel.docx"
    assert data["count"] == 2
    assert data["chapters"][0]["title"] == "第一章 启程"
    assert data["chapters"][0]["content"] == "第一章 启程\n\n秦王入宫。\n"
    assert data["chapters"][1]["content"].startswith("第二章 风起")


@pytest.mark.asyncio
async def test_upload_novel_rejects_unsupported_extension(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    upload = UploadFile(file=io.BytesIO(b"%PDF-1.7"), filename="novel.pdf")

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert "不支持" in response["error"]
    assert not (tmp_path / "uploads" / "novel.pdf").exists()


@pytest.mark.asyncio
async def test_upload_novel_rejects_preview_decode_failure(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    raw = b"\xff\xfe\x00\x81"
    upload = UploadFile(file=io.BytesIO(raw), filename="broken.txt")

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert "解析" in response["error"]


@pytest.mark.asyncio
async def test_upload_novel_parse_failure_preserves_existing_same_name(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    existing = uploads_dir / "novel.txt"
    existing.write_text(NOVEL_TEXT, encoding="utf-8")
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    upload = UploadFile(file=io.BytesIO(b"\xff\xfe\x00\x81"), filename="novel.txt")

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert existing.read_text(encoding="utf-8") == NOVEL_TEXT
    assert list((uploads_dir / ".staging").glob("upload-*")) == []


@pytest.mark.asyncio
async def test_upload_novel_text_too_large_preserves_existing_same_name(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    existing = uploads_dir / "novel.txt"
    existing.write_text(NOVEL_TEXT, encoding="utf-8")
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    replacement = "第一章 超长正文\n" + "字" * 100_001
    upload = UploadFile(
        file=io.BytesIO(replacement.encode("utf-8")),
        filename="novel.txt",
    )

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert response["error_type"] == "text_too_large"
    assert response["data"] == {
        "limit_chars": 100_000,
        "actual_chars": 100_008,
    }
    assert "100,008 字" in response["error"]
    assert "100,000 字" in response["error"]
    assert existing.read_text(encoding="utf-8") == NOVEL_TEXT
    assert list((uploads_dir / ".staging").glob("upload-*")) == []


@pytest.mark.asyncio
async def test_upload_novel_file_too_large_preserves_existing_same_name(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    existing = uploads_dir / "novel.txt"
    existing.write_text(NOVEL_TEXT, encoding="utf-8")
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    upload = UploadFile(
        file=io.BytesIO(b"x" * (512 * 1024 + 1)),
        filename="novel.txt",
    )
    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response == {
        "ok": False,
        "error": "文件超过 512KB 上限，请压缩文件或拆分正文后重新上传。",
        "error_type": "file_too_large",
        "data": {"limit_bytes": 512 * 1024},
    }
    assert existing.read_text(encoding="utf-8") == NOVEL_TEXT
    assert list((uploads_dir / ".staging").glob("upload-*")) == []


@pytest.mark.asyncio
async def test_upload_novel_rejects_empty_preview(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    upload = UploadFile(file=io.BytesIO(b""), filename="empty.txt")

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert "章节" in response["error"]


@pytest.mark.asyncio
async def test_start_ingest_rejects_unsupported_extension_before_ray(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    (uploads_dir / "novel.pdf").write_bytes(b"%PDF-1.7")
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    response = await ingest.start_ingest(
        project="demo",
        body=IngestStart(filename="novel.pdf", rebuild=True),
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert "不支持" in response["error"]


@pytest.mark.asyncio
async def test_start_ingest_rejects_existing_file_over_character_limit(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    oversized_text = "第一章\n" + "字" * 100_001
    (uploads_dir / "novel.txt").write_text(oversized_text, encoding="utf-8")
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    monkeypatch.setattr(
        ingest,
        "save_project_config_in_state_dir",
        lambda *_args, **_kwargs: pytest.fail("oversized text must not save config"),
    )

    response = await ingest.start_ingest(
        project="demo",
        body=IngestStart(
            filename="novel.txt",
            rebuild=True,
            spine_template="narrated",
        ),
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert response["error_type"] == "text_too_large"
    assert response["data"] == {
        "limit_chars": 100_000,
        "actual_chars": 100_004,
    }


@pytest.mark.asyncio
async def test_start_ingest_rejects_existing_file_over_size_limit_before_parse(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    (uploads_dir / "novel.txt").write_bytes(b"x" * (1024 * 1024 + 1))
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    monkeypatch.setattr(
        ingest,
        "load_novel_text",
        lambda _path: pytest.fail("oversized file must not be parsed"),
    )

    response = await ingest.start_ingest(
        project="demo",
        body=IngestStart(
            filename="novel.txt",
            rebuild=True,
            spine_template="narrated",
        ),
        user={"username": "admin"},
    )

    assert response == {
        "ok": False,
        "error": "文件超过 1MB 上限，请压缩文件或拆分正文后重新上传。",
        "error_type": "file_too_large",
        "data": {"limit_bytes": 1024 * 1024},
    }


@pytest.mark.asyncio
async def test_detect_chapters_returns_content_and_total_chars(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes

    monkeypatch.setattr(
        episodes,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    async def make_store(username: str, project: str):
        return _NovelStore(NOVEL_TEXT)

    monkeypatch.setattr(episodes, "make_sqlite_store", make_store)

    response = await episodes.detect_chapters(
        project="demo",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    data = response["data"]
    assert data["total_chars"] == len(NOVEL_TEXT)
    assert data["count"] == 2
    assert data["chapters"][1]["number"] == 2
    assert data["chapters"][1]["title"] == "第二章 风起"
    assert data["chapters"][1]["content"].startswith("第二章")
    assert data["chapters"][1]["word_count"] == len(data["chapters"][1]["content"])
    assert data["source_filename"] == "novel.txt"


@pytest.mark.asyncio
async def test_detect_chapters_skips_scene_preview_for_narrated_project(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import episodes

    screenplay = "第一章 初遇\n1-1 雨巷 夜 外\n人物：林昭\n△ 林昭停在屋檐下。"
    monkeypatch.setattr(
        episodes,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    monkeypatch.setattr(
        episodes,
        "load_project_config_file_from_state_dir",
        lambda _state_dir: {"spine_template": "narrated"},
    )

    async def make_store(username: str, project: str):
        return _NovelStore(screenplay)

    monkeypatch.setattr(episodes, "make_sqlite_store", make_store)

    response = await episodes.detect_chapters(
        project="demo",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert "scene_blocks" not in response["data"]["chapters"][0]


@pytest.mark.asyncio
async def test_detect_chapters_query_template_overrides_saved_project_type(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import episodes

    screenplay = "第一章 初遇\n1-1 雨巷 夜 外\n人物：林昭\n△ 林昭停在屋檐下。"
    monkeypatch.setattr(
        episodes,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    monkeypatch.setattr(
        episodes,
        "load_project_config_file_from_state_dir",
        lambda _state_dir: {"spine_template": "narrated"},
    )

    async def make_store(username: str, project: str):
        return _NovelStore(screenplay)

    monkeypatch.setattr(episodes, "make_sqlite_store", make_store)

    response = await episodes.detect_chapters(
        project="demo",
        spine_template="drama",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"]["chapters"][0]["scene_blocks"][0]["location"] == "雨巷"


@pytest.mark.asyncio
async def test_detect_chapters_backfills_existing_upload_source(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    (uploads_dir / "original-novel.txt").write_text(NOVEL_TEXT, encoding="utf-8")
    monkeypatch.setattr(
        episodes,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    async def make_store(username: str, project: str):
        return _NovelStore(NOVEL_TEXT)

    monkeypatch.setattr(episodes, "make_sqlite_store", make_store)

    response = await episodes.detect_chapters(
        project="demo",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"]["source_filename"] == "original-novel.txt"


@pytest.mark.asyncio
async def test_start_ingest_preserves_legacy_canonical_novel_for_reimport(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    canonical = tmp_path / "novel.txt"
    canonical.write_text(NOVEL_TEXT, encoding="utf-8")
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    response = await ingest.start_ingest(
        project="demo",
        body=IngestStart(
            filename="novel.txt",
            rebuild=True,
            spine_template="narrated",
        ),
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert "project context" in response["error"]
    preserved = tmp_path / "uploads" / "novel.txt"
    assert preserved.read_text(encoding="utf-8") == NOVEL_TEXT
    assert canonical.read_text(encoding="utf-8") == NOVEL_TEXT
