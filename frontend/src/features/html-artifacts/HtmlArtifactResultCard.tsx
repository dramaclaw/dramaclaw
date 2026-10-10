import { ExternalLink, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { openHtmlArtifact } from './api';

export function HtmlArtifactResultCard({output}:{output?:Record<string,unknown>}) {
  const {t}=useTranslation();
  const artifact = output?.html_artifact as Record<string,unknown> | undefined;
  if (typeof output?.project_id !== 'string' || !output.project_id || typeof artifact?.id !== 'string' || !artifact.id || typeof artifact.title !== 'string' || typeof artifact.version !== 'number' || !Number.isInteger(artifact.version) || artifact.version < 1) return null;
  const target = {projectId:output.project_id,artifactId:artifact.id,version:artifact.version};
  return <button type="button" className="mt-2 flex w-full items-center gap-2 rounded-lg border border-border bg-card p-3 text-left text-card-foreground hover:bg-accent" onClick={()=>openHtmlArtifact(target)}>
    <Globe className="size-4 shrink-0"/>
    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{artifact.title}</span><span className="text-xs text-muted-foreground">HTML · v{artifact.version} · {t('htmlArtifact.open')}</span></span>
    <ExternalLink className="size-4 shrink-0"/>
  </button>;
}
