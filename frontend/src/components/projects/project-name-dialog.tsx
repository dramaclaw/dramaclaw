// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ExternalLink, Link2, Loader2, Pencil, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { getProjectNameValidationKey, listProjectImportSources, renameProject } from "@/lib/project-naming";
import { queryKeys } from "@/lib/query-keys";
import type { ProjectSummary } from "@/types/project";

export type ProjectNameDialogMode = "rename" | "liblib" | "sources";

export function ProjectNamingMenuItems({ canRename, onAction }: {
  canRename: boolean;
  onAction: (mode: ProjectNameDialogMode) => void;
}) {
  const { t } = useTranslation();
  return <>
    {canRename && <>
      <DropdownMenuItem onClick={() => onAction("rename")}>
        <Pencil className="size-4" />{t("project.naming.rename")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onAction("liblib")}>
        <RefreshCw className="size-4" />{t("project.naming.useOriginal")}
      </DropdownMenuItem>
    </>}
    <DropdownMenuItem onClick={() => onAction("sources")}>
      <Link2 className="size-4" />{t("project.naming.sources")}
    </DropdownMenuItem>
  </>;
}

type Props = {
  project: ProjectSummary;
  mode: ProjectNameDialogMode;
  onClose: () => void;
  onSaved: (name: string) => void;
};

export function ProjectNameDialog({ project, mode, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(mode === "liblib" ? "" : project.name);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState("");
  const readOnly = mode === "sources";
  const sources = useQuery({
    queryKey: ["project-import-sources", project.id],
    queryFn: ({ signal }) => listProjectImportSources(project.id, signal),
    retry: false,
  });
  useEffect(() => {
    if (mode === "liblib" && !edited && sources.data?.length === 1) {
      setName(sources.data[0].name);
    }
  }, [mode, edited, sources.data]);
  const trimmed = name.trim();
  const invalid = getProjectNameValidationKey(trimmed);
  const rename = useMutation({
    mutationFn: () => renameProject(project.id, trimmed),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectSummaries() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) });
      toast.success(t("project.naming.saved"));
      onSaved(trimmed);
      onClose();
    },
    onError: (cause) => {
      const status = (cause as { response?: { status?: number } }).response?.status;
      setError(t(status === 409 ? "project.naming.duplicate" : "project.naming.saveFailed"));
    },
  });
  return <Dialog open onOpenChange={(open) => { if (!open && !rename.isPending) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t(`project.naming.${mode === "rename" ? "rename" : mode === "liblib" ? "useOriginal" : "sources"}`)}</DialogTitle>
        <p className="break-words text-sm text-muted-foreground">{project.name}</p>
      </DialogHeader>
      {!readOnly && <div className="space-y-2">
        <label htmlFor="rename-project-name" className="text-sm">{t("project.name")}</label>
        <Input id="rename-project-name" value={name} autoFocus disabled={rename.isPending}
          onChange={(event) => { setName(event.target.value); setEdited(true); setError(""); }}
          aria-invalid={!!invalid || !!error}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && !invalid && !rename.isPending && trimmed !== project.name) {
              event.preventDefault(); rename.mutate();
            }
          }} />
        <p className="text-xs text-muted-foreground">{t("project.naming.renameHint")}</p>
        {(error || (name && invalid)) && <p role="alert" className="text-xs text-destructive">{error || t(invalid!)}</p>}
      </div>}
      <section className="max-h-72 space-y-3 overflow-y-auto">
        <h3 className="text-sm font-medium">{t("project.naming.sources")}</h3>
        {sources.isPending && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("common.loading")}</p>}
        {sources.isError && <div className="text-sm text-destructive">
          <p>{t("project.naming.sourceLoadFailed")}</p>
          <Button variant="ghost" onClick={() => { void sources.refetch(); }}>{t("project.naming.retry")}</Button>
        </div>}
        {sources.data?.length === 0 && <p className="text-sm text-muted-foreground">{t("project.naming.noSources")}</p>}
        {sources.data?.map((source) => <div key={source.canvasId} className="space-y-2 rounded-lg border border-border p-3">
          <p className="break-words text-sm font-medium">{source.name || t("project.naming.unnamedSource")}</p>
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-primary hover:underline">
            <ExternalLink className="size-4" />{t("project.naming.openOriginal")}
          </a>
          <p className="break-all text-xs text-muted-foreground">{source.url}</p>
          {!readOnly && source.name && <Button variant="outline" size="sm" disabled={rename.isPending}
            onClick={() => { setName(source.name); setEdited(true); setError(""); }}>{t("project.naming.useOriginal")}</Button>}
        </div>)}
      </section>
      <DialogFooter>
        <Button variant="outline" disabled={rename.isPending} onClick={onClose}>{t(readOnly ? "common.close" : "common.cancel")}</Button>
        {!readOnly && <Button disabled={rename.isPending || !!invalid || trimmed === project.name} onClick={() => rename.mutate()}>
          {rename.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}{t("common.save")}
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
