import { useState } from "react";
import { Film } from "lucide-react";

/** Uses actual artwork when available; a failed image never leaves an empty frame. */
export function StoryCover({
  src,
  className = "",
  mode = "landscape",
  positionX = 50,
  positionY = 50,
}: {
  src?: string | null;
  className?: string;
  mode?: "landscape" | "portrait";
  positionX?: number;
  positionY?: number;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <div className={`story-cover ${className}`} data-cover-mode={mode}>
      {src && failedSource !== src ? (
        <img src={src} alt="" style={{ objectPosition: `${positionX}% ${positionY}%` }} onError={() => setFailedSource(src)} />
      ) : (
        <div className="story-cover-placeholder">
          <Film size={32} strokeWidth={1.25} aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
