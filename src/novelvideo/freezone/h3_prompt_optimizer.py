"""Load the installed H3 skill and keep preview labels bound to canvas assets."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

_MIXED = re.compile(r"\{\{\s*Mixed\s+(\d+)\s*\}\}", re.I)
_LABEL = re.compile(
    r"(?:<|(?<![\w/\\]))(Picture|Video|Audio)[ \t]+(\d+)(?![\w/\\-]|\.[\w])>?",
    re.I,
)
_TYPES = {"image": "Picture", "video": "Video", "audio": "Audio"}

_LOCAL_SHOT = re.compile(
    r"(?mi)^[ \t]*(?:#{1,6}[ \t]*)?(?:【镜头\s*\d+】|镜头\s*\d+[：:]|\[Shot\s+\d+\])[^\n]*"
)
_LOCAL_DURATION = re.compile(r"(?mi)^[ \t]*(?:\*\*)?(?:时长|duration)[：:][ \t]*(\d+(?:\.\d+)?)[ \t]*(?:秒|s(?:econds?)?)(?:\*\*)?[ \t]*$")
_REFERENCE_FIELDS = [
    "subject_definitions", "summary", "retention_analysis", "detailed_description",
    "overall_soundscape", "non_diegetic_music",
]


def _split_fields(text: str, fields: list[str]) -> tuple[str, dict[str, str]]:
    headings = list(re.finditer(r"(?m)^[ \t]*(" + "|".join(fields) + r")[ \t]*:[ \t]*", text))
    if [match[1] for match in headings] != fields:
        raise ValueError("H3 optimization returned an incomplete skill format; regenerate the preview")
    return text[:headings[0].start()], {
        match[1]: text[match.end():headings[i + 1].start() if i + 1 < len(headings) else len(text)].strip()
        for i, match in enumerate(headings)
    }


def _normalize_reference_layout(text: str) -> str:
    """Remove formatter-created metadata duplication without touching shot prose.

    Older local drafts copied the prelude into the main field, while model
    drafts repeated it in the summary. Only these metadata copies are merged;
    repeated dialogue, actions and AI prompt paragraphs within shots stay intact.
    """
    prefix, sections = _split_fields(text, _REFERENCE_FIELDS)
    body = sections["detailed_description"]
    shot = _LOCAL_SHOT.search(body)
    # With no explicit boundary, do not guess which description is a prelude.
    prelude = body[:shot.start()] if shot else ""
    if shot:
        sections["detailed_description"] = body[shot.start():]
    # Blank-line layout is formatting, not shot content. Older local and model
    # drafts used different spacing; retain every non-empty source line verbatim.
    sections["detailed_description"] = "\n".join(
        line for line in sections["detailed_description"].splitlines() if line.strip()
    )

    def lines(value: str) -> list[str]:
        return [line for line in value.splitlines() if line.strip() and line.strip() != "N/A"]

    definitions, common = [], []
    for line in lines(sections["subject_definitions"]):
        # Positions are shared scene instructions, not new asset definitions.
        destination = common if re.match(r"^\s*(?:人物位置|角色位置|共用条件)\s*[:：]", line) and not _LABEL.search(line) else definitions
        destination.append(line)
    for line in lines(sections["summary"]) + lines(prelude):
        (definitions if _LABEL.search(line) else common).append(line)

    def unique_metadata(values: list[str]) -> str:
        seen: set[str] = set()
        kept = []
        for line in values:
            key = line.strip()
            if key not in seen:
                seen.add(key)
                kept.append(line)
        return "\n".join(kept) or "N/A"

    sections["subject_definitions"] = unique_metadata(definitions)
    sections["summary"] = unique_metadata(common)
    for field in ("overall_soundscape", "non_diegetic_music"):
        # Strip only standalone copied section labels, never a line's sound text.
        sections[field] = "\n".join(
            line for line in sections[field].splitlines()
            if not re.fullmatch(r"\s*(?:声音|音效|环境音|背景音乐|配乐|BGM)\s*[:：]\s*", line, re.I)
        ).strip() or "N/A"
    return prefix + "\n\n".join(f"{field}:\n{sections[field]}" for field in _REFERENCE_FIELDS)


class H3FormatPlan:
    """Have the model classify source lines, not regenerate immutable prose.

    Copying thousands of tokens is both slow and prone to paraphrasing. The
    streamed wire format contains only source ranges; all visible prose comes
    from the user's original, with complete coverage checked before acceptance.
    """

    def __init__(self, source: str, options: dict[str, Any]):
        skill_system_prompt(options)
        self.source, self.options = source, options
        canonical = canonical_prompt(source, options)
        self.lines = [line for line in canonical.splitlines() if line.strip()]
        full = options["mode"] in {"allReference", "imageReference", "videoEdit", "videoExtend"}
        self.main = "detailed_description" if full else "integrated_multimodal_description"
        self.fields = (["subject_definitions", "summary", "retention_analysis"] if full else []) + [
            self.main, "overall_soundscape", "non_diegetic_music",
        ]
        # The model may suggest overlapping ranges. Rendering must obey the same
        # deterministic layout as local conversion, including original blank lines.
        # Keep validating its wire plan independently; normalization cannot hide
        # missing source lines, invalid references or an incomplete response.
        formatted = canonical_prompt(local_format_prompt(source, options), options)
        self.prefix, self.sections = _split_fields(formatted, self.fields)
        self.parts: list[str] = []
        self.assignments: dict[str, list[int]] = {}
        self.pending = ""
        self.raw_size = 0
        shots = [i for i, line in enumerate(self.lines) if _LOCAL_SHOT.match(line)]
        self.required_main = set(range((shots[0] if shots else 0) + 1, len(self.lines) + 1))

    @property
    def system_prompt(self) -> str:
        return (
            "You classify numbered source lines into installed H3 format fields. "
            "Output ONLY these fields in this exact order, one line per field:\n"
            + "\n".join(f"{field}: <line ranges or N/A>" for field in self.fields)
            + "\nUse 1-based line numbers and inclusive ranges, e.g. 1-3,7,10-15. "
            "Do NOT output source prose, JSON, Markdown, explanations or new descriptions. "
            "Every source line MUST be included somewhere. Within each field, keep line "
            "numbers ascending and unique. Copy material-binding lines to subject_definitions; "
            "copy all other shared lines before the first shot to summary. "
            "These two fields are disjoint: never copy binding lines to summary, "
            "or shared position instructions to subject_definitions. "
            "retention_analysis MUST be N/A (this is format conversion, not analysis). "
            f"{self.main} MUST include every line from the first shot through the end, "
            "including all camera instructions, dialogue, sounds and AI prompt paragraphs. "
            "Without shot headings put ALL lines in the main description. For sound/music "
            "fields select only explicit source annotations, otherwise N/A. "
            "You may reuse sound/music line ranges already included in the main description. "
            "Use compact ranges; never enumerate a contiguous run one number at a time."
            f"\nThis request has exactly {len(self.lines)} numbered lines. "
            f"{self.main} MUST contain the entire range {min(self.required_main, default=1)}-{len(self.lines)}. "
            f"All remaining lines 1-{min(self.required_main, default=1) - 1} are shared prelude; "
            "include every one of them in subject_definitions or summary (when those fields exist)."
        )

    @property
    def numbered_source(self) -> str:
        return "\n".join(f"{i}: {line}" for i, line in enumerate(self.lines, 1))

    def feed(self, delta: str) -> list[str]:
        self.raw_size += len(delta)
        if self.raw_size > 32768:
            raise ValueError("H3 formatting plan exceeded its size limit")
        self.pending += delta
        output = []
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            if line.strip():
                output.append(self._field(line.strip()))
        return output

    def _field(self, line: str) -> str:
        field, separator, spec = line.partition(":")
        index = len(self.parts)
        if not separator or index >= len(self.fields) or field.strip() != self.fields[index]:
            raise ValueError("H3 formatting plan has an invalid field or field order")
        field, spec = field.strip(), spec.strip()
        ids: list[int] = []
        if field == "retention_analysis" and spec != "N/A":
            raise ValueError("H3 format conversion cannot add retention analysis")
        if spec != "N/A":
            if not re.fullmatch(r"[1-9]\d*(?:\s*-\s*[1-9]\d*)?(?:\s*,\s*[1-9]\d*(?:\s*-\s*[1-9]\d*)?)*", spec):
                raise ValueError("H3 formatting plan must contain only source line ranges")
            for item in spec.split(","):
                bounds = [int(n) for n in item.split("-")]
                start, end = bounds[0], bounds[-1]
                if not 1 <= start <= end <= len(self.lines):
                    raise ValueError("H3 formatting plan contains an unavailable source line")
                ids.extend(range(start, end + 1))
            if ids != sorted(set(ids)):
                raise ValueError("H3 formatting plan changed source order")
        self.assignments[field] = ids
        part = f"{field}:\n{self.sections[field]}\n\n"
        self.parts.append(part)
        # Include keyframe alignment in the first streamed chunk as well as done.
        return _mixed_preview((self.prefix if index == 0 else "") + part, self.options)

    def finish(self) -> str:
        if self.pending.strip():
            self._field(self.pending.strip())
            self.pending = ""
        if len(self.parts) != len(self.fields):
            raise ValueError("H3 formatting plan is incomplete")
        covered = {i for ids in self.assignments.values() for i in ids}
        if covered != set(range(1, len(self.lines) + 1)):
            raise ValueError("H3 formatting plan omitted original source lines")
        if not self.required_main.issubset(self.assignments[self.main]):
            raise ValueError("H3 formatting plan omitted shot content from the main description")
        return preview_prompt(self.prefix + "".join(self.parts), self.options, self.source)


def local_format_prompt(source: str, options: dict[str, Any]) -> str:
    """Preserve shot prose; normalize structure without asking a model to regenerate it."""
    skill_system_prompt(options)  # Verify the installed skill's field contract.
    text = canonical_prompt(source.strip(), options)
    if not text:
        raise ValueError("prompt is required")
    full_reference = options["mode"] in {"allReference", "imageReference", "videoEdit", "videoExtend"}
    main_field = "detailed_description" if full_reference else "integrated_multimodal_description"
    # A second conversion must not wrap an already formatted prompt again.
    if re.search(rf"(?m)^\s*{main_field}\s*:", text):
        return preview_prompt(text, options, source)

    shots = list(_LOCAL_SHOT.finditer(text))
    candidates = re.findall(r"(?mi)^[ \t#]*[【\[]?(?:镜头|Shot)\s*(?:\d+|[一二三四五六七八九十]+)", text)
    if len(candidates) != len(shots):
        raise ValueError("Local H3 formatting could not parse a shot heading; use numbered shot headings and duration lines")
    duration = float(options["duration_sec"])
    prelude = text[:shots[0].start()].strip() if shots else ""
    chunks = [text[m.start():shots[i + 1].start() if i + 1 < len(shots) else len(text)]
              for i, m in enumerate(shots)] if shots else [text]
    starts: list[float] = []
    elapsed = 0.0
    for index, chunk in enumerate(chunks):
        explicit_start = re.search(r"\bAt\s+(\d+):(\d+(?:\.\d+)?)", chunk.splitlines()[0], re.I)
        if explicit_start and abs(int(explicit_start[1]) * 60 + float(explicit_start[2]) - elapsed) > 0.001:
            raise ValueError(f"Shot {index + 1} start time conflicts with the preceding durations")
        values = _LOCAL_DURATION.findall(chunk)
        if len(values) > 1 or (len(chunks) > 1 and not values):
            raise ValueError(
                f"Local H3 formatting needs one explicit duration for shot {index + 1}; "
                "add a duration line before converting. No timing was guessed."
            )
        shot_duration = float(values[0]) if values else duration
        if shot_duration <= 0:
            raise ValueError("Local H3 formatting requires positive shot durations")
        starts.append(elapsed)
        elapsed += shot_duration
    if abs(elapsed - duration) > 0.001:
        raise ValueError(
            f"Shot durations total {elapsed:g}s but the video node is set to {duration:g}s; "
            "make them agree before converting."
        )

    def timestamp(seconds: float) -> str:
        millis = round(seconds * 1000)
        return f"{millis // 60000:02d}:{millis // 1000 % 60:02d}.{millis % 1000:03d}"

    rendered = []
    for i, (chunk, start) in enumerate(zip(chunks, starts)):
        marker = re.match(r"\s*\[Shot\s+\d+\]", chunk, re.I)
        if marker:
            if not re.search(r"\bAt\s+\d+:\d+", chunk.splitlines()[0], re.I):
                chunk = chunk[:marker.end()] + f" At {timestamp(start)}" + chunk[marker.end():]
            rendered.append(chunk.rstrip())
        else:
            rendered.append(f"[Shot {i + 1}] At {timestamp(start)}\n{chunk.rstrip()}")
    body = "\n\n".join(rendered)
    if prelude and not full_reference:
        body = prelude + "\n\n" + body

    # Copy only explicit source annotations into the metadata sections. The
    # shots remain complete in the main field, including sounds and dialogue.
    definitions = "\n".join(line for line in prelude.splitlines() if _LABEL.search(line))
    shared = "\n".join(line for line in prelude.splitlines() if line.strip() and not _LABEL.search(line))
    sounds: list[str] = []
    music: list[str] = []
    destination: list[str] | None = None
    for line in text.splitlines():
        heading = re.fullmatch(r"[ \t]*(声音|音效|环境音|背景音乐|配乐|BGM)[：:][ \t]*(.*)", line, re.I)
        if heading:
            destination = music if heading[1].lower() in {"背景音乐", "配乐", "bgm"} else sounds
            if heading[2]:
                destination.append(heading[2])
        elif not line.strip() or re.match(r"^\s*(?:【镜头|\[Shot|[^:：]{1,20}[:：])", line):
            destination = None
        elif destination is not None:
            destination.append(line)
    sections = []
    if full_reference:
        sections = [
            "subject_definitions:\n" + (definitions or "N/A"),
            "summary:\n" + (shared or "N/A"),
            "retention_analysis:\nN/A",
        ]
    sections.extend([
        f"{main_field}:\n{body}",
        "overall_soundscape:\n" + ("\n".join(sounds) or "N/A"),
        "non_diegetic_music:\n" + ("\n".join(music) or "N/A"),
    ])
    prefix = ""
    images = [label for label in reference_labels(options) if label.startswith("<Picture ")]
    if options["mode"] in {"firstFrame", "imageToVideo", "firstLastFrame"}:
        required = 2 if options["mode"] == "firstLastFrame" else 1
        if len(images) < required:
            raise ValueError(f"This H3 keyframe mode requires {required} image references")
        if required == 2:
            prefix = (
                "How the reference pictures align with the target video — "
                f"Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; "
                f"Picture 2 (from Shot {len(chunks)}) aligns with the {duration:.2f}-second "
                "mark of the target video.\n\n"
            )
        else:
            prefix = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n"
    return preview_prompt(prefix + "\n\n".join(sections), options, source)


def reference_labels(options: dict[str, Any]) -> list[str]:
    counts = dict.fromkeys(_TYPES, 0)
    labels = []
    for kind in options["reference_order"]:
        counts[kind] += 1
        labels.append(f"<{_TYPES[kind]} {counts[kind]}>")
    return labels


def _mixed_preview(text: str, options: dict[str, Any]) -> str:
    labels = reference_labels(options)
    return _LABEL.sub(
        lambda m: "{{Mixed " + str(labels.index(f"<{m[1].title()} {int(m[2])}>") + 1) + "}}",
        text,
    )


def canonical_prompt(prompt: str, options: dict[str, Any]) -> str:
    labels = reference_labels(options)

    def replace(match: re.Match[str]) -> str:
        index = int(match[1]) - 1
        if not 0 <= index < len(labels):
            raise ValueError("H3 prompt contains an unavailable Mixed reference")
        return labels[index]

    # Imported rich text can carry numeric HTML spaces. Decode only whitespace;
    # unescaping arbitrary HTML could change literal dialogue or H3 tags.
    prompt = re.sub(r"&#(?:x0*20|0*32|x0*a0|0*160);", " ", prompt, flags=re.I)
    text = _MIXED.sub(replace, prompt)
    for match in _LABEL.finditer(text):
        label = f"<{match[1].title()} {int(match[2])}>"
        if label not in labels:
            allowed = ", ".join(labels) or "none (no media attached)"
            raise ValueError(
                f"H3 prompt contains an unavailable media reference: {label}. "
                f"Allowed references: {allowed}. Do not copy labels from skill examples "
                "or treat generated speech/sound as uploaded Audio references."
            )
    return text


def skill_system_prompt(options: dict[str, Any]) -> str:
    """Use local skill files without silently replacing a missing skill with a stub."""
    configured = os.environ.get("H3_PROMPT_SKILL_DIR", "").strip()
    roots = [Path(configured)] if configured else [
        Path.cwd() / ".dramaclaw-local/skills/h3-prompt-writing",
        Path.home() / ".codex/skills/h3-prompt-writing",
    ]
    root = next((p for p in roots if (p / "SKILL.md").is_file()), None)
    if root is None:
        raise ValueError("H3 prompt skill is not installed; configure H3_PROMPT_SKILL_DIR")
    full_reference = options["mode"] in {"allReference", "imageReference", "videoEdit", "videoExtend"}
    files = [root / "SKILL.md", root / "references/base-en.txt"]
    if full_reference:
        files.append(root / "references/ref-en.txt")
    guides = "\n\n".join(p.read_text(encoding="utf-8") for p in files)
    fields = (["subject_definitions", "summary", "retention_analysis", "detailed_description"]
              if full_reference else ["integrated_multimodal_description"])
    fields += ["overall_soundscape", "non_diegetic_music"]
    if any(field not in guides for field in fields):
        raise ValueError("Installed H3 skill is missing the required format fields")
    # Creative/English rewrite examples conflict with format-only conversion
    # and contain media that do not exist in the user's attachment manifest.
    # Load the skill but expose only its field/label grammar to this operation.
    rules = "Installed h3-prompt-writing skill format, in order:\n" + "\n".join(
        f"{field}:" for field in fields
    )
    rules += "\n\n" + "\n".join(
        line for line in guides.splitlines()
        if any(line.startswith(f"| `{field}` |") for field in fields)
        or re.match(r"^\| `<(?:Subject|Picture|Video|Audio) N>` \|", line)
    )
    rules += (
        "\nUse [Shot N] and At MM:SS.mmm for explicit shot start times; "
        "derive times only from the source. Dialogue can use <d>...</d> and "
        "stable speaker (S1) tags. Keep original dialogue and visible text. "
        "Use N/A for absent sections, never invent content to fill them."
    )
    manifest = "\n".join(
        f"Reference {i}: {label}" for i, label in enumerate(reference_labels(options), 1)
    ) or "No uploaded media."
    return f"""You FORMAT the CURRENT video node's prompt using this installed skill.
{rules}

Binding contract for this request:
- UI mode: {options['mode']}; target duration: {options['duration_sec']} seconds.
- Use {'the six-section full-reference format' if full_reference else 'the three-field base format'}.
- The UI mode determines reference semantics. A FL2VA checkpoint in allReference mode
  does NOT make the first two reference images opening/ending frames.
- The numbered Reference attachments correspond exactly to this manifest:
{manifest}
- This is the COMPLETE allowlist. Skill examples are syntax examples only, never
  supplied assets. Do not invent or renumber media. With zero audio attachments,
  never emit Audio labels for dialogue, voices, ambience or generated music.
  Use speaker (S1) tags for generated speech. With zero video attachments, never
  use a Video label for the target video itself. Do not omit original descriptions
  to fix a label: remove only the unsupported label or bind to an actual source.
- All remaining source texts are context, not new media and not additional shots.
- Preserve the CURRENT prompt's plot, shot count, shot order, complete shots,
  individual shot durations, named identities, dialogue and visible text verbatim.
  Do not add shots from upstream context. Do not silently shorten or extend the timeline.
- Bind existing character definitions to Subject labels and their correct source Picture.
  Do not add identity details or scene geography from images. Images only help verify bindings.
- Audio references supply only their labels and user descriptions here; video references
  supply sampled frames, not sound. Never claim to have heard or transcribed these assets.
- USER OVERRIDE: FORMAT CONVERSION ONLY. This overrides the skill's English-language,
  expansion, word-count and creative-rewriting suggestions. Keep every original camera
  movement, visual description, action, expression, lighting, sound and dialogue VERBATIM
  in its original language. Do not translate, polish, simplify, summarize, expand or infer.
  Only reorganize fields, add structural field names/tags and convert explicit time notation.
  Preserve all content; do not invent music, sounds, shots, descriptions or transitions.
- Return only the final prompt. Use <Picture N>/<Video N>/<Audio N> consistently; no filenames,
  missing reference labels, Markdown fences, commentary or automatic video generation.
"""


def preview_prompt(text: str, options: dict[str, Any], source: str) -> str:
    """Reject invalid output before presenting a draft, then restore reorderable mentions."""
    text = canonical_prompt(text.strip(), options)
    full_reference = options["mode"] in {"allReference", "imageReference", "videoEdit", "videoExtend"}
    if full_reference:
        text = _normalize_reference_layout(text)
    fields = (["subject_definitions", "summary", "retention_analysis", "detailed_description"]
              if full_reference else ["integrated_multimodal_description"])
    fields += ["overall_soundscape", "non_diegetic_music"]
    previous = -1
    for field in fields:
        match = re.search(rf"(?m)^\s*{field}\s*:", text)
        if match is None or match.start() <= previous:
            raise ValueError("H3 optimization returned an incomplete skill format; regenerate the preview")
        previous = match.start()
    for match in re.finditer(r"\bAt\s+(\d+):(\d+(?:\.\d+)?)", text, re.I):
        if int(match[1]) * 60 + float(match[2]) >= float(options["duration_sec"]):
            raise ValueError("H3 optimization contains a shot outside the selected duration")
    # Long prose lines hold the user's actual camera and scene descriptions.
    # Refuse a rewritten draft instead of quietly offering it as formatting.
    def prose(value: str) -> str:
        value = _LABEL.sub("", value)
        value = re.sub(r"<[^>]*>|\(S\d+(?:,S\d+)*\)", "", value)
        value = re.sub(r"\[(?:Chinese|English|Shot\s+\d+)\]", "", value, flags=re.I)
        return re.sub(r"\s+|[*#]", "", value)

    formatted = prose(text)
    protected_section = False
    for line_number, line in enumerate(canonical_prompt(source, options).splitlines(), 1):
        # Reference definitions are deliberately reformatted as subject entries;
        # their binding is validated separately, not as a verbatim prose paragraph.
        if _LABEL.search(line) and re.match(r"^\s*(?:人物|角色|场景|道具|参考|引用|【|\[)", line):
            continue
        heading = re.match(r"^\s*(?:[*#]*\s*)?(画面|画面描述|运镜|人物动作|微表情|光影质感|环境音|AI视频提示词)\s*[:：]\s*(.*)$", line)
        if heading:
            protected_section = True
            line = heading[2]
        elif re.match(r"^\s*(?:【镜头|\[Shot|[^:：]{1,15}[:：]\s*$|时长[:：]|景别[:：])", line):
            protected_section = False
        original = prose(line)
        if (len(original) >= 20 or (protected_section and original)) and original not in formatted:
            raise ValueError(
                "H3 formatting changed an original description at source line "
                f"{line_number}; restore that complete line verbatim. Original prompt is unchanged"
            )
    return _mixed_preview(text, options)
