// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { LockKeyhole } from "lucide-react";

export function ProductSurfaceUnavailable({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center px-6 text-center">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-card-foreground">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <LockKeyhole className="size-5" aria-hidden="true" />
        </div>
        <h1 className="text-base font-semibold">功能未开放</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        {retry ? (
          <button
            type="button"
            onClick={retry}
            className="mt-4 inline-flex h-9 items-center justify-center rounded-full border border-border px-4 text-sm font-medium transition-colors hover:bg-muted"
          >
            重新加载
          </button>
        ) : null}
      </div>
    </div>
  );
}
