// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Download, X } from "lucide-react";
import { useState } from "react";

import { useEscapeToClose } from "@/hooks/use-escape-to-close";
import { cn } from "@/lib/utils";
import { ViewportLazyImage } from "@/components/viewport-lazy-image";

export function LightboxImage({
  src,
  alt,
  className,
  fluid = false,
  fit = "cover",
  blurBackdrop = true,
  onError,
}: {
  src: string;
  alt: string;
  className?: string;
  fluid?: boolean;
  fit?: "cover" | "contain";
  blurBackdrop?: boolean;
  onError?: React.ReactEventHandler<HTMLImageElement>;
}) {
  const [open, setOpen] = useState(false);
  useEscapeToClose(open, () => setOpen(false));
  const downloadName =
    `${alt || "image"}.jpg`.replace(/[\\/:*?"<>|]+/g, "-").trim() || "image.jpg";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "relative block cursor-zoom-in overflow-hidden rounded-lg border border-border bg-black/20 p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className ?? "size-36",
        )}
      >
        {!fluid && fit === "contain" && blurBackdrop && (
          <ViewportLazyImage
            src={src}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full scale-110 object-cover opacity-20 blur-md"
          />
        )}
        <ViewportLazyImage
          src={src}
          alt={alt}
          onError={onError}
          className={cn(
            "relative z-10",
            fluid
              ? "block h-auto w-full"
              : cn(
                  "h-full w-full",
                  fit === "contain" ? "object-contain" : "object-cover",
                ),
          )}
        />
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setOpen(false)}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute right-4 top-4 rounded-full bg-background/80 p-2 text-foreground/80 transition duration-150 hover:scale-105 hover:bg-background hover:text-foreground"
          >
            <X className="size-5" />
          </button>
          <a
            href={src}
            download={downloadName}
            aria-label="Download image"
            className="absolute right-14 top-4 rounded-full bg-background/80 p-2 text-foreground/80 transition duration-150 hover:scale-105 hover:bg-background hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <Download className="size-5" />
          </a>
          <img
            src={src}
            alt={alt}
            decoding="async"
            className="h-auto max-h-[70vh] w-auto max-w-[min(68vw,1040px)] rounded-[12px] object-contain shadow-2xl shadow-black/60"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
