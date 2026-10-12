# SPDX-License-Identifier: Elastic-2.0
import unittest
from PIL import Image
from build_piko_female_motion import REVIEW, RUNTIME, DIRECTIONS
from piko_leg_rig import paint_walk, FEMALE_RIGS


class FemaleMotionTests(unittest.TestCase):
    def test_runtime_atlas_contract(self):
        atlas = Image.open(RUNTIME / 'resident-f01-motion-v2.png')
        self.assertEqual(atlas.size, (704, 256))
        self.assertEqual(atlas.mode, 'RGBA')
        self.assertEqual(set(atlas.getchannel('A').tobytes()), {0, 255})
        for row in range(4):
            frames = [atlas.crop((col*64, row*64, (col+1)*64, (row+1)*64)) for col in range(11)]
            for frame in frames:
                self.assertEqual(frame.getchannel('A').getbbox()[3], 58)
            self.assertNotEqual(frames[0].tobytes(), frames[1].tobytes())
            self.assertEqual(len({frame.tobytes() for frame in frames[3:]}), 8)

    def test_walk_limbs_remain_attached(self):
        for direction in DIRECTIONS:
            master = Image.open(REVIEW / f'{direction}-64.png').convert('RGBA')
            palette = set(master.getdata())
            for phase in range(8):
                frame = paint_walk(master, direction, phase, character='f01')
                self.assertTrue(set(frame.getdata()) <= palette)
                opaque = {(x,y) for y in range(64) for x in range(64) if frame.getpixel((x,y))[3]}
                hem = FEMALE_RIGS[direction]['hem']
                reached = {p for p in opaque if p[1] == hem-1}
                queue = list(reached)
                while queue:
                    x,y = queue.pop()
                    for dx,dy in ((0,1),(0,-1),(1,0),(-1,0)):
                        p = x+dx,y+dy
                        if p in opaque and p not in reached:
                            reached.add(p);queue.append(p)
                self.assertTrue({p for p in opaque if p[1]>=32} <= reached, (direction,phase))


if __name__ == '__main__':
    unittest.main()
