// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export const PROJECT_SECTION_ROUTES = {
  freezone: "/projects/$project/freezone",
  ingest: "/projects/$project/ingest",
  characters: "/projects/$project/characters",
  episodes: "/projects/$project/episodes",
  styles: "/projects/$project/styles",
  tasks: "/projects/$project/tasks",
  assistant: "/projects/$project/assistant",
} as const;

export type ProjectSection = keyof typeof PROJECT_SECTION_ROUTES;

export function projectSectionFromPath(pathname: string): ProjectSection | null {
  const segment = pathname.match(/^\/projects\/[^/]+\/([^/]+)/)?.[1];
  return segment && segment in PROJECT_SECTION_ROUTES
    ? (segment as ProjectSection)
    : null;
}

export function projectModeFromPath(pathname: string): "xiahua" | "xiaji" {
  return projectSectionFromPath(pathname) === "freezone" ? "xiahua" : "xiaji";
}
