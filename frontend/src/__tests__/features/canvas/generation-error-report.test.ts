import { describe, expect, it } from 'vitest';

import {
  dedupeGenerationErrors,
  extractRequestId,
  generationErrorFingerprint,
} from '@/features/canvas/application/generationErrorReport';

describe('generation error normalization', () => {
  it('extracts request ids from gateway error variants', () => {
    expect(extractRequestId('HTTP 503; request_id=req_123; retry later')).toBe('req_123');
    expect(extractRequestId('InvalidParameter (request id: 021785405859abc)')).toBe(
      '021785405859abc',
    );
  });

  it('uses the request id as the stable error fingerprint', () => {
    expect(generationErrorFingerprint('first wrapper request id: SAME-123')).toBe(
      'request:same-123',
    );
    expect(generationErrorFingerprint('another wrapper request_id=SAME-123')).toBe(
      'request:same-123',
    );
  });

  it('deduplicates errors reported through multiple execution channels', () => {
    expect(
      dedupeGenerationErrors([
        'node failed: HTTP 502 (request id: req-42)',
        'task failed: upstream reset, request_id=req-42',
        'HTTP 401: Invalid token',
        ' HTTP 401:   Invalid token ',
      ]),
    ).toEqual([
      'node failed: HTTP 502 (request id: req-42)',
      'HTTP 401: Invalid token',
    ]);
  });
});
