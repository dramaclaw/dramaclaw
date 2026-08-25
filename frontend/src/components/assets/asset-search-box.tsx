// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Searchable = (string | null | undefined)[];

/** Case-insensitive substring match across the given fields. */
export function filterBySearch<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => Searchable,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) =>
    fields(item)
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle)),
  );
}

export function AssetResultCount({
  resultCount,
  totalCount,
}: {
  resultCount: number;
  totalCount: number;
}) {
  return (
    <div
      aria-live="polite"
      className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground"
    >
      {resultCount} / {totalCount}
    </div>
  );
}

export function AssetSearchBox({
  value,
  onValueChange,
  placeholder,
  ariaLabel,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      className={cn("relative w-full min-w-[220px] max-w-[360px]", className)}
    >
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        aria-label={ariaLabel}
        className="h-8 rounded-[8px] border-white/10 bg-white/[0.025] pl-8 pr-8 text-sm shadow-none placeholder:text-muted-foreground/70 focus-visible:border-white/20 focus-visible:ring-2 focus-visible:ring-white/8"
        placeholder={placeholder}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      />
      {value ? (
        <Button
          aria-label={ariaLabel}
          className="absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={() => onValueChange("")}
        >
          <X className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}
