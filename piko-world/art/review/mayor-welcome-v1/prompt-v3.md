# 欢迎立绘 v3

内置 imagegen 编辑：加说话笑嘴，再单独去背景。未接入运行时，保留旧版本。

## 嘴部编辑提示词

Use case: identity-preserve / background-extraction. Edit the supplied approved Piko mayor portrait. Make ONLY two changes: (1) add a small friendly slightly open smiling mouth centered below the eyes, aligned with the tilted face, about one third of the width of an eye; simple dark pixel outline and warm muted interior, no teeth, no lips, no nose, no blush; it should feel like the mayor is speaking a warm welcome, not laughing loudly. (2) REMOVE THE BAKED WHITE/GRAY CHECKERBOARD COMPLETELY and output a genuinely transparent RGBA PNG cutout: background pixels must have alpha zero, do NOT paint a checkerboard pattern or white background. Preserve the approved full body pose exactly: tilted stem head and green leaf, staggered tiny feet, asymmetric navy gold-trimmed coat, book hugged at screen left, welcoming open hand at screen right. Preserve exact proportions, eyes, outfit, palette, crisp stepped pixel art, framing, and all character details. Do not redesign or straighten the pose. No panel, words, props, ground, drop shadow, or added elements. Fully visible character with transparent margins.

## 透明处理提示词

Background extraction ONLY. Remove all white and gray checkerboard background from the supplied character image. Return the identical character as a transparent PNG with actual alpha transparency. DO NOT DRAW CHECKERBOARD. Background must be empty alpha 0, not a visualization of transparency. Preserve every feature including the small smiling mouth, pose, book, leaf, hands, outline, colors. No redesign, no ground shadow, no new objects. Isolated character cutout with genuine transparent background.
