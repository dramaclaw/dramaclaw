from __future__ import annotations

import argparse
import base64
from copy import deepcopy
import json
import mimetypes
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any


class BlockWorldUnavailable(RuntimeError):
    """Raised when the optional Node.js runtime needed for voxel build is missing."""

    error_code = "BLOCK_WORLD_UNAVAILABLE"

    def __init__(self, message: str | None = None) -> None:
        super().__init__(
            message
            or "voxel DirectorWorld 生成需要 Node.js 运行时。CE 镜像 INSTALL_WORLD=1 已内置；"
            "host 运行需自行安装 node。"
        )


def node_available() -> bool:
    return shutil.which("node") is not None


try:
    from .supertale_lanzhou_demo import PALETTE, BlockWorld
    from .supertale_voxel_palette import (
        custom_block_meta,
        ensure_block_type,
        global_object_type_registry,
        normalize_block_type,
        palette_prompt_text,
    )
except ImportError:  # pragma: no cover - allows direct script execution
    from supertale_lanzhou_demo import PALETTE, BlockWorld
    from supertale_voxel_palette import (
        custom_block_meta,
        ensure_block_type,
        global_object_type_registry,
        normalize_block_type,
        palette_prompt_text,
    )


AIR_BLOCK_TYPE = "__air__"
AIR_ALIASES = {"air", "empty", "none", "clear"}
CONST_NUMBER_ARRAY_PATTERN = re.compile(
    r"\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*\[([^\]]*)\]\s*;?",
    re.DOTALL,
)
ARRAY_FOREACH_PATTERN = re.compile(
    r"\b([A-Za-z_]\w*)\.forEach\(\s*\(?\s*([A-Za-z_]\w*)\s*\)?\s*=>\s*\{(.*?)\}\s*\)\s*;?",
    re.DOTALL,
)
NODE_BUILD_EXECUTOR = r"""
const vm = require('node:vm');

let code = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  code += chunk;
});
process.stdin.on('end', () => {
  const maxOps = Number(process.env.SUPERTALE_JS_MAX_OPS || '200000');
  const operations = [];

  function finiteInt(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${label} must be a finite number, got ${String(value)}`);
    }
    return Math.trunc(value);
  }

  function blockType(value) {
    if (typeof value !== 'string') {
      throw new Error(`blockType must be a string, got ${String(value)}`);
    }
    return value;
  }

  function cleanOptions(value) {
    if (value == null) {
      return {};
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('safeFill options must be an object');
    }
    const out = {};
    if (typeof value.mode === 'string') {
      out.mode = value.mode;
    }
    return out;
  }

  function pushOperation(op) {
    operations.push(op);
    if (operations.length > maxOps) {
      throw new Error(`Too many build operations: ${operations.length} > ${maxOps}`);
    }
  }

  const sandbox = {
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    parseInt,
    parseFloat,
    isFinite,
    NaN,
    Infinity,
    undefined,
    safeFill(...rawArgs) {
      let args = rawArgs.slice();
      let options = {};
      if (
        args.length > 0 &&
        args[args.length - 1] != null &&
        typeof args[args.length - 1] === 'object' &&
        !Array.isArray(args[args.length - 1])
      ) {
        options = args.pop();
      }
      if (args.length === 6 && typeof args[5] === 'string') {
        // Common model shorthand for a rectangle on one z plane:
        // safeFill(x1, y1, z, x2, y2, blockType)
        args = [args[0], args[1], args[2], args[3], args[4], args[2], args[5]];
      }
      if (args.length !== 7) {
        throw new Error(`safeFill expects 7 args, or 6-arg same-z shorthand; got ${args.length}`);
      }
      const [x1, y1, z1, x2, y2, z2, type] = args;
      pushOperation({
        name: 'safeFill',
        args: [
          finiteInt(x1, 'x1'),
          finiteInt(y1, 'y1'),
          finiteInt(z1, 'z1'),
          finiteInt(x2, 'x2'),
          finiteInt(y2, 'y2'),
          finiteInt(z2, 'z2'),
          blockType(type),
        ],
        options: cleanOptions(options),
      });
    },
    safeSetBlock(x, y, z, type) {
      pushOperation({
        name: 'safeSetBlock',
        args: [
          finiteInt(x, 'x'),
          finiteInt(y, 'y'),
          finiteInt(z, 'z'),
          blockType(type),
        ],
      });
    },
    console: {
      log() {},
      warn() {},
      error() {},
    },
  };
  const globalProxy = new Proxy(sandbox, {
    has(_target, property) {
      return property !== Symbol.unscopables;
    },
    get(target, property) {
      if (property in target) {
        return target[property];
      }
      if (typeof property === 'string' && /^[A-Za-z_]\w*$/.test(property)) {
        // BuilderGPT compatibility: allow safeFill(..., floor) as safeFill(..., "floor").
        // Unknown object-class identifiers are registered later as scene-local fixtures.
        return property;
      }
      return undefined;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  });
  sandbox.globalThis = globalProxy;

  try {
    const context = vm.createContext(globalProxy, {
      name: 'SuperTaleDirectorWorld',
      codeGeneration: {strings: false, wasm: false},
    });
    const script = new vm.Script(code, {filename: 'model-build-code.js'});
    script.runInContext(context, {timeout: 3000});
    const topLevelOperationCount = operations.length;
    if (topLevelOperationCount === 0) {
      vm.runInContext(
        "if (typeof buildCreation === 'function') { buildCreation(0, 0, 0); }",
        context,
        {timeout: 3000},
      );
    }
    process.stdout.write(JSON.stringify({operations}));
  } catch (error) {
    process.stderr.write((error && error.stack) ? error.stack : String(error));
    process.exit(1);
  }
});
"""


SYSTEM_PROMPT = """You are a Minecraft-style block world builder for SuperTale.

You must create an explorable block-world stage for children and directors.
The output is not a realistic render. It is an editable voxel scene seed.

You may only use these helper functions:

function safeFill(x1, y1, z1, x2, y2, z2, blockType, options = {}) {}
function safeSetBlock(x, y, z, blockType) {}

You may use normal JavaScript inside buildCreation: const/let variables, arrays,
objects, helper functions, for/while loops, forEach/map-style iteration, and
simple calculations. The runtime will execute your JavaScript and record only
safeFill/safeSetBlock operations.

Allowed block types and custom fixtures:
%PALETTE%

You may also create new custom fixed-fixture block types when the palette lacks
the object you need. Custom types must be lowercase snake_case nouns such as
glass_wall, ticket_gate, vending_machine, noodle_pot, roof_beam, bridge_arch,
altar_table, or wooden_table. They become editable semantic object labels, not
final render materials.

Coordinate rules:
- x = left/right, y = up, z = front/back.
- Ground is y=0.
- Typical indoor room bounds should stay within x,z = -24..24 and y = 0..14.
- Use safeFill for floors, walls, counters, windows, tables, shelves, and large repeated features.
- Use safeSetBlock for details such as lamps, sign marks, small fixtures, and repeated landmarks.
- Build a rich but playable/editable structure, not a dense sculpture.
- Leave enough open floor space for a camera and children to navigate.

Image-grounding rules:
- If a reference image is attached, treat it as the primary evidence for the world.
- Preserve the reference image's scene category, main spatial layout, major openings,
  large fixture positions, object counts where readable, density, and landmark hierarchy.
- Do not replace the image with a generic room, generic street, or generic restaurant.
- If the text and image conflict, use the image for visible spatial anchors and use
  the text only to fill hidden or ambiguous areas.
- If a visible object has no exact palette block type, either map it to the nearest
  object-class block or create a clear custom fixed-fixture block type.

Design requirements:
- Make the major spatial anchors legible from a 3D camera.
- Use block types as object classes, not materials. For example: every table is table,
  every chair/stool is chair, every window is window. Do not use pure material/color
  names such as wood, steel, glass, red, yellow, tile, or paint as standalone block types.
- A custom type may include a material/style adjective only when it identifies a
  recognizable fixture variant, such as glass_wall or wooden_table. The material
  is still not final-art truth; render-stage references decide final materials.
- Voxel colors are only semantic labels for object recognition. They are not final
  scene colors and do not describe real material.
- This task generates a scene-level DirectorWorld. Do not place actors, people,
  character markers, or beat-specific tracked props unless the user explicitly asks
  for a beat-blocking world. actor_* and prop_* are normally added later per beat.
- Do not invent actor_* or prop_* names for scene-level worlds.
- Do not output JSON.
- Do not explain the code.

Return exactly this format:

<inspiration>
One short sentence.
</inspiration>
<description>
One short paragraph.
</description>
<code>
function buildCreation(startX, startY, startZ) {
  // use JavaScript to place safeFill and safeSetBlock operations
}
</code>
"""


def load_dotenv_files() -> None:
    try:
        from dotenv import load_dotenv
    except Exception:
        return
    # Load .env from the current working directory (the project run context) and
    # fall back to dotenv's default upward search. The previous repo-root anchor
    # (BuilderGPT/..) no longer applies after migration into the package.
    load_dotenv(Path.cwd() / ".env", override=False)
    load_dotenv(override=False)


def fresh_scene_palette() -> dict[str, dict[str, str]]:
    return {
        block_type: meta
        for block_type, meta in deepcopy(PALETTE).items()
        if not block_type.startswith(("actor_", "prop_"))
    }


def palette_text(palette: dict[str, dict[str, str]] | None = None) -> str:
    return palette_prompt_text(palette or PALETTE)


def build_user_prompt(description: str) -> str:
    return f"""Build a semantic voxel DirectorWorld from the attached reference.

{description.strip()}

Prioritize the reference image layout, fixed object positions, relative scale,
clear paths, and editable semantic object labels. Do not overfit small texture.
"""


def image_to_data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def call_openai_chat(
    *,
    system_prompt: str,
    user_prompt: str,
    image_path: Path | None = None,
    image_paths: list[Path] | None = None,
    model: str,
    api_key: str,
    base_url: str | None,
) -> str:
    from openai import OpenAI

    kwargs: dict[str, Any] = {"api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url
    client = OpenAI(**kwargs)

    user_content: str | list[dict[str, Any]]
    resolved_image_paths = image_paths or (
        [image_path] if image_path is not None else []
    )
    if resolved_image_paths:
        user_content = [{"type": "text", "text": user_prompt}]
        for path in resolved_image_paths:
            user_content.append(
                {"type": "image_url", "image_url": {"url": image_to_data_url(path)}}
            )
    else:
        user_content = user_prompt

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    )
    message = response.choices[0].message.content
    if not message:
        raise RuntimeError("Model returned empty content")
    return message


def extract_code(text: str) -> str:
    tag_match = re.search(
        r"<code>\s*(.*?)\s*</code>", text, flags=re.DOTALL | re.IGNORECASE
    )
    if tag_match:
        return tag_match.group(1)
    fence_match = re.search(r"```(?:javascript|js)?\s*(.*?)```", text, flags=re.DOTALL)
    if fence_match:
        return fence_match.group(1)
    return text


def split_args(arg_src: str) -> list[str]:
    args: list[str] = []
    current: list[str] = []
    quote: str | None = None
    escape = False
    brace_depth = 0
    bracket_depth = 0
    paren_depth = 0
    for char in arg_src:
        if quote:
            current.append(char)
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == quote:
                quote = None
            continue
        if char in {"'", '"'}:
            quote = char
            current.append(char)
            continue
        if char == "{":
            brace_depth += 1
        elif char == "}":
            brace_depth = max(0, brace_depth - 1)
        elif char == "[":
            bracket_depth += 1
        elif char == "]":
            bracket_depth = max(0, bracket_depth - 1)
        elif char == "(":
            paren_depth += 1
        elif char == ")":
            paren_depth = max(0, paren_depth - 1)
        if char == "," and brace_depth == 0 and bracket_depth == 0 and paren_depth == 0:
            args.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    if current:
        args.append("".join(current).strip())
    return args


def parse_int_arg(value: str) -> int:
    clean = value.strip()
    origin_match = re.fullmatch(
        r"(?:startX|startY|startZ)(?:\s*([+-])\s*([-+]?\d+(?:\.\d+)?))?",
        clean,
    )
    if origin_match:
        sign, offset = origin_match.groups()
        if offset is None:
            return 0
        value_num = float(offset)
        return int(value_num if sign == "+" else -value_num)
    if not re.fullmatch(r"[-+]?\d+(?:\.\d+)?", clean):
        raise ValueError(
            f"Only numeric coordinate literals are supported, got: {value!r}"
        )
    return int(float(clean))


def parse_number_list(value: str) -> list[int]:
    numbers: list[int] = []
    for part in value.split(","):
        clean = part.strip()
        if not clean:
            continue
        numbers.append(parse_int_arg(clean))
    return numbers


def substitute_loop_var(src: str, var_name: str, value: int) -> str:
    escaped = re.escape(var_name)

    def repl_var_first(match: re.Match[str]) -> str:
        sign = match.group(1)
        offset = int(float(match.group(2)))
        return str(value + offset if sign == "+" else value - offset)

    def repl_number_first(match: re.Match[str]) -> str:
        base = int(float(match.group(1)))
        sign = match.group(2)
        return str(base + value if sign == "+" else base - value)

    src = re.sub(rf"\b{escaped}\b\s*([+-])\s*([-+]?\d+(?:\.\d+)?)", repl_var_first, src)
    src = re.sub(
        rf"([-+]?\d+(?:\.\d+)?)\s*([+-])\s*\b{escaped}\b", repl_number_first, src
    )
    return re.sub(rf"\b{escaped}\b", str(value), src)


def expand_simple_foreach_loops(code: str) -> str:
    arrays: dict[str, list[int]] = {}
    for match in CONST_NUMBER_ARRAY_PATTERN.finditer(code):
        arrays[match.group(1)] = parse_number_list(match.group(2))

    code = CONST_NUMBER_ARRAY_PATTERN.sub("", code)

    def repl(match: re.Match[str]) -> str:
        array_name, var_name, body = match.groups()
        values = arrays.get(array_name)
        if values is None:
            return match.group(0)
        return "\n".join(substitute_loop_var(body, var_name, value) for value in values)

    previous = None
    while previous != code:
        previous = code
        code = ARRAY_FOREACH_PATTERN.sub(repl, code)
    return code


def execute_build_code_with_node(
    code: str, *, timeout_seconds: int = 8
) -> list[dict[str, Any]]:
    """Execute model build JS in a restricted Node VM and return safe build operations."""
    node_path = shutil.which("node")
    if not node_path:
        raise BlockWorldUnavailable()
    try:
        result = subprocess.run(
            [node_path, "-e", NODE_BUILD_EXECUTOR],
            input=code,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_seconds,
            env={**os.environ, "SUPERTALE_JS_MAX_OPS": "200000"},
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Generated JS timed out while building DirectorWorld") from exc

    if result.returncode != 0:
        stderr = result.stderr.strip()
        raise ValueError(f"Generated JS failed while building DirectorWorld:\n{stderr}")

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Generated JS returned invalid operation JSON: {result.stdout!r}"
        ) from exc

    operations = payload.get("operations")
    if not isinstance(operations, list):
        raise ValueError("Generated JS did not return an operation list")
    return operations


def parse_block_type(value: str, palette: dict[str, dict[str, str]]) -> str:
    match = re.fullmatch(r"\s*['\"]([^'\"]+)['\"]\s*", value)
    if not match:
        raise ValueError(f"Block type must be a quoted string literal, got: {value!r}")
    return coerce_block_type(match.group(1), palette)


def coerce_block_type(value: str, palette: dict[str, dict[str, str]]) -> str:
    block_type = normalize_block_type(value)
    if block_type in AIR_ALIASES:
        return AIR_BLOCK_TYPE
    return ensure_block_type(block_type, palette)


def parse_mode_arg(value: str | None) -> str:
    if not value:
        return "replace"
    if re.search(r"mode\s*:\s*['\"]hollow['\"]", value):
        return "hollow"
    if re.search(r"mode\s*:\s*['\"]keep['\"]", value):
        return "keep"
    return "replace"


def normalize_op_mode(options: Any) -> str:
    if not isinstance(options, dict):
        return "replace"
    mode = options.get("mode")
    if mode in {"hollow", "keep"}:
        return str(mode)
    return "replace"


def iter_box_coords(x1: int, y1: int, z1: int, x2: int, y2: int, z2: int):
    min_x, max_x = sorted((int(x1), int(x2)))
    min_y, max_y = sorted((int(y1), int(y2)))
    min_z, max_z = sorted((int(z1), int(z2)))
    for x in range(min_x, max_x + 1):
        for y in range(min_y, max_y + 1):
            for z in range(min_z, max_z + 1):
                yield (x, y, z)


def apply_build_operation(
    world: BlockWorld,
    operation: dict[str, Any],
    scene_palette: dict[str, dict[str, str]],
) -> None:
    name = operation.get("name")
    args = operation.get("args")
    if not isinstance(args, list):
        raise ValueError(f"Build operation args must be a list, got: {operation!r}")

    if name == "safeSetBlock":
        if len(args) < 4:
            raise ValueError(f"safeSetBlock requires 4 args, got {len(args)}")
        x, y, z = [int(arg) for arg in args[:3]]
        block_type = coerce_block_type(str(args[3]), scene_palette)
        if block_type == AIR_BLOCK_TYPE:
            world.remove([(x, y, z)])
            return
        world.safe_set_block(x, y, z, block_type)
        return

    if name == "safeFill":
        if len(args) < 7:
            raise ValueError(f"safeFill requires 7 args, got {len(args)}")
        x1, y1, z1, x2, y2, z2 = [int(arg) for arg in args[:6]]
        block_type = coerce_block_type(str(args[6]), scene_palette)
        if block_type == AIR_BLOCK_TYPE:
            world.remove(iter_box_coords(x1, y1, z1, x2, y2, z2))
            return
        world.safe_fill(
            x1,
            y1,
            z1,
            x2,
            y2,
            z2,
            block_type,
            mode=normalize_op_mode(operation.get("options")),
        )
        return

    raise ValueError(f"Unsupported build operation: {name!r}")


def apply_build_operations(
    world: BlockWorld,
    operations: list[dict[str, Any]],
    scene_palette: dict[str, dict[str, str]],
) -> None:
    if not operations:
        raise ValueError("No safeFill/safeSetBlock calls found in model output")
    for operation in operations:
        apply_build_operation(world, operation, scene_palette)


def parse_build_code(
    code: str,
    *,
    palette: dict[str, dict[str, str]] | None = None,
) -> BlockWorld:
    scene_palette = palette if palette is not None else fresh_scene_palette()
    world = BlockWorld(palette=scene_palette)
    try:
        operations = execute_build_code_with_node(code)
    except RuntimeError:
        operations = []
    else:
        apply_build_operations(world, operations, scene_palette)
        return world

    code = expand_simple_foreach_loops(code)
    call_pattern = re.compile(r"\b(safeFill|safeSetBlock)\s*\((.*?)\)\s*;?", re.DOTALL)
    calls = list(call_pattern.finditer(code))
    if not calls:
        raise ValueError("No safeFill/safeSetBlock calls found in model output")

    for call in calls:
        name = call.group(1)
        args = split_args(call.group(2))
        if name == "safeSetBlock":
            if len(args) < 4:
                raise ValueError(f"safeSetBlock requires 4 args, got {len(args)}")
            x, y, z = [parse_int_arg(arg) for arg in args[:3]]
            block_type = parse_block_type(args[3], scene_palette)
            if block_type == AIR_BLOCK_TYPE:
                world.remove([(x, y, z)])
                continue
            world.safe_set_block(x, y, z, block_type)
        elif name == "safeFill":
            if len(args) < 7:
                raise ValueError(f"safeFill requires at least 7 args, got {len(args)}")
            x1, y1, z1, x2, y2, z2 = [parse_int_arg(arg) for arg in args[:6]]
            block_type = parse_block_type(args[6], scene_palette)
            if block_type == AIR_BLOCK_TYPE:
                world.remove(iter_box_coords(x1, y1, z1, x2, y2, z2))
                continue
            mode = parse_mode_arg(args[7] if len(args) > 7 else None)
            world.safe_fill(x1, y1, z1, x2, y2, z2, block_type, mode=mode)
    return world


def strip_scene_entity_blocks(world: BlockWorld) -> None:
    """Scene-level worlds should not persist actor/prop marker blocks."""
    world.remove(
        coord
        for coord, block_type in list(world.blocks.items())
        if str(block_type).startswith(("actor_", "prop_"))
    )


def normalize_world_floor(world: BlockWorld) -> None:
    if not world.blocks:
        return
    min_y = min(y for _x, y, _z in world.blocks)
    if min_y >= 0:
        return
    shift = -min_y
    world.blocks = {
        (x, y + shift, z): block_type for (x, y, z), block_type in world.blocks.items()
    }


def validate_world(
    world: BlockWorld, *, max_blocks: int, max_abs_coord: int, max_y: int
) -> None:
    if len(world.blocks) > max_blocks:
        raise ValueError(
            f"Generated too many blocks: {len(world.blocks)} > {max_blocks}"
        )
    for x, y, z in world.blocks:
        if abs(x) > max_abs_coord or abs(z) > max_abs_coord:
            raise ValueError(f"Coordinate out of range: {(x, y, z)}")
        if y < 0 or y > max_y:
            raise ValueError(f"Y coordinate out of range: {(x, y, z)}")


def camera_presets_from_bounds(bounds: dict[str, list[int]]) -> list[dict[str, Any]]:
    min_x, min_y, min_z = bounds["min"]
    max_x, max_y, max_z = bounds["max"]
    cx = (min_x + max_x) / 2
    cy = max(2.0, (min_y + max_y) / 2)
    cz = (min_z + max_z) / 2
    span_x = max(8, max_x - min_x + 1)
    span_z = max(8, max_z - min_z + 1)
    return [
        {
            "id": "front_overview",
            "label": "正面全景",
            "position": [
                round(cx, 2),
                round(cy + 3, 2),
                round(min_z - span_z * 0.55, 2),
            ],
            "target": [round(cx, 2), round(cy, 2), round(cz, 2)],
            "fov": 58,
        },
        {
            "id": "left_side",
            "label": "左侧机位",
            "position": [
                round(min_x - span_x * 0.55, 2),
                round(cy + 2, 2),
                round(cz, 2),
            ],
            "target": [round(cx, 2), round(cy, 2), round(cz, 2)],
            "fov": 60,
        },
        {
            "id": "interior_corner",
            "label": "室内角落",
            "position": [round(max_x + 4, 2), round(cy + 1.2, 2), round(min_z - 4, 2)],
            "target": [round(cx, 2), round(cy, 2), round(cz, 2)],
            "fov": 62,
        },
        {
            "id": "top_down",
            "label": "俯视布局",
            "position": [
                round(cx, 2),
                round(max_y + max(span_x, span_z) * 0.95, 2),
                round(cz, 2),
            ],
            "target": [round(cx, 2), 0, round(cz, 2)],
            "fov": 45,
        },
    ]


def world_to_scene_spec(
    *,
    world: BlockWorld,
    palette: dict[str, dict[str, str]],
    scene_id: str,
    display_name: str,
    description: str,
    reference_image_path: str | None,
    raw_model_output_path: str | None,
) -> dict[str, Any]:
    bounds = world.bounds()
    used_types = {str(block_type) for block_type in world.blocks.values()}
    global_registry = global_object_type_registry()
    scene_palette = {}
    local_type_registry = {}
    for block_type in sorted(used_types):
        meta = palette.get(block_type) or global_registry.get(block_type)
        if meta is None:
            meta = custom_block_meta(block_type)
        scene_palette[block_type] = meta
        if block_type not in global_registry:
            local_type_registry[block_type] = meta
    return {
        "schema_version": "minecraft_scene_spec_v0",
        "scene_id": scene_id,
        "display_name": display_name,
        "generator": "novelvideo.director_world.block_world_builder",
        "grid": {
            "block_size_m": 0.45,
            "axes": "x_right_y_up_z_forward",
            "origin": "room_center_floor",
        },
        "palette": scene_palette,
        "local_type_registry": local_type_registry,
        "bounds": bounds,
        "blocks": world.sorted_blocks(),
        "camera_presets": camera_presets_from_bounds(bounds),
        "source": {
            "description": description,
            "reference_image": reference_image_path or "",
            "raw_model_output": raw_model_output_path or "",
        },
        "notes": "AI-generated editable Minecraft-style block world seed.",
    }


def default_output_path(path: str) -> Path:
    output_path = Path(path)
    if output_path.is_absolute():
        return output_path
    # Relative outputs resolve against the current working directory (the project
    # run context). Production always passes an absolute --output.
    return (Path.cwd() / output_path).resolve()


def resolve_model_config(
    args: argparse.Namespace,
    *,
    egress_context=None,
) -> tuple[str, str, str | None]:
    from novelvideo.task_backend.subprocesses import require_direct_model_egress_allowed

    require_direct_model_egress_allowed(egress_context)
    provider = (
        os.environ.get("BLOCK_WORLD_MODEL_PROVIDER")
        or os.environ.get("MODEL_PROVIDER")
        or "openai"
    ).lower()
    model = (
        args.model
        or os.environ.get("BLOCK_WORLD_MODEL")
        or os.environ.get("OPENAI_TEXT_MODEL")
        or os.environ.get("MODEL_NAME")
        or "gpt-5.4"
    )
    base_url = (
        args.base_url
        or os.environ.get("BLOCK_WORLD_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("OPENAI_API_BASE")
        or None
    )

    key_candidates = [args.api_key, os.environ.get("BLOCK_WORLD_API_KEY")]
    if provider == "openrouter" or "/" in model:
        base_url = base_url or "https://openrouter.ai/api/v1"
        key_candidates.extend(
            [
                os.environ.get("OPENROUTER_API_KEY"),
                os.environ.get("MODEL_API_KEY"),
                os.environ.get("OPENAI_API_KEY"),
            ]
        )
    else:
        key_candidates.extend(
            [
                os.environ.get("OPENAI_API_KEY"),
                os.environ.get("MODEL_API_KEY"),
            ]
        )

    api_key = next((value for value in key_candidates if value), "")
    return model, api_key, base_url


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a SuperTale Minecraft-style scene spec from text and optional image."
    )
    parser.add_argument("--description", help="Scene description prompt.")
    parser.add_argument(
        "--description-file", help="Read scene description from a text file."
    )
    parser.add_argument("--image", help="Optional reference image path.")
    parser.add_argument(
        "--image2",
        action="append",
        default=[],
        help="Additional reference image path. Can be passed multiple times.",
    )
    parser.add_argument(
        "--from-code",
        help="Parse an existing model-output/code file instead of calling AI.",
    )
    parser.add_argument(
        "--output",
        default="generated/ai_block_world_scene.json",
        help="Output scene JSON path relative to the current working directory unless absolute.",
    )
    parser.add_argument("--scene-id", default="ai_block_world_scene")
    parser.add_argument("--display-name", default="AI Block World Scene")
    parser.add_argument("--model", default="")
    parser.add_argument("--api-key", default="")
    parser.add_argument("--base-url", default="")
    parser.add_argument("--raw-output", default="")
    parser.add_argument(
        "--prompt-only",
        action="store_true",
        help="Write the prompt and do not call AI.",
    )
    parser.add_argument("--max-blocks", type=int, default=80_000)
    parser.add_argument("--max-abs-coord", type=int, default=96)
    parser.add_argument("--max-y", type=int, default=64)
    args = parser.parse_args()

    load_dotenv_files()

    description = args.description or ""
    if args.description_file:
        description = Path(args.description_file).read_text(encoding="utf-8")
    if not description and not args.from_code:
        raise SystemExit(
            "--description, --description-file, or --from-code is required"
        )

    scene_palette = fresh_scene_palette()
    system_prompt = SYSTEM_PROMPT.replace("%PALETTE%", palette_text(scene_palette))
    user_prompt = build_user_prompt(
        description or "Build a rich editable DirectorWorld stage."
    )

    if args.prompt_only:
        prompt_path = default_output_path(args.output).with_suffix(".prompt.txt")
        prompt_path.parent.mkdir(parents=True, exist_ok=True)
        prompt_path.write_text(
            f"--- system ---\n{system_prompt}\n\n--- user ---\n{user_prompt}\n",
            encoding="utf-8",
        )
        print(f"wrote prompt {prompt_path}")
        return

    reference_image_path = ""
    if args.from_code:
        raw_text = Path(args.from_code).read_text(encoding="utf-8")
    else:
        model, api_key, base_url = resolve_model_config(args)
        if not api_key:
            raise SystemExit(
                "Model API key is missing; set BLOCK_WORLD_API_KEY / OPENROUTER_API_KEY / "
                "OPENAI_API_KEY, or use --prompt-only / --from-code for offline testing"
            )
        image_path = Path(args.image) if args.image else None
        if image_path is not None and not image_path.exists():
            raise SystemExit(f"image not found: {image_path}")
        extra_image_paths = [Path(path) for path in args.image2]
        for extra_image_path in extra_image_paths:
            if not extra_image_path.exists():
                raise SystemExit(f"image2 not found: {extra_image_path}")
        all_image_paths = (
            [image_path] if image_path is not None else []
        ) + extra_image_paths
        reference_image_path = (
            "; ".join(str(path.resolve()) for path in all_image_paths)
            if all_image_paths
            else ""
        )
        raw_text = call_openai_chat(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            image_paths=all_image_paths,
            model=model,
            api_key=api_key,
            base_url=base_url,
        )

    raw_output_path = args.raw_output
    if not raw_output_path:
        raw_output_path = str(default_output_path(args.output).with_suffix(".raw.txt"))
    raw_path = Path(raw_output_path)
    if not raw_path.is_absolute():
        raw_path = default_output_path(raw_output_path)
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_text(raw_text, encoding="utf-8")

    code = extract_code(raw_text)
    world = parse_build_code(code, palette=scene_palette)
    strip_scene_entity_blocks(world)
    normalize_world_floor(world)
    validate_world(
        world,
        max_blocks=args.max_blocks,
        max_abs_coord=args.max_abs_coord,
        max_y=args.max_y,
    )
    scene_spec = world_to_scene_spec(
        world=world,
        palette=scene_palette,
        scene_id=args.scene_id,
        display_name=args.display_name,
        description=description,
        reference_image_path=reference_image_path,
        raw_model_output_path=str(raw_path),
    )

    output_path = default_output_path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(scene_spec, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"wrote {output_path}")
    print(f"raw_model_output={raw_path}")
    print(f"blocks={len(scene_spec['blocks'])} palette={len(scene_spec['palette'])}")


if __name__ == "__main__":
    main()
