import { describe, expect, it } from "vitest";
import { browserPlaybackUrl } from "@/features/canvas/application/videoPlaybackUrl";

const origin = "http://localhost:5173";
const imported = "/static/projects/project/freezone/liblib_import/canvas/media/clip.mp4?v=123";

describe("browserPlaybackUrl", () => {
  it("opts imported local MP4 playback into the H.264 copy without changing its version", () => {
    expect(browserPlaybackUrl(imported, origin)).toBe(`${imported}&st_video=h264`);
    expect(browserPlaybackUrl(`${origin}${imported}#t=1`, origin))
      .toBe(`${origin}${imported}&st_video=h264#t=1`);
  });

  it("leaves model sources and unrelated media URLs untouched", () => {
    expect(browserPlaybackUrl(null, origin)).toBeNull();
    expect(browserPlaybackUrl("blob:http://localhost:5173/abc", origin))
      .toBe("blob:http://localhost:5173/abc");
    expect(browserPlaybackUrl("https://libtv-res.liblib.art/clip.mp4", origin))
      .toBe("https://libtv-res.liblib.art/clip.mp4");
    expect(browserPlaybackUrl("/static/projects/project/freezone/_outputs/clip.mp4", origin))
      .toBe("/static/projects/project/freezone/_outputs/clip.mp4");
  });
});
