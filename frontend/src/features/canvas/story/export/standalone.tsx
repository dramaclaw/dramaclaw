import { createRoot } from 'react-dom/client';
import { StoryPlayer } from '../StoryPlayer';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';
import type { CompiledStory } from '../storyTypes';
import type { PlayerLabels } from './buildPlayerHtml';
import './standalone.css';

type StoryData = {
  storyJson: string;
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
  'canvas.story.error': 'loadError',
  'canvas.story.defaultChoice': 'defaultChoice',
  'canvas.story.endingFallback': 'endingFallback',
  'canvas.story.restart': 'restart',
  'canvas.story.placeholderBadge': 'placeholderBadge',
  'canvas.story.placeholderHint': 'placeholderHint',
  'canvas.story.playMode.playCurrent': 'play',
  'canvas.story.mediaError': 'mediaError',
  'canvas.story.retryMedia': 'retry',
  'canvas.story.choiceCountdown': 'countdown',
  'canvas.story.flagOn': 'flagOn',
  'canvas.story.flagOff': 'flagOff',
};
function t(key: string, values?: Record<string, unknown>): string {
  if (key === 'canvas.story.endingBadge') return `${data.labels.endingBadge} · ${values?.label ?? ''}`;
  return data.labels[labelKeys[key]] ?? key;
}
useStoryRuntimeStore.getState().enterPlay({
  ink: '',
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
createRoot(document.getElementById('app')!).render(<StoryPlayer t={t} />);
