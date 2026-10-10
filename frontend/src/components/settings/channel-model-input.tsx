// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Combobox } from "@base-ui/react/combobox";
import { ChevronDown, Loader2, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChannelModels, type ChannelModelsInput } from "@/lib/queries/model-gateway";
import { cn } from "@/lib/utils";

interface ChannelModelInputProps extends ChannelModelsInput {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function ChannelModelInput(props: ChannelModelInputProps) {
  const { t } = useTranslation();
  const query = useChannelModels({
    provider: props.provider,
    newApiBaseUrl: props.newApiBaseUrl,
    database: props.database,
  });
  const models = query.data?.data.models ?? [];
  const canFetch = Boolean(props.provider && props.newApiBaseUrl && props.provider !== "comfyui");

  return (
    <Combobox.Root
      modal={false}
      items={models}
      value={models.includes(props.value) ? props.value : null}
      inputValue={props.value}
      onInputValueChange={(value, details) => {
        // Free-form model names must survive the combobox's dismiss reset.
        if (details.reason === "input-clear") {
          details.cancel();
          return;
        }
        props.onChange(value);
      }}
      onValueChange={(value) => { if (value !== null) props.onChange(value); }}
      onOpenChange={(open) => {
        if (open && canFetch && !query.data && !query.isFetching) void query.refetch();
      }}
      disabled={props.disabled}
    >
      <div className="relative min-w-0 flex-1">
        <Combobox.Input
          aria-label={props.placeholder || t("settings.modelConfig.channelModels.inputLabel")}
          placeholder={props.placeholder}
          render={<Input className={cn(
            "h-8 rounded-md border-input/80 pr-8 focus-visible:border-ring/70 focus-visible:ring-1 focus-visible:ring-ring/30",
            props.className,
          )} />}
        />
        <Combobox.Trigger
          aria-label={t("settings.modelConfig.channelModels.select")}
          disabled={props.disabled || !canFetch}
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-md text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
        >
          {query.isFetching ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronDown className="size-3.5" />}
        </Combobox.Trigger>
      </div>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} align="start" className="z-50">
          <Combobox.Popup className="w-(--anchor-width) min-w-48 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
            <div className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
              {t("settings.modelConfig.channelModels.manualHint")}
            </div>
            <Combobox.Empty className="px-3 py-3 text-xs text-muted-foreground" role={query.isError ? "alert" : "status"}>
              {query.isFetching
                ? t("settings.modelConfig.channelModels.loading")
                : query.isError
                  ? t("settings.modelConfig.channelModels.fetchFailed")
                  : t("settings.modelConfig.channelModels.empty")}
            </Combobox.Empty>
            <Combobox.List className="max-h-56 overflow-y-auto p-1">
              {(model: string) => (
                <Combobox.Item
                  key={model}
                  value={model}
                  title={model}
                  className="cursor-default truncate rounded px-2 py-1.5 text-xs outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  {model}
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

export function ChannelModelsButton(props: ChannelModelsInput & { disabled?: boolean }) {
  const { t } = useTranslation();
  const query = useChannelModels({
    provider: props.provider,
    newApiBaseUrl: props.newApiBaseUrl,
    database: props.database,
  });
  return (
    <div className="min-w-0">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 whitespace-nowrap px-2 text-[11px]"
        disabled={props.disabled || query.isFetching}
        title={props.disabled ? t("settings.modelConfig.channelModels.syncFirst") : t("settings.modelConfig.channelModels.manualHint")}
        onClick={() => void query.refetch()}
      >
        {query.isFetching ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
        {t("settings.modelConfig.channelModels.fetch")}
        {query.data ? ` (${query.data.data.models.length})` : ""}
      </Button>
      {query.isError ? (
        <p role="alert" className="mt-1 max-w-56 text-[11px] text-destructive">
          {t("settings.modelConfig.channelModels.fetchFailed")}
        </p>
      ) : null}
    </div>
  );
}
