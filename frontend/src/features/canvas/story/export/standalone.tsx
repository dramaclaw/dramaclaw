import { createRoot } from 'react-dom/client';
import { StoryExperience } from '../StoryExperience';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';
import type { CompiledStory } from '../storyTypes';
import type { PlayerLabels } from './buildPlayerHtml';
import './standalone.css';

type StoryData = {
  storyJson: string;
  title: string;
  explorationNodes: CompiledStory['explorationNodes'];
  clips: CompiledStory['clipByNodeId'];
  choiceLoops: CompiledStory['choiceLoopClipByNodeId'];
  choiceTime: CompiledStory['choiceTimeByNodeId'];
  defaultChoice: CompiledStory['defaultChoiceIndexByNodeId'];
  endings: CompiledStory['endingByNodeId'];
  placeholders: CompiledStory['placeholderByNodeId'];
  choiceFeedback: CompiledStory['choiceFeedbackById'];
  choiceStateChanges: CompiledStory['choiceStateChangesById'];
  choiceInteraction: CompiledStory['choiceInteractionById'];
  labels: PlayerLabels;
};
const data = (window as unknown as { __STORY__: StoryData }).__STORY__;
const labelKeys: Record<string, keyof PlayerLabels> = {
  'canvas.story.tree.ending': 'treeEnding',
  'canvas.story.error': 'loadError',
  'canvas.story.defaultChoice': 'defaultChoice',
  'canvas.story.endingFallback': 'endingFallback',
  'canvas.story.restart': 'restart',
  'canvas.story.placeholderBadge': 'placeholderBadge',
  'canvas.story.placeholderHint': 'placeholderHint',
  'canvas.story.automaticPlaceholderHint': 'automaticPlaceholderHint',
  'canvas.story.automaticPlaceholderNext': 'automaticPlaceholderNext',
  'canvas.story.playMode.playCurrent': 'play',
  'canvas.story.playMode.pauseCurrent': 'pause',
  'canvas.story.playMode.seek': 'seek',
  'canvas.story.mediaError': 'mediaError',
  'canvas.story.retryMedia': 'retry',
  'canvas.story.choiceCountdown': 'countdown',
  'canvas.story.flagOn': 'flagOn',
  'canvas.story.flagOff': 'flagOff',
  'canvas.story.replayExperience': 'replayExperience',
  'canvas.story.ctaUnconfigured': 'ctaUnconfigured',
};
function t(key: string, values?: Record<string, unknown>): string {
  if (key === 'canvas.story.endingBadge') return `${data.labels.endingBadge} · ${values?.label ?? ''}`;
  const explorationPrefix = 'canvas.story.exploration.';
  const translated = key.startsWith(explorationPrefix)
    ? data.labels.exploration?.[key.slice(explorationPrefix.length)]
    : data.labels[labelKeys[key]];
  const text = typeof translated === 'string' ? translated : String(values?.defaultValue ?? key);
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    values?.[name] === undefined ? match : String(values[name]));
}
useStoryRuntimeStore.getState().enterPlay({
  ink: '',
  explorationNodes: data.explorationNodes,
  clipByNodeId: data.clips,
  choiceLoopClipByNodeId: data.choiceLoops,
  choiceTimeByNodeId: data.choiceTime,
  defaultChoiceIndexByNodeId: data.defaultChoice,
  endingByNodeId: data.endings,
  placeholderByNodeId: data.placeholders,
  choiceFeedbackById: data.choiceFeedback,
  choiceStateChangesById: data.choiceStateChanges,
  choiceInteractionById: data.choiceInteraction,
  knotByNodeId: {}, variables: [], warnings: [],
}, { storyJson: data.storyJson });
createRoot(document.getElementById('app')!).render(<StoryExperience t={t} title={data.title} />);
