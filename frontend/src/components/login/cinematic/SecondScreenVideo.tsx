import { ScrollVideoScene } from "./ScrollVideoScene";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();

  return (
    <ScrollVideoScene
      copyExitProgress={copyExitProgress}
      copyProgress={copyProgress}
      isActive={isActive}
      kicker="ENTER THE FRAME"
      layerBackdropOpacity={1}
      subtitle={t("loginCinematic.second.subtitle")}
      title={t("loginCinematic.second.title")}
      videoExitProgress={videoExitProgress}
      videoOpacity={videoOpacity}
      videoUrl={cinematicVideos.pk}
    />
  );
}
