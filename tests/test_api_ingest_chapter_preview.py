from __future__ import annotations

import io
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
