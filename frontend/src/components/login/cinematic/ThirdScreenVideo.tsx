import { ScrollVideoScene } from "./ScrollVideoScene";
import { cinematicVideos } from "./media";

export function ThirdScreenVideo({
  copyExitProgress = 0,
  copyProgress,
  isActive,
  videoExitProgress = 0,
  videoOpacity,
}: {
  copyExitProgress?: number;
  copyProgress: number;
  isActive: boolean;
  videoExitProgress?: number;
  videoOpacity: number;
}) {
  return (
    <ScrollVideoScene
      align="right"
      copyExitProgress={copyExitProgress}
      copyProgress={copyProgress}
      isActive={isActive}
      kicker="CUT TO THE NEXT"
      subtitle="新的线索、角色、场景，在沉默里重新排列。"
      title="现实开始偏移"
      videoExitProgress={videoExitProgress}
      videoOpacity={videoOpacity}
      videoUrl={cinematicVideos.jqr}
    />
  );
}
