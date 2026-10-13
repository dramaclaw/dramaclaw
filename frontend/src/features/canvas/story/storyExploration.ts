/** Player discoveries are cumulative; the active route and Ink checkpoints are reversible. */
export interface ExplorationNode {
  id: string;
  label: string;
  successors: string[];
  choices?: { target: string; text: string }[];
  isEnding: boolean;
}

export interface StoryPathStep {
  visit: number;
  nodeId: string;
  choiceText?: string;
}

export interface StoryCheckpoint {
  inkState: string;
  route: StoryPathStep[];
  completed: boolean;
  /** Flat snapshots of prior decisions on this arrival's route; omitted in legacy saves. */
  decisions?: Omit<StoryCheckpoint, 'decisions'>[];
}

export interface StoryExploration {
  completedNodeIds: string[];
  reachedEndingIds: string[];
  totalRuns: number;
  nextVisit: number;
  route: StoryPathStep[];
  /** Latest arrival per node: revisits replace the checkpoint without growing the save forever. */
  checkpoints: Record<string, StoryCheckpoint>;
  /** Ordered decisions on the active route, including separate visits to a looping choice point. */
  decisions: StoryCheckpoint[];
}

export function emptyExploration(): StoryExploration {
  return { completedNodeIds: [], reachedEndingIds: [], totalRuns: 0, nextVisit: 1, route: [], checkpoints: {}, decisions: [] };
}

function isRoute(value: unknown): value is StoryPathStep[] {
  return Array.isArray(value) && value.every((step) => step && typeof step.nodeId === 'string'
    && Number.isSafeInteger(step.visit) && step.visit > 0
    && (step.choiceText === undefined || typeof step.choiceText === 'string'));
}

/** Reject malformed or foreign checkpoint metadata while leaving a compatible legacy Ink save usable. */
export function parseExploration(value: unknown, nodeIds: Set<string>): StoryExploration {
  if (!value || typeof value !== 'object') return emptyExploration();
  const data = value as Partial<StoryExploration>;
  if (!isRoute(data.route) || !Number.isSafeInteger(data.nextVisit) || data.nextVisit! < 1
    || !Number.isSafeInteger(data.totalRuns) || data.totalRuns! < 0
    || !Array.isArray(data.completedNodeIds) || !Array.isArray(data.reachedEndingIds)
    || !data.checkpoints || typeof data.checkpoints !== 'object') return emptyExploration();
  const known = (id: unknown): id is string => typeof id === 'string' && nodeIds.has(id);
  const checkpoints: Record<string, StoryCheckpoint> = {};
  const validCheckpoint = (checkpoint: StoryCheckpoint | undefined): checkpoint is StoryCheckpoint => !!checkpoint
    && typeof checkpoint.inkState === 'string' && typeof checkpoint.completed === 'boolean'
    && isRoute(checkpoint.route) && checkpoint.route.length > 0 && checkpoint.route.every((step) => known(step.nodeId));
  const sanitize = (checkpoint: StoryCheckpoint): StoryCheckpoint => ({
    inkState: checkpoint.inkState, route: checkpoint.route, completed: checkpoint.completed,
    ...(Array.isArray(checkpoint.decisions) ? { decisions: checkpoint.decisions
      .filter((decision) => validCheckpoint(decision) && isPriorDecision(decision, checkpoint.route))
      .map(({ inkState, route, completed }) => ({ inkState, route, completed })) } : {}),
  });
  for (const [id, checkpoint] of Object.entries(data.checkpoints)) {
    if (known(id) && validCheckpoint(checkpoint)
      && checkpoint.route[checkpoint.route.length - 1]?.nodeId === id) checkpoints[id] = sanitize(checkpoint);
  }
  const route = data.route.every((step) => known(step.nodeId)) ? data.route : [];
  return {
    completedNodeIds: [...new Set(data.completedNodeIds.filter(known))],
    reachedEndingIds: [...new Set(data.reachedEndingIds.filter(known))],
    totalRuns: data.totalRuns!, nextVisit: data.nextVisit!,
    route, checkpoints,
    decisions: Array.isArray(data.decisions) ? data.decisions.filter((checkpoint) => validCheckpoint(checkpoint)
      && checkpoint.route.length < route.length
      && checkpoint.route.every((step, index) => route[index]?.visit === step.visit && route[index]?.nodeId === step.nodeId)).map(sanitize) : [],
  };
}

function isPriorDecision(checkpoint: StoryCheckpoint, route: StoryPathStep[]): boolean {
  return checkpoint.completed && checkpoint.route.length > 0 && checkpoint.route.length < route.length
    && checkpoint.route.every((step, index) => route[index]?.visit === step.visit && route[index]?.nodeId === step.nodeId);
}

/** Restore the target route, including old branches and earlier visits to looping nodes. */
export function decisionsForCheckpoint(checkpoint: StoryCheckpoint, exploration: StoryExploration): StoryCheckpoint[] {
  const candidates = checkpoint.decisions ?? [...Object.values(exploration.checkpoints), ...exploration.decisions];
  const byVisit = new Map<number, StoryCheckpoint>();
  for (const decision of candidates) {
    if (isPriorDecision(decision, checkpoint.route) && checkpoint.route[decision.route.length]?.choiceText) {
      byVisit.set(decision.route[decision.route.length - 1].visit, decision);
    }
  }
  return [...byVisit.values()].sort((a, b) => a.route.length - b.route.length);
}

/** Older exploration saves can recover a decision only when its exact route visit is still available. */
export function previousChoiceCheckpoint(exploration: StoryExploration): StoryCheckpoint | null {
  if (exploration.decisions.length) return exploration.decisions[exploration.decisions.length - 1];
  for (let index = exploration.route.length - 2; index >= 0; index--) {
    const step = exploration.route[index];
    const checkpoint = exploration.checkpoints[step.nodeId];
    if (exploration.route[index + 1].choiceText && checkpoint?.completed
      && checkpoint.route[checkpoint.route.length - 1]?.visit === step.visit) return checkpoint;
  }
  return null;
}

export function explorationSummary(nodes: ExplorationNode[], exploration: StoryExploration) {
  const completed = new Set(exploration.completedNodeIds);
  const endings = new Set(exploration.reachedEndingIds);
  const explored = nodes.filter((node) => completed.has(node.id)).length;
  return {
    explored, total: nodes.length,
    percent: nodes.length ? Math.floor(explored / nodes.length * 100) : 0,
    reachedEndings: nodes.filter((node) => node.isEnding && endings.has(node.id)).length,
    totalEndings: nodes.filter((node) => node.isEnding).length,
  };
}
