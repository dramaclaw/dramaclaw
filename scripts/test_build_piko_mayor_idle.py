# SPDX-License-Identifier: Elastic-2.0
import unittest

from PIL import Image

from build_piko_mayor_idle import FRAME_SPECS, TIMELINE, make_master, pose, split_layers, validate_frames


class MayorIdleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.master = make_master()
        cls.frames = [pose(cls.master, **spec) for _, spec in FRAME_SPECS]

    def test_pixel_contract(self):
        report = validate_frames(self.master, self.frames)
        self.assertEqual(report["frameCount"], 7)
        self.assertEqual(report["cycleDurationMs"], 5280)

    def test_layers_recompose_losslessly(self):
        for frame, (_, spec) in zip(self.frames, FRAME_SPECS):
            combined = Image.new("RGBA", (64, 64))
            for layer in split_layers(frame, spec).values():
                combined.alpha_composite(layer)
            self.assertEqual(combined.tobytes(), frame.tobytes())

    def test_blink_only_changes_eye_regions(self):
        rest = self.frames[0]
        for blink in self.frames[5:]:
            for y in range(64):
                for x in range(64):
                    if rest.getpixel((x, y)) != blink.getpixel((x, y)):
                        self.assertTrue(29 <= y <= 35 and (26 <= x <= 29 or 35 <= x <= 38))

    def test_loop_and_reproducibility(self):
        self.assertEqual(TIMELINE[0][0], TIMELINE[-1][0])
        self.assertEqual(self.master.tobytes(), make_master().tobytes())
        self.assertTrue(all(0 <= frame < len(self.frames) and ms > 0 for frame, ms in TIMELINE))


if __name__ == "__main__":
    unittest.main()
