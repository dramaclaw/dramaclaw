import {describe,expect,it} from 'vitest';
import {recipeDraftFromPayload,recipePayloadFromDraft} from '@/components/settings/freezone-skill-recipe-settings';

describe('HTML recipe settings',()=>{
 it('loads saved HTML recipes as the webpage deliverable choice',()=>{
  const draft=recipeDraftFromPayload({id:'page',output_kind:'text',output_format:'html'});
  expect(draft.outputKind).toBe('html');
 });
 it('preserves imported HTML metadata through editing, saving and reimporting',()=>{
  const original={id:'page',name:'Page',output_kind:'text',output_format:'html',system_prompt:'Build page',force_enhancement:true};
  const draft=recipeDraftFromPayload(original);
  draft.name='Updated page';
  const saved=JSON.parse(JSON.stringify(recipePayloadFromDraft(draft,original)));
  expect(saved).toMatchObject({name:'Updated page',output_kind:'text',output_format:'html',force_enhancement:true});
  expect(recipeDraftFromPayload(saved).outputKind).toBe('html');
 });
 it.each(['text','image','video','audio'] as const)('clears HTML format when switching the deliverable to %s',outputKind=>{
  const original={id:'page',output_kind:'text',output_format:'html'};
  const draft={...recipeDraftFromPayload(original),outputKind};
  const saved=JSON.parse(JSON.stringify(recipePayloadFromDraft(draft,original)));
  expect(saved.output_kind).toBe(outputKind);
  expect(saved).not.toHaveProperty('output_format');
 });

});
