"""Apply a backed-up local workbench fix without changing workflow JSON files."""

import argparse
import ast
import shutil
from datetime import datetime
from pathlib import Path

OLD = '''        if filename:
            set_image_from_link(prompt, inputs.get(key), filename)
        else:
            inputs.pop(key, None)'''
NEW = '''        if filename:
            # H3 already scales full reference images proportionally with Lanczos.
            # Avoid the template's output-aspect crop, which removes identity detail.
            link = inputs.get(key)
            resize = linked_node(prompt, link)
            if resize.get("class_type") == "ImageResizeKJv2":
                source = resize.get("inputs", {}).get("image")
                if linked_node(prompt, source).get("class_type") != "LoadImage":
                    raise ValueError("Reference resize must be connected to LoadImage")
                inputs[key] = source
            set_image_from_link(prompt, inputs.get(key), filename)
        else:
            inputs.pop(key, None)'''


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbench", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    path = args.workbench.resolve(strict=True)
    text = path.read_text(encoding="utf-8")
    start = text.index("def _apply_reference_images(")
    end = text.index("\ndef _apply_reference_videos(", start)
    section = text[start:end]
    if NEW in section:
        print("Reference images already preserve the complete frame.")
        return
    if section.count(OLD) != 1:
        raise SystemExit("Unrecognized workbench implementation; no changes made.")
    patched = text[:start] + section.replace(OLD, NEW) + text[end:]
    ast.parse(patched)
    if not args.apply:
        print("Compatible workbench: only full-reference image resize will be bypassed.")
        return
    backup = path.with_name(path.name + ".before-reference-resize-" + datetime.now().strftime("%Y%m%d%H%M%S"))
    shutil.copy2(path, backup)
    path.write_text(patched, encoding="utf-8")
    print("Applied reference image fix. Backup:", backup)


if __name__ == "__main__":
    main()
