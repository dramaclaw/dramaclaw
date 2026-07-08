import { ScrollVideoScene } from "./ScrollVideoScene";
import { cinematicVideos } from "./media";

export function SecondScreenVideo({
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
      copyExitProgress={copyExitProgress}
      copyProgress={copyProgress}
      isActive={isActive}
      kicker="ENTER THE FRAME"
      layerBackdropOpacity={1}
      subtitle="角色、冲突、镜头，在黑场之后接管一切。"
      title="故事开始失控"
      videoExitProgress={videoExitProgress}
      videoOpacity={videoOpacity}
      videoUrl={cinematicVideos.pk}
    />
  );
}
