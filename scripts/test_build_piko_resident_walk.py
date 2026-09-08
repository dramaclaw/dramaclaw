# SPDX-License-Identifier: Elastic-2.0
import unittest
from PIL import Image
from build_piko_resident_walk import REVIEW, IDLE, DIRECTIONS, step

class ResidentMotionTests(unittest.TestCase):
    def test_directional_body_weight_is_restrained(self):
        from piko_gait import body_pose
        for direction in ("south", "north"):
            poses = [body_pose(direction, i) for i in range(8)]
            self.assertEqual(max(p.y for p in poses) - min(p.y for p in poses), 1)
        for direction in ("west", "east"):
            poses = [body_pose(direction, i) for i in range(8)]
            self.assertEqual({p.y for p in poses}, {0})

    def test_atlas_contract(self):
        image=Image.open(REVIEW / "resident-m01-motion-v8.png")
        self.assertEqual(image.size,(704,256))
        self.assertEqual(image.mode,"RGBA")
        self.assertEqual(set(image.getchannel("A").tobytes()),{0,255})
        for row in range(4):
            for col in range(11):
                frame=image.crop((col*64,row*64,(col+1)*64,(row+1)*64))
                self.assertEqual(frame.getchannel("A").getbbox()[3],58)

    def test_preserves_approved_south(self):
        image=Image.open(REVIEW / "resident-m01-motion-v8.png")
        for col in range(3):
            expected=Image.open(IDLE / f"frame-{col:02}.png").convert("RGBA")
            self.assertEqual(image.crop((col*64,0,(col+1)*64,64)).tobytes(),expected.tobytes())

    def test_steps_reproduce_from_direction_master(self):
        atlas=Image.open(REVIEW / "resident-m01-motion-v8.png")
        for row,direction in enumerate(DIRECTIONS):
            master=Image.open(REVIEW / f"{direction}-64.png")
            frames=[step(master,direction,i) for i in range(8)]
            self.assertEqual(len({f.tobytes() for f in frames}),8)
            for phase,frame in enumerate(frames):
                self.assertEqual(atlas.crop(((phase+3)*64,row*64,(phase+4)*64,(row+1)*64)).tobytes(),frame.tobytes())

    def test_feet_connect_to_torso_in_every_step(self):
        from piko_leg_rig import RIGS
        for direction in DIRECTIONS:
            master=Image.open(REVIEW / f"{direction}-64.png")
            hem=RIGS[direction]["hem"]
            for phase in range(8):
                frame=step(master,direction,phase)
                opaque={(x,y) for y in range(64) for x in range(64) if frame.getpixel((x,y))[3]}
                reached={p for p in opaque if p[1]==hem-1}
                queue=list(reached)
                while queue:
                    x,y=queue.pop()
                    for dx,dy in ((0,1),(0,-1),(1,0),(-1,0)):
                        p=(x+dx,y+dy)
                        if p in opaque and p not in reached:
                            reached.add(p);queue.append(p)
                self.assertTrue({p for p in opaque if p[1]>=hem} <= reached,(direction,phase))
                self.assertTrue({p for p in opaque if p[1]>=32} <= reached,
                                ("detached arm or leg",direction,phase))

    def test_whole_body_participates_without_resampling(self):
        for direction in DIRECTIONS:
            master=Image.open(REVIEW / f"{direction}-64.png")
            frames=[step(master,direction,i) for i in range(8)]
            if direction in ("south", "north"):
                self.assertGreater(len({f.crop((0,0,64,31)).tobytes() for f in frames}),1)
            palette={p for p in master.getdata() if p[3]}
            for frame in frames:
                self.assertTrue({p for p in frame.getdata() if p[3]} <= palette)
                self.assertEqual(frame.getbbox()[3],58)

    def test_arm_swing_and_wider_side_stride(self):
        for direction in DIRECTIONS:
            master=Image.open(REVIEW / f"{direction}-64.png")
            frames=[step(master,direction,i) for i in range(8)]
            self.assertNotEqual(frames[0].crop((0,32,64,47)).tobytes(),
                                frames[4].crop((0,32,64,47)).tobytes())
            if direction in ("west","east"):
                box=frames[0].crop((0,53,64,58)).getbbox()
                self.assertGreaterEqual(box[2]-box[0],15)

if __name__=="__main__":unittest.main()
