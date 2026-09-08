# SPDX-License-Identifier: Elastic-2.0
"""Shared pixel-leg rig: explicit joints and whole shoes, never screen-half cuts."""
from PIL import Image, ImageDraw
from piko_arm_rig import pose_upper
from piko_gait import POSES, body_pose

# Direction-specific attachment points under the approved outfit hem.
RIGS = {
    "south": {"hem": 49, "hips": ((28, 48), (36, 48))},
    "west": {"hem": 47, "hips": ((33, 46), (32, 46))},
    "east": {"hem": 47, "hips": ((32, 46), (33, 46))},
    "north": {"hem": 47, "hips": ((28, 46), (35, 46))},
}


def paint_walk(master, direction, phase):
    rig = RIGS[direction]
    pose = POSES[phase % len(POSES)]
    torso = body_pose(direction, phase)
    frame = Image.new("RGBA", master.size)
    draw = ImageDraw.Draw(frame)
    # Sample the normalized master palette; no gradients, rotation or resampling.
    colors = sorted({p for p in master.getdata() if p[3]})
    def nearest(rgb):
        return min(colors, key=lambda c: sum((a-b)**2 for a,b in zip(c[:3],rgb)))
    outline = nearest((17,21,35))
    trouser = nearest((42,43,44))
    far_trouser = nearest((29,30,33))
    shoe = nearest((35,36,36))
    sole = nearest((183,168,118))
    trim = nearest((181,132,46))
    side = direction in ("west", "east")
    sign = -1 if direction == "west" else 1
    # Rear leg first, then nearer leg; the outfit covers both hip attachments.
    for leg, hip in enumerate(rig["hips"]):
        travel, lift = pose.feet[leg]
        hip = (hip[0], hip[1] + torso.y)
        stride = travel if side else 0
        bottom = 57 - lift
        ankle = (hip[0]+stride*sign, bottom-3)
        knee = (hip[0]+(sign if side and lift else 0), (hip[1]+ankle[1])//2)
        draw.line([hip,knee,ankle],fill=outline,width=5)
        draw.line([hip,knee,ankle],fill=far_trouser if leg==0 else trouser,width=3)
        ax,ay=ankle
        # A complete boot silhouette is drawn per leg, attached at the ankle.
        left,right = (ax-4,ax+2) if direction=="west" else (ax-2,ax+4) if side else (ax-3,ax+2)
        draw.polygon([(ax-2,ay+1),(ax+1,ay+1),(right,bottom-1),(right,bottom),
                      (left,bottom),(left,bottom-1)],fill=outline)
        draw.line((ax-1,ay,ax+1,ay),fill=trim,width=1)
        draw.line((ax-1,ay+1,ax+1,ay+1),fill=shoe,width=1)
        draw.line((left+1,bottom-1,right-1,bottom-1),fill=sole if leg==1 else shoe)
    frame.alpha_composite(pose_upper(master, direction, pose, torso, rig["hem"]),(0,0))
    return frame
