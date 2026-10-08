// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute } from '@tanstack/react-router';

import { DirectorStudio } from '@/features/director/DirectorStudio';

export const Route = createLazyFileRoute('/_app/projects/$project/director')({
  component: DirectorProjectRoute,
});

function DirectorProjectRoute() {
  const { project } = Route.useParams();
  return <div className="-m-6 h-[calc(100%+3rem)]"><DirectorStudio project={project} /></div>;
}
