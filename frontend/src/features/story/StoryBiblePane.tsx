// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 故事圣经面板 —— 创作约束层。
 *
 * 这是整个创作流程里唯一**不产出内容、只产出约束**的一步。它的三段对应三种补充时机：
 *   全局锁 / 禁止清单 —— 通篇原则，每一次生成都注入
 *   角色锁           —— /characters 的输入而非输出
 *   结构锁           —— /outline 的输入而非输出
 * 单集级的临时要求走 localOverrides，不在这里编辑（写那一集时就地补更顺手）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Save, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSaveStoryDoc, useStoryDoc } from '@/lib/queries/story';
import { backendErrorToastMessage } from '@/lib/api-errors';
import {
  emptyStoryBible,
  normalizeStoryBible,
  type CastLockEntry,
  type StoryBible,
  type StructureLockEntry,
} from './storySteps';

const INPUT_CLASS =
  'h-9 rounded-[8px] border-white/10 bg-white/[0.025] px-3 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-white/20 focus-visible:ring-2 focus-visible:ring-white/8';
const AREA_CLASS =
  'w-full resize-none rounded-[8px] border border-white/10 bg-white/[0.025] p-2.5 text-sm leading-relaxed shadow-none placeholder:text-muted-foreground/60 focus-visible:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/8';

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

/** 一行一条的字符串列表编辑器。用换行分隔而不是逐条控件——这些条目是短句，成批粘贴最常见。 */
function LineListEditor({
  value,
  placeholder,
  onChange,
}: {
  value: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  return (
    <textarea
      className={AREA_CLASS}
      rows={4}
      spellCheck={false}
      placeholder={placeholder}
      value={value.join('\n')}
      onChange={(event) =>
        onChange(event.target.value.split('\n').map((line) => line.trim()).filter(Boolean))
      }
    />
  );
}

export function StoryBiblePane({ project }: { project: string }) {
  const { t } = useTranslation();
  const doc = useStoryDoc<StoryBible>(project, 'bible');
  const save = useSaveStoryDoc<StoryBible>(project, 'bible');
  const [bible, setBible] = useState<StoryBible>(emptyStoryBible);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    setBible(normalizeStoryBible(doc.data?.content));
  }, [doc.data?.content, dirty]);

  const patch = (next: Partial<StoryBible>) => {
    setBible((current) => ({ ...current, ...next }));
    setDirty(true);
  };

  const onSave = () => {
    save.mutate(
      { content: bible, baseRevision: doc.data?.revision },
      {
        onSuccess: () => {
          setDirty(false);
          toast.success(t('story.saved'));
        },
        onError: (error) => toast.error(backendErrorToastMessage(error, t)),
      },
    );
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <Section title={t('story.bible.locks.title')} hint={t('story.bible.locks.hint')}>
        <Input
          className={INPUT_CLASS}
          placeholder={t('story.bible.locks.positioning')}
          value={bible.locks.positioning}
          onChange={(event) => patch({ locks: { ...bible.locks, positioning: event.target.value } })}
        />
        <Input
          className={INPUT_CLASS}
          placeholder={t('story.bible.locks.era')}
          value={bible.locks.era}
          onChange={(event) => patch({ locks: { ...bible.locks, era: event.target.value } })}
        />
        <Input
          className={INPUT_CLASS}
          placeholder={t('story.bible.locks.dialogueStyle')}
          value={bible.locks.dialogueStyle}
          onChange={(event) => patch({ locks: { ...bible.locks, dialogueStyle: event.target.value } })}
        />
        <LineListEditor
          value={bible.locks.toneRules}
          placeholder={t('story.bible.locks.toneRules')}
          onChange={(toneRules) => patch({ locks: { ...bible.locks, toneRules } })}
        />
      </Section>

      <Section title={t('story.bible.blacklist.title')} hint={t('story.bible.blacklist.hint')}>
        <LineListEditor
          value={bible.blacklist}
          placeholder={t('story.bible.blacklist.placeholder')}
          onChange={(blacklist) => patch({ blacklist })}
        />
      </Section>

      <Section title={t('story.bible.cast.title')} hint={t('story.bible.cast.hint')}>
        <div className="space-y-2">
          {bible.castLock.map((entry, index) => (
            <EntryRow
              key={index}
              onRemove={() =>
                patch({ castLock: bible.castLock.filter((_, i) => i !== index) })
              }
            >
              <Input
                className={INPUT_CLASS}
                placeholder={t('story.bible.cast.name')}
                value={entry.name}
                onChange={(event) => patch({ castLock: replaceAt(bible.castLock, index, { ...entry, name: event.target.value }) })}
              />
              <Input
                className={INPUT_CLASS}
                placeholder={t('story.bible.cast.bind')}
                value={entry.bind}
                onChange={(event) => patch({ castLock: replaceAt(bible.castLock, index, { ...entry, bind: event.target.value }) })}
              />
              <Input
                className={INPUT_CLASS}
                placeholder={t('story.bible.cast.arc')}
                value={entry.arc}
                onChange={(event) => patch({ castLock: replaceAt(bible.castLock, index, { ...entry, arc: event.target.value }) })}
              />
              <Input
                className={INPUT_CLASS}
                placeholder={t('story.bible.cast.mustHave')}
                value={(entry.mustHave ?? []).join('、')}
                onChange={(event) =>
                  patch({
                    castLock: replaceAt(bible.castLock, index, {
                      ...entry,
                      mustHave: event.target.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
                    }),
                  })
                }
              />
            </EntryRow>
          ))}
          <AddButton
            label={t('story.bible.cast.add')}
            onClick={() =>
              patch({ castLock: [...bible.castLock, { name: '', bind: '', arc: '', mustHave: [] } as CastLockEntry] })
            }
          />
        </div>
      </Section>

      <Section title={t('story.bible.structure.title')} hint={t('story.bible.structure.hint')}>
        <div className="space-y-2">
          {bible.structureLock.map((entry, index) => (
            <EntryRow
              key={index}
              onRemove={() => patch({ structureLock: bible.structureLock.filter((_, i) => i !== index) })}
            >
              <Input
                className={INPUT_CLASS}
                placeholder={t('story.bible.structure.stage')}
                value={entry.stage}
                onChange={(event) => patch({ structureLock: replaceAt(bible.structureLock, index, { ...entry, stage: event.target.value }) })}
              />
              <Input
                className={INPUT_CLASS}
                placeholder={t('story.bible.structure.plot')}
                value={entry.plot}
                onChange={(event) => patch({ structureLock: replaceAt(bible.structureLock, index, { ...entry, plot: event.target.value }) })}
              />
              <Input
                className={INPUT_CLASS}
                placeholder={t('story.bible.structure.bind')}
                value={entry.bind}
                onChange={(event) => patch({ structureLock: replaceAt(bible.structureLock, index, { ...entry, bind: event.target.value }) })}
              />
              <Input
                className={INPUT_CLASS}
                placeholder={t('story.bible.structure.tone')}
                value={entry.tone}
                onChange={(event) => patch({ structureLock: replaceAt(bible.structureLock, index, { ...entry, tone: event.target.value }) })}
              />
              <div className="sm:col-span-2">
                <textarea
                  className={AREA_CLASS}
                  rows={2}
                  spellCheck={false}
                  placeholder={t('story.bible.structure.notes')}
                  value={entry.notes ?? ''}
                  onChange={(event) =>
                    patch({ structureLock: replaceAt(bible.structureLock, index, { ...entry, notes: event.target.value }) })
                  }
                />
              </div>
            </EntryRow>
          ))}
          <AddButton
            label={t('story.bible.structure.add')}
            onClick={() =>
              patch({
                structureLock: [
                  ...bible.structureLock,
                  { stage: '', plot: '', bind: '', tone: '', notes: '' } as StructureLockEntry,
                ],
              })
            }
          />
        </div>
      </Section>

      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-white/[0.08] bg-background/85 py-2 backdrop-blur">
        {dirty && <span className="text-xs text-amber-300/80">{t('story.unsaved')}</span>}
        <Button size="sm" onClick={onSave} disabled={save.isPending || !dirty}>
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {t('story.save')}
        </Button>
      </div>
    </div>
  );
}

function replaceAt<T>(list: T[], index: number, next: T): T[] {
  return list.map((item, i) => (i === index ? next : item));
}

function EntryRow({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <div className="relative grid gap-2 rounded-[10px] border border-white/[0.08] bg-white/[0.015] p-2.5 sm:grid-cols-2">
      {children}
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1.5 top-1.5 rounded-full p-1 text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} className="w-full border-dashed">
      <Plus className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}
