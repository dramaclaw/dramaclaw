import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillImportDialog } from './SkillImportDialog';
import * as api from './api';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }) }));
vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof api>(), listSkillImports: vi.fn(), installSkillImport: vi.fn(), retrySkillImport: vi.fn(), validateSkillImport: vi.fn() }));
const bundle = { schema_version: 'dramaclaw.skill-bundle.v1', skill: { id: 'ad' }, recipes: [] };
const quality_report = { version: 3 as const, bundle_sha256: 'bundle-hash', capability_sha256: 'capability-hash', structure: { status: 'passed' as const, issues: [] }, coverage: { status: 'passed' as const, issues: [] }, planning: { status: 'passed' as const, issues: [] }, blockers: [], adaptations: [], validated: true };
const item: api.SkillImportItem = { id: 'i', batch_id: 'b', name: 'ad.md', status: 'ready', stage: 'done', warnings: [], bundle, quality_report, created_at: '' };
function mount(project = 'project', taskId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><SkillImportDialog open onOpenChange={() => {}} project={project} taskId={taskId} /></QueryClientProvider>), client };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.listSkillImports).mockResolvedValue({ items: [item] }); });
describe('SkillImportDialog', () => {
  it('expands inside the selected list row and collapses without losing edits', async () => {
    vi.mocked(api.listSkillImports).mockResolvedValue({ items: [item, { ...item, id: 'second', name: 'second.md' }] });
    mount();
    const buttons = await screen.findAllByRole('button', { name: 'Review' });
    fireEvent.click(buttons[0]);
    const editor = screen.getByRole('textbox', { name: 'Native Skill Bundle' });
    expect(editor.closest('li')).toBe(buttons[0].closest('li'));
    fireEvent.change(editor, { target: { value: 'edited draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse result' }));
    expect(screen.queryByRole('textbox', { name: 'Native Skill Bundle' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Review' })[0]);
    expect(screen.getByRole('textbox', { name: 'Native Skill Bundle' })).toHaveValue('edited draft');
  });

  it('requires v3 revalidation for a v2 report even if old gates passed', async () => {
    vi.mocked(api.listSkillImports).mockResolvedValue({ items: [{ ...item, quality_report: { ...quality_report, version: 2 } }] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
    expect(screen.getByText('Revalidation required. Validate this draft before installing.')).toBeInTheDocument();
  });
  it('does not use historical Graph results as an installation gate', async () => {
    vi.mocked(api.listSkillImports).mockResolvedValue({ items: [{ ...item, quality_report: { ...quality_report, planning: { status: 'failed', issues: ['Old graph error'] } } }] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled();
    expect(screen.queryByText('Planning check')).not.toBeInTheDocument();
    expect(screen.queryByText('Old graph error')).not.toBeInTheDocument();
  });
  it('refreshes validation results without overwriting an edited draft during polling', async () => {
    const { client } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const edited = JSON.stringify({ ...bundle, skill: { id: 'unsaved' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Native Skill Bundle' }), { target: { value: edited } });
    act(() => client.setQueryData(['skill-imports', 'project'], { items: [{ ...item, quality_report: { ...quality_report, validated: false, blockers: ['New planning issue'] } }] }));
    await screen.findByText('New planning issue');
    expect(screen.getByRole('textbox', { name: 'Native Skill Bundle' })).toHaveValue(edited);
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
  });
  it('hides running revalidation and refreshes report when it completes', async () => {
    const { client } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    act(() => client.setQueryData(['skill-imports', 'project'], { items: [{ ...item, status: 'running', stage: 'planning' }] }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Native Skill Bundle' })).not.toBeInTheDocument());
    act(() => client.setQueryData(['skill-imports', 'project'], { items: [{ ...item, quality_report: { ...quality_report, validated: false, blockers: ['Output contract missing'] } }] }));
    await screen.findByText('Output contract missing');
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
  });

  it('requires revalidation of legacy drafts before installation', async () => {
    vi.mocked(api.listSkillImports).mockResolvedValue({ items: [{ ...item, quality_report: undefined }] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByText('Revalidation required. Validate this draft before installing.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
  });
  it('shows checks and adaptations and cannot acknowledge blockers away', async () => {
    vi.mocked(api.listSkillImports).mockResolvedValue({ items: [{ ...item, status: 'needs_review', quality_report: { ...quality_report, validated: false, planning: { status: 'failed', issues: ['Missing output plan'] }, blockers: ['Camera tool unavailable'], adaptations: [{ requirement_id: 'shots', owner: 'recipe', target: 'storyboard', status: 'composed', reason: 'Built with frame generation and sequencing' }] } }] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    for (const label of ['Structure', 'Method coverage', 'Camera tool unavailable']) expect(screen.getAllByText(label, { exact: false }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
  });
  it('submits edited draft for explicit validation and hides panel while queued', async () => {
    const edited = { ...bundle, skill: { id: 'changed' } };
    vi.mocked(api.validateSkillImport).mockResolvedValue({ ...item, bundle: edited, status: 'queued' });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Native Skill Bundle' }), { target: { value: JSON.stringify(edited) } });
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Validate edited draft' }));
    await waitFor(() => expect(api.validateSkillImport).toHaveBeenCalledWith('project', 'i', edited));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Native Skill Bundle' })).not.toBeInTheDocument());
    expect(api.installSkillImport).not.toHaveBeenCalled();
  });
  it('does not invalidate a draft for formatting or object-key order', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Native Skill Bundle' }), { target: { value: JSON.stringify({ recipes: [], skill: { id: 'ad' }, schema_version: bundle.schema_version }) } });
    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled();
  });
  it('does not expose intermediate candidates while conversion is running', async () => {
    vi.mocked(api.listSkillImports).mockResolvedValue({ items: [{ ...item, status: 'running' }] });
    mount();
    await screen.findByText('ad.md', { exact: false });
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
  });
  it.each([['Script not supported'], []])('requires review acknowledgement for incomplete conversions (%j)', async (...warnings) => {
    vi.mocked(api.listSkillImports).mockResolvedValue({ items: [{ ...item, status: 'needs_review', warnings: warnings as string[] }] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled();
  });
  it('opens the exact candidate selected in the task center', async () => {
    vi.mocked(api.listSkillImports).mockResolvedValue({ items: [
      { ...item, name: 'SKILL.md', task_id: 'task-a' },
      { ...item, id: 'second', name: 'SKILL.md', task_id: 'task-b', bundle: { ...bundle, skill: { id: 'second-skill' } } },
    ] });
    mount('project', 'task-b');
    expect((await screen.findByRole('textbox', { name: 'Native Skill Bundle' }) as HTMLTextAreaElement).value).toContain('second-skill');
  });
  it('requires a project to submit background work', () => {
    mount('');
    expect(screen.getByText('Open a project to convert external skills.')).toBeInTheDocument();
    expect(api.listSkillImports).not.toHaveBeenCalled();
  });
  it('opens a candidate for review before installing and validates edited JSON', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const editor = screen.getByRole('textbox', { name: 'Native Skill Bundle' });
    fireEvent.change(editor, { target: { value: '{}' } });
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Validate edited draft' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(api.installSkillImport).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: JSON.stringify(bundle) } });
    vi.mocked(api.installSkillImport).mockResolvedValue({ ...item, status: 'installed' });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(api.installSkillImport).toHaveBeenCalledWith('project', 'i', bundle, false));
  });
  it('retries failed imports without rerunning completed siblings', async () => {
    vi.mocked(api.listSkillImports).mockResolvedValue({ items: [item, { ...item, id: 'bad', name: 'bad.md', status: 'failed', error: 'Model unavailable' }] });
    mount();
    await screen.findByText('bad.md', { exact: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }));
    await waitFor(() => expect(api.retrySkillImport).toHaveBeenCalledWith('project', 'bad'));
    expect(api.retrySkillImport).toHaveBeenCalledTimes(1);
  });
});
