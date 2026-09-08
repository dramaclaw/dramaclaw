# SPDX-License-Identifier: Elastic-2.0
"""Integer-pixel arm posing with fixed shoulders and opposite leg phases."""
from PIL import Image, ImageDraw

# Each polygon isolates a complete sleeve/cuff/hand, not a screen half.
# Order follows the leg rig (far/left first, near/right second).
ARM_MASKS = {
    "south": [([(24,31),(27,34),(25,40),(25,46),(20,46),(20,37)], 32),
              ([(39,31),(42,33),(44,39),(44,46),(40,46),(39,39)], 32)],
    "north": [([(23,31),(26,33),(25,39),(24,44),(20,44),(20,36)], 32),
              ([(38,31),(41,33),(42,38),(42,44),(38,44),(37,37)], 32)],
    "west": [([(33,31),(36,32),(37,38),(36,43),(32,43),(32,36)], 31)],
    "east": [([(29,31),(32,32),(33,37),(32,43),(27,43),(26,36)], 31)],
}


def pose_upper(master, direction, pose, body_pose, hem):
    body = Image.new("RGBA", master.size)
    body.paste(master.crop((0, 0, 64, hem)), (0, 0))
    side = direction in ("west", "east")
    layers = []
    for index, (polygon, shoulder_y) in enumerate(ARM_MASKS[direction]):
        mask = Image.new("L", master.size)
        ImageDraw.Draw(mask).polygon(polygon, fill=255)
        arm = Image.new("RGBA", master.size)
        for y in range(shoulder_y, min(hem, 47)):
            for x in range(64):
                if not mask.getpixel((x,y)) or not master.getpixel((x,y))[3]:
                    continue
                arm.putpixel((x,y), master.getpixel((x,y)))
                # Side arm overlays the torso: reconstruct the hidden tunic.
                body.putpixel((x,y), master.getpixel((30 if direction == "west" else 35,y))
                              if side else (0,0,0,0))
        layers.append((arm, shoulder_y, index))
    torso = body.copy()
    if side:
        arm, shoulder_y, _ = layers[0]
        layers.insert(0, (arm, shoulder_y, -1))
        body = Image.new("RGBA", body.size)
    for arm, shoulder_y, index in layers:
        far = index == -1
        if side and not far:
            body.alpha_composite(torso)
        # Opposite phases; far arm behind torso, near arm in front.
        swing = pose.swing * (-1 if far or (not side and index == 0) else 1)
        amplitude = 6 if far else 5
        for y in range(shoulder_y, min(hem,47)):
            weight = min(1, (y-shoulder_y)/10)
            dx = round(swing * amplitude * weight) * (-1 if direction == "west" else 1) if side else 0
            # Hands rise slightly at the swing extremes instead of sliding flat.
            dy = -round(abs(swing)*weight) if side else round(swing * 2 * weight)
            previous_weight = min(1,max(0,y-1-shoulder_y)/10)
            previous_dy = -round(abs(swing)*previous_weight) if side else round(swing*2*previous_weight)
            # Bridge successive shifted scanlines without scaling/rotation blur.
            previous_dx = round(swing*amplitude*min(1,max(0,y-1-shoulder_y)/10)) * (-1 if direction == "west" else 1) if side else dx
            for x in range(64):
                color = arm.getpixel((x,y))
                if color[3]:
                    for offset in range(min(dx,previous_dx),max(dx,previous_dx)+1):
                        for vertical in range(min(dy,previous_dy),max(dy,previous_dy)+1):
                            # Far shoulder is inset; reuse sleeve colors, not accessories.
                            inset = (-2 if direction == "west" else 2) if far else 0
                            body.putpixel((x+offset+inset,y+vertical),color)
    posed = Image.new("RGBA", body.size)
    # Preserve the approved side silhouette; only front/back has a small dip.
    posed.alpha_composite(body, (0, body_pose.y))
    return posed
