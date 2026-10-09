import { describe, expect, it } from 'vitest';

import { hasWorkflowCatalogMarker } from './workflowNodeMarkers';

describe('workflowNodeMarkers', () => {
  it('detects nodes created from workflow catalog metadata', () => {
    expect(hasWorkflowCatalogMarker({ data: {} })).toBe(false);
    expect(hasWorkflowCatalogMarker({ data: { workflowCatalog: { recipeId: 'shot-video' } } })).toBe(true);
    expect(hasWorkflowCatalogMarker({ data: { workflowCatalogRole: 'user_input' } })).toBe(true);
  });
});
