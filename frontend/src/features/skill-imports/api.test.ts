import { describe, expect, it, vi } from 'vitest';
vi.mock('@/api/client', () => ({ apiCall: vi.fn() }));
import { apiCall } from '@/api/client';
import { encodeSkillFiles, submitSkillImports, skillImportStudioPrompt, parseCandidateBundle, validateSkillImport } from './api';

describe('external skill imports', () => {
  it('submits the exact edited bundle to validation', async () => {
    const bundle = { schema_version: 'dramaclaw.skill-bundle.v1', skill: { id: 'ad' }, recipes: [] };
    await validateSkillImport('a/b', 'candidate/1', bundle);
    expect(apiCall).toHaveBeenCalledWith('projects/a%2Fb/freezone/skill-imports/candidate%2F1/validate', { method: 'POST', json: { bundle } });
  });
  it('preserves unicode Markdown bytes for backend conversion', async () => {
    const files = await encodeSkillFiles([new File(['# 分镜'], 'SKILL.md')]);
    expect(files[0].name).toBe('SKILL.md');
    expect(atob(files[0].content_base64)).toBe(unescape(encodeURIComponent('# 分镜')));
  });
  it('rejects unsupported inputs before submitting a batch', async () => {
    await expect(encodeSkillFiles([new File(['x'], 'secret.exe')])).rejects.toThrow();
    await expect(encodeSkillFiles([])).rejects.toThrow();
  });
  it('encodes project identity and sends a batch to the shared backend', async () => {
    vi.mocked(apiCall).mockResolvedValue({ batch_id: 'b', items: [] });
    await submitSkillImports('a/b', [{ name: 'SKILL.md', content_base64: 'eA==' }]);
    expect(apiCall).toHaveBeenCalledWith('projects/a%2Fb/freezone/skill-imports', expect.objectContaining({ method: 'POST' }));
  });
  it('requires a native bundle instead of accepting an arbitrary JSON document', () => {
    expect(() => parseCandidateBundle('{}')).toThrow();
    const bundle = { schema_version: 'dramaclaw.skill-bundle.v1', skill: { id: 'ad' }, recipes: [] };
    expect(parseCandidateBundle(JSON.stringify(bundle))).toEqual(bundle);
  });
  it('hands off a native candidate without asking chat to run the canvas', () => {
    const prompt = skillImportStudioPrompt({ skill: { id: 'ad' }, recipes: [] });
    expect(prompt).toContain('Skill Studio');
    expect(prompt).toContain('"id": "ad"');
    expect(prompt).toContain('不要创建或运行画布节点');
  });
});
