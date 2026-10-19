import { describe, expect, it } from 'vitest';

import {
  midjourneyBillingOperation,
  availableMidjourneyReferenceModes,
  cachedMidjourneyUpscaleUrl,
  hasMidjourneyUpscaleCandidates,
  midjourneyImageOperationError,
  midjourneyUpscaleCandidates,
  midjourneyUpscaleResultsFromHistory,
  resolveMidjourneyUpscaleSource,
  resolveMidjourneyReferenceMode,
} from '@/features/canvas/domain/midjourneyImageOperations';

describe('Midjourney image operations', () => {
  it('uses the operation dimension only for the Midjourney adapter', () => {
    expect(midjourneyBillingOperation('relayclaw_midjourney', undefined)).toBe('imagine');
    expect(midjourneyBillingOperation('relayclaw_midjourney', 'edit')).toBe('edit');
    expect(midjourneyBillingOperation('relayclaw_midjourney', 'blend')).toBe('blend');
    expect(midjourneyBillingOperation(undefined, 'blend')).toBeNull();
  });

  it('only exposes operations declared by the media catalog', () => {
    expect(availableMidjourneyReferenceModes(['imagine', 'blend'])).toEqual([
      'image_prompt',
      'blend',
    ]);
    expect(resolveMidjourneyReferenceMode('edit', ['imagine'])).toBe('image_prompt');
  });

  it('preserves configured style and omni reference modes', () => {
    expect(
      availableMidjourneyReferenceModes(
        ['imagine', 'edit'],
        ['image_prompt', 'style_reference', 'omni_reference', 'edit'],
      ),
    ).toEqual(['image_prompt', 'style_reference', 'omni_reference', 'edit']);
  });

  it('hides reference operations until images are connected', () => {
    expect(
      availableMidjourneyReferenceModes(
        ['imagine', 'edit', 'blend'],
        ['image_prompt', 'style_reference', 'omni_reference', 'edit', 'blend'],
        0,
      ),
    ).toEqual([]);
    expect(
      resolveMidjourneyReferenceMode(
        'edit',
        ['imagine', 'edit', 'blend'],
        ['image_prompt', 'style_reference', 'omni_reference', 'edit', 'blend'],
        0,
      ),
    ).toBe('image_prompt');
  });

  it('only offers operations valid for the current reference count', () => {
    const configured = [
      'image_prompt',
      'style_reference',
      'omni_reference',
      'edit',
      'blend',
    ];
    expect(
      availableMidjourneyReferenceModes(['imagine', 'edit', 'blend'], configured, 1),
    ).toEqual(['image_prompt', 'style_reference', 'omni_reference', 'edit']);
    expect(
      availableMidjourneyReferenceModes(['imagine', 'edit', 'blend'], configured, 2),
    ).toEqual(['image_prompt', 'style_reference', 'edit', 'blend']);
    expect(
      resolveMidjourneyReferenceMode(
        'blend',
        ['imagine', 'edit', 'blend'],
        configured,
        1,
      ),
    ).toBe('image_prompt');
  });

  it('allows prompt-less blend only when at least two images are connected', () => {
    expect(midjourneyImageOperationError('blend', 1, false)).toBe(
      'blend_images_required',
    );
    expect(midjourneyImageOperationError('blend', 2, false)).toBeNull();
  });

  it('requires an image and prompt for edit', () => {
    expect(midjourneyImageOperationError('edit', 0, true)).toBe(
      'edit_image_required',
    );
    expect(midjourneyImageOperationError('edit', 1, false)).toBe('prompt_required');
    expect(midjourneyImageOperationError('edit', 1, true)).toBeNull();
  });

  it('extracts and orders U1-U4 upscale candidates from task buttons', () => {
    expect(
      midjourneyUpscaleCandidates(
        [
          { custom_id: 'MJ::JOB::variation::1::task', label: 'V1' },
          { custom_id: 'MJ::JOB::upsample::4::task', label: 'U4' },
          { custom_id: 'MJ::JOB::upsample::2::task', label: 'U2' },
          { custom_id: 'MJ::JOB::upsample::1::task', label: 'U1' },
          { custom_id: 'MJ::JOB::upsample::3::task', label: 'U3' },
        ],
        ['imagine', 'upscale'],
      ),
    ).toEqual([
      { index: 1, label: 'U1', customId: 'MJ::JOB::upsample::1::task' },
      { index: 2, label: 'U2', customId: 'MJ::JOB::upsample::2::task' },
      { index: 3, label: 'U3', customId: 'MJ::JOB::upsample::3::task' },
      { index: 4, label: 'U4', customId: 'MJ::JOB::upsample::4::task' },
    ]);
  });

  it('hides upscale candidates when the catalog does not declare upscale', () => {
    expect(
      midjourneyUpscaleCandidates(
        [{ custom_id: 'MJ::JOB::upsample::1::task', label: 'U1' }],
        ['imagine'],
      ),
    ).toEqual([]);
  });

  it('recognizes U labels when a provider uses a different upscale custom id', () => {
    expect(
      midjourneyUpscaleCandidates(
        [{ custom_id: 'provider-action-upscale-first', label: 'u3' }],
        ['upscale'],
      ),
    ).toEqual([
      { index: 3, label: 'U3', customId: 'provider-action-upscale-first' },
    ]);
  });

  it('retains the original grid task after an upscale task becomes current', () => {
    const source = {
      task_id: 'imagine-task',
      operation: 'imagine',
      buttons: [{ custom_id: 'up-1', label: 'U1' }],
    };
    const upscaled = {
      task_id: 'upscale-task',
      operation: 'upscale',
      buttons: [],
    };

    expect(hasMidjourneyUpscaleCandidates(source)).toBe(true);
    expect(resolveMidjourneyUpscaleSource(source, upscaled)).toBe(source);
    expect(resolveMidjourneyUpscaleSource(undefined, source)).toBe(source);
    expect(resolveMidjourneyUpscaleSource(undefined, upscaled)).toBeNull();
  });

  it('recovers completed U-button results from matching history records', () => {
    const results = midjourneyUpscaleResultsFromHistory(
      [
        {
          status: 'completed',
          result: { output_url: 'u1-new.png' },
          midjourney_action: {
            task_id: 'imagine-task',
            custom_id: 'up-1',
            operation: 'upscale',
          },
        },
        {
          status: 'completed',
          result: { output_url: 'other-source.png' },
          midjourney_action: {
            task_id: 'other-task',
            custom_id: 'up-2',
            operation: 'upscale',
          },
        },
      ],
      'imagine-task',
    );

    expect(results).toEqual({ 'up-1': 'u1-new.png' });
    expect(cachedMidjourneyUpscaleUrl(results, 'up-1')).toBe('u1-new.png');
    expect(cachedMidjourneyUpscaleUrl(results, 'up-2')).toBeNull();
  });
});
