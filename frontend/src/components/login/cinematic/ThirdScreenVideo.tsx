import { ScrollVideoScene } from "./ScrollVideoScene";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();

  return (
    <ScrollVideoScene
      align="right"
      copyExitProgress={copyExitProgress}
      copyProgress={copyProgress}
      isActive={isActive}
      kicker="CUT TO THE NEXT"
      subtitle={t("loginCinematic.third.subtitle")}
      title={t("loginCinematic.third.title")}
      videoExitProgress={videoExitProgress}
      videoOpacity={videoOpacity}
      videoUrl={cinematicVideos.jqr}
    />
  );
}
