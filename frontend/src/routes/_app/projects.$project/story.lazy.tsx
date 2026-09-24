// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute } from '@tanstack/react-router';

import { StoryWorkspace } from '@/features/story/StoryWorkspace';

export const Route = createLazyFileRoute('/_app/projects/$project/story')({
  component: StoryRoute,
});

function StoryRoute() {
  const { project } = Route.useParams();
  return <StoryWorkspace project={project} />;
}
