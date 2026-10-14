import type { ReactNode } from "react";
import type { PlayerVersion } from "./publication";
import { StoryCover } from "./StoryCover";

/** The author checks the same composition that players will see. */
export function StoryLanding({ release, cover, preview = false, children }: {
  release: PlayerVersion;
  cover?: string;
  preview?: boolean;
  children: ReactNode;
}) {
  const Heading = preview ? "h3" : "h1";
  return (
    <div className="published-story-grid" data-cover-mode={release.cover_mode ?? "landscape"}>
      <div className="published-story-poster">
        <StoryCover src={cover ?? release.cover} mode={release.cover_mode}
          positionX={release.cover_position_x} positionY={release.cover_position_y} />
      </div>
      <section className="published-story-info">
        <Heading>{release.title}</Heading>
        {release.description && <p className="published-story-description">{release.description}</p>}
        {children}
      </section>
    </div>
  );
}
