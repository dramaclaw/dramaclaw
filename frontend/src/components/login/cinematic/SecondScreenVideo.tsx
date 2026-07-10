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
      subtitle="在 DramaClaw 中，创作不再停留在一次提示词和一次生成结果"
      title="从灵感到项目"
      videoExitProgress={videoExitProgress}
      videoOpacity={videoOpacity}
      videoUrl={cinematicVideos.pk}
    />
  );
}
