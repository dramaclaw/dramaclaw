// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, Plus, UsersRound, Smile, Theater, KeyRound, Image, Film, SlidersHorizontal, DirectorReferenceIcon } from './components/DirectorReferenceIcon';
import assets from './assets/reference-assets.json';
import templates from './assets/preset-templates.json';

import type { DirectorPreset, DirectorModelOption } from '@/api/director';

export interface DirectorWorkDraft {
  title: string;
  brief: string;
  sourceText: string;
  sourceFileName: string;
  preset: DirectorPreset;
}

// i18n-exempt-start — Canonical protocol values are not UI copy.
export const GENRES = [
  '玄幻修仙逆袭', '现实职场成长', '末世生存基建', '非遗国潮视觉',
  '古代女频甜宠', '规则怪谈悬疑', '重生复仇爽剧', '仙门团宠日常',
] as const;
export const SUBJECTS = ['玄幻修仙', '都市现实', '古装言情', '悬疑推理', '惊悚怪谈', '犯罪谍战', '家庭伦理', '末世科幻', '历史传奇', '喜剧', '主旋律', '体育竞技', '职场行业', '文旅非遗', '其他'] as const;
export const PRESET_SUBJECTS = [0, 1, 7, 13, 2, 4, 1, 0] as const;
// i18n-exempt-end

export const PRESET_DEFAULTS = templates.templates;

const ADAPT_DIRECTIONS = ['condense', 'expand', 'conflict', 'hook'] as const;
const STRUCTURES = ['three_act', 'five_act', 'hero', 'parallel', 'cross', 'nonlinear', 'loop', 'unit'] as const;

// i18n-exempt-start — Observed semantic option values; labels use translation keys.
const CHOICES: Record<string, string[]> = {
  "audience": [
    "男频",
    "女频",
    "泛人群",
    "出海",
    "银发",
    "其他"
  ],
  "characters": [
    "小人物",
    "打工人",
    "女强",
    "不完美成长型",
    "专业型",
    "天才",
    "双强",
    "腹黑",
    "黑莲花",
    "忠犬",
    "病娇",
    "福宝",
    "大小姐",
    "少爷",
    "王爷",
    "王妃",
    "皇帝",
    "将军",
    "修士",
    "龙王",
    "医者",
    "律师",
    "警探",
    "教师",
    "模特",
    "其他"
  ],
  "era": [
    "古代",
    "现代",
    "架空",
    "末世",
    "民国",
    "年代（80–90s）",
    "近未来",
    "平行世界",
    "多时空穿越",
    "其他"
  ],
  "highlights": [
    "器物金手指",
    "收集升级",
    "基建生存",
    "专业碾压",
    "马甲大佬",
    "先婚后爱",
    "重生复仇",
    "团宠被爱",
    "IP二创",
    "双向救赎",
    "穿越异世",
    "扮猪吃虎",
    "亲历行业细节",
    "真实成长",
    "规则禁忌",
    "单元解谜",
    "文化元素新用",
    "风格混搭",
    "视觉奇观",
    "隐藏身份",
    "真假千金",
    "契约婚姻",
    "萌宝助攻",
    "赘婿逆袭",
    "系统傍身",
    "欢喜冤家",
    "普通人的处境",
    "群像时代切片",
    "姐弟恋",
    "穿书",
    "时间循环"
  ],
  "visual_style": [
    "冷峻宫廷权谋",
    "国产冷调悬疑",
    "都市写实",
    "柔光古装言情",
    "日系青春胶片",
    "写实江湖武侠",
    "高调棚拍广告",
    "经典好莱坞",
    "赛博科幻",
    "冷感文艺",
    "暗黑恐怖",
    "3D 奇幻动画",
    "工业质感",
    "怀旧港片",
    "唯美国风 3D",
    "三渲二动漫",
    "超写实 3D",
    "暗调奇幻 CG",
    "东方玄幻 3D",
    "经典国产美术",
    "国风壁画"
  ]
};
// i18n-exempt-end
const CHOICE_LIMITS: Record<string, number> = { audience: 2, characters: 5, era: 2, highlights: 3, visual_style: 1 };

interface Props {
  draft: DirectorWorkDraft;
  onClose: () => void;
  onConfirm: (value: DirectorWorkDraft) => void;
  readOnly?: boolean;
  fixedModel?: string;
  modelOptions?: DirectorModelOption[];
  sourceLocked?: boolean;
}

export function DirectorPresetDialog({ draft: initial, onClose, onConfirm, readOnly = false, fixedModel, modelOptions, sourceLocked = false }: Props) {
  const { t } = useTranslation();
  // A modal's edits are provisional. Closing must not mutate the composer or
  // the stored spec; only its explicit confirmation transfers this snapshot.
  const [draft, onChange] = useState<DirectorWorkDraft>(() => ({ ...initial, preset: {
    narrative_tone: '', ending_type: 'closed', output_language: 'zh-CN', market: 'unspecified',
    fidelity: 'strict', locked_facts: '', allowed_additions: '', ...initial.preset,
  } }));
  const firstRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [showPresets, setShowPresets] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  // Preserve incomplete input locally; clearing a field must not choose a duration.
  const [durationInput, setDurationInput] = useState(String(initial.preset.duration_seconds));
  const durationSeconds = Number(durationInput);
  const durationValid = durationInput.trim() !== '' && Number.isSafeInteger(durationSeconds) && durationSeconds > 0;
  const [fusionPicking, setFusionPicking] = useState(Boolean(initial.preset.fusion_genre));
  const [activeTemplate, setActiveTemplate] = useState<number | null>(null);
  const [field, setField] = useState<string | null>(null);
  const [fieldAnchor, setFieldAnchor] = useState({ left: 16, bottom: 174 });
  const [customField, setCustomField] = useState(false);
  const [customGenre, setCustomGenre] = useState<'primary_genre' | 'fusion_genre' | null>(null);
  const [customGenreText, setCustomGenreText] = useState('');
  const wheelTime = useRef(0);
  const fieldTrigger = useRef<HTMLButtonElement | null>(null);
  const preset = draft.preset;
  const setPreset = (patch: Partial<DirectorPreset>) =>
    onChange({ ...draft, preset: { ...preset, ...patch } });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    firstRef.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    if (field) dialogRef.current?.querySelector<HTMLElement>('.dc-field-popover button, .dc-field-popover input')?.focus();
    else fieldTrigger.current?.focus();
  }, [field]);
  useEffect(() => {
    const resize = () => setField(null);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (customGenre) setCustomGenre(null); else if (field) setField(null); else if (advanced) setAdvanced(false); else onClose();
      }
      if (event.key === 'Tab') {
        const scope = dialogRef.current?.querySelector('.dc-custom-genre') ?? dialogRef.current?.querySelector('.dc-field-popover') ?? dialogRef.current;
        const items = Array.from(scope?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])
          .filter((item) => item.getClientRects().length > 0);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, field, advanced, customGenre]);

  const cards = [
    { key: 'audience', label: 'audience', icon: UsersRound, value: preset.audience },
    { key: 'characters', label: 'characters', icon: Smile, value: preset.characters },
    { key: 'era', label: 'era', icon: Theater, value: preset.era },
    { key: 'highlights', label: 'highlights', icon: KeyRound, value: preset.highlights },
    { key: 'visual_style', label: 'visualStyle', icon: Image, value: preset.visual_style },
    { key: 'structure', label: 'structure.label', icon: Film, value: `${preset.episode_count} ${t('director.episodeUnit')}` },
  ];
  const currentCard = cards.find((card) => card.key === field);
  const selectedChoices = currentCard?.value.split('、').filter(Boolean) ?? [];
  const subjectIndex = (value: string) => {
    const index = SUBJECTS.indexOf(value as typeof SUBJECTS[number]);
    const legacy = GENRES.indexOf(value as typeof GENRES[number]);
    return index >= 0 ? index : legacy >= 0 ? PRESET_SUBJECTS[legacy] : 0;
  };
  const genreName = (genre: string) => !genre ? t('director.chooseGenre') : SUBJECTS.includes(genre as typeof SUBJECTS[number]) || GENRES.includes(genre as typeof GENRES[number]) ? t(`director.ui.subject.${subjectIndex(genre)}`) : genre;
  const genreImage = (genre: string) => SUBJECTS.includes(genre as typeof SUBJECTS[number]) || GENRES.includes(genre as typeof GENRES[number]) ? assets.genres[subjectIndex(genre)]?.path : undefined;
  const genreArtwork = (genre: string) => genreImage(genre) ? <>
    <span className="dc-genre-glow" style={{ backgroundImage: `url(${genreImage(genre)})` }} aria-hidden="true" />
    <span className="dc-genre-photo"><img src={genreImage(genre)} alt="" /></span>
    <span className="dc-genre-rim" aria-hidden="true" />
  </> : <><DirectorReferenceIcon name="Custom" size={32} /><span>{genreName(genre)}</span></>;
  const shiftGenre = (fusion: boolean, direction: number) => {
    const selected = subjectIndex(fusion ? preset.fusion_genre : preset.primary_genre);
    let index = (selected + direction + SUBJECTS.length) % SUBJECTS.length;
    if (SUBJECTS[index] === (fusion ? preset.primary_genre : preset.fusion_genre)) index = (index + direction + SUBJECTS.length) % SUBJECTS.length;
    setActiveTemplate(null); setPreset(fusion ? { fusion_genre: SUBJECTS[index] } : { primary_genre: SUBJECTS[index] });
  };
  const genreButtons = (fusion = false) => <div className="dc-genre-list" aria-label={t(fusion ? 'director.fusionGenre' : 'director.primaryGenre')}
    onWheel={(event) => { if (readOnly || Math.abs(event.deltaY) < 2 || Date.now() - wheelTime.current < 180) return; event.stopPropagation(); wheelTime.current = Date.now(); shiftGenre(fusion, event.deltaY > 0 ? 1 : -1); }}
    onKeyDown={(event) => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key) || readOnly) return;
      event.preventDefault();
      shiftGenre(fusion, event.key === 'ArrowUp' ? -1 : 1);
    }}>
    {[-2, -1, 0, 1, 2].map((offset) => {
      const index = (subjectIndex(fusion ? preset.fusion_genre : preset.primary_genre) + offset + SUBJECTS.length) % SUBJECTS.length;
      const genre = SUBJECTS[index];
      return <button type="button" key={genre} disabled={readOnly || (fusion ? preset.primary_genre : preset.fusion_genre) === genre}
      aria-pressed={(fusion ? preset.fusion_genre : preset.primary_genre) === genre}
      onClick={() => { if (index === 14) { setCustomGenre(fusion ? 'fusion_genre' : 'primary_genre'); setCustomGenreText(''); return; } setActiveTemplate(null); setPreset(fusion ? { fusion_genre: genre } : { primary_genre: genre }); }}>
      <span className={`dc-genre-avatar${assets.genres[index] ? '' : ' is-custom'}`} aria-hidden="true">{assets.genres[index] ? <img src={assets.genres[index].path} alt="" /> : <DirectorReferenceIcon name="Custom" size={16} />}</span>{t(`director.ui.subject.${index}`)}
      {(fusion ? preset.fusion_genre : preset.primary_genre) === genre && <DirectorReferenceIcon name="GenrePointer" className="dc-genre-pointer" size={10} />}
    </button>; })}
  </div>;

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      event.target.value = '';
      window.alert(t('director.sourceTooLarge'));
      return;
    }
    const sourceText = await file.text();
    onChange((current) => ({ ...current, sourceFileName: file.name, sourceText }));
  };

  return (
    <div className="dc-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div ref={dialogRef} className={`dc-preset-dialog${showPresets ? '' : ' no-presets'}`} role="dialog" aria-modal="true" aria-labelledby="dc-preset-title">
        {showPresets && <aside className="dc-top8">
          <h2>{t('director.top8')}</h2>
          <div className="dc-top8-list">
            {GENRES.map((genre, index) => (
              <button
                ref={index === 0 ? firstRef : undefined}
                type="button"
                disabled={readOnly}
                key={genre}
                className={activeTemplate === index ? 'dc-top8-item is-active' : 'dc-top8-item'}
                aria-pressed={activeTemplate === index}
                onClick={() => { const { name: _name, ...patch } = PRESET_DEFAULTS[index]; setActiveTemplate(index); setFusionPicking(false); setPreset(patch); }}
              >
                {index < 3 && <><img className="dc-top8-photo" src={assets.genres[PRESET_SUBJECTS[index]].path} alt="" /><span className="dc-top8-shade" aria-hidden="true" /></>}
                {index < 3 ? <span className="dc-rank-wreath"><DirectorReferenceIcon name="LaurelLeft" size={16} />{index + 1}<DirectorReferenceIcon name="LaurelRight" size={16} /></span> : <span className="dc-rank">{index + 1}</span>}
                <span className="dc-top8-name">{t(`director.genre.${index + 1}`)}</span>
                {activeTemplate === index && <Check size={16} aria-hidden="true" />}
              </button>
            ))}
          </div>
        </aside>}
        <section className="dc-preset-main">
          <header className="dc-preset-header">
            <h2 id="dc-preset-title">{t('director.presetTitle')}</h2>
            <button type="button" className="dc-preset-advanced" aria-expanded={advanced} onClick={() => { setAdvanced(!advanced); setField(null); }}><SlidersHorizontal size={16} />{t('director.ui.advanced')}</button>
            <button type="button" className="dc-icon-button" onClick={onClose} aria-label={t('director.close')}><X size={20} /></button>
          </header>
          {!advanced && <div className="dc-preset-visual">
            <div className={`dc-genre-stage${fusionPicking ? ' is-fused' : ''}`}>
              {genreButtons()}
              <div className="dc-genre-orbits">
                <div className="dc-genre-bubble" aria-label={`${t('director.primaryGenre')}: ${genreName(preset.primary_genre)}`}>
                  {genreArtwork(preset.primary_genre)}
                </div>
                {fusionPicking ? <div className="dc-genre-bubble dc-genre-fusion" aria-label={`${t('director.fusionGenre')}: ${genreName(preset.fusion_genre)}`}>
                  {genreArtwork(preset.fusion_genre)}
                  <button type="button" disabled={readOnly} onClick={() => { setPreset({ fusion_genre: '' }); setFusionPicking(false); }} aria-label={t('director.removeFusion')}><MinusMark /></button>
                </div> : <button type="button" className="dc-add-fusion" disabled={readOnly} onClick={() => setFusionPicking(true)}><DirectorReferenceIcon name="FusionPlus" size={30} />{t('director.fusionGenre')}</button>}
              </div>
              {fusionPicking && genreButtons(true)}
            </div>
            <div className="dc-preset-summary">
              {cards.map(({ key, label, icon: Icon, value }) => <button type="button" className={`dc-summary-card${value ? '' : ' is-automatic'}`} key={key} aria-label={t(`director.${label}`)}
                disabled={readOnly} aria-expanded={field === key} onClick={(event) => {
                  const card = event.currentTarget.getBoundingClientRect();
                  const main = event.currentTarget.closest('.dc-preset-main')!.getBoundingClientRect();
                  const popupWidth = Math.min(key === 'visual_style' ? 413 : key === 'structure' ? 373 : 345, main.width - 32);
                  const viewportLeft = Math.max(5, Math.min(card.left + card.width / 2 - popupWidth / 2, window.innerWidth - popupWidth - 5));
                  setFieldAnchor({ left: viewportLeft - main.left, bottom: main.bottom - card.top + 8 });
                  fieldTrigger.current = event.currentTarget; setCustomField(false); setField(key);
                }}>
                <span className="dc-summary-icon"><Icon size={24} strokeWidth={1.5} /></span><span className="dc-summary-copy"><small>{t(`director.${label}`)}</small><strong>{value || t('director.ui.automatic')}</strong></span>
              </button>)}
            </div>
          </div>}
          {advanced && <fieldset className="dc-preset-scroll" disabled={readOnly}>
            <label className="dc-field-label dc-title-field">{t('director.workTitle')}
              <input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} maxLength={160} />
            </label>
            <div className="dc-mode-tabs" role="group" aria-label={t('director.mode')}>
              <button type="button" disabled={sourceLocked} aria-pressed={preset.mode === 'original'} onClick={() => setPreset({ mode: 'original', adapt_direction: null })}>{t('director.original')}</button>
              <button type="button" disabled={sourceLocked} aria-pressed={preset.mode === 'adaptation'} onClick={() => setPreset({ mode: 'adaptation', adapt_direction: preset.adapt_direction ?? 'condense' })}>{t('director.adaptation')}</button>
            </div>
            <div className="dc-numeric-fields">
              <label>{t('director.primaryGenre')}<input value={preset.primary_genre} onChange={(event) => setPreset({ primary_genre: event.target.value })} /></label>
              <label>{t('director.fusionGenre')}<input value={preset.fusion_genre} onChange={(event) => setPreset({ fusion_genre: event.target.value })} /></label>
            </div>
            {preset.mode === 'adaptation' && (
              <div className="dc-adapt-controls">
                <label className="dc-field-label">{t('director.adaptDirection')}
                  <select value={preset.adapt_direction ?? 'condense'} onChange={(event) => setPreset({ adapt_direction: event.target.value as DirectorPreset['adapt_direction'] })}>
                    {ADAPT_DIRECTIONS.map((direction) => <option value={direction} key={direction}>{t(`director.direction.${direction}`)}</option>)}
                  </select>
                </label>
                <label className="dc-field-label">{t('director.sourceEpisodeLabel')}
                  <input disabled={sourceLocked} value={preset.source_episode_label} onChange={(event) => setPreset({ source_episode_label: event.target.value })} placeholder="EP02" />
                </label>
                <label className="dc-field-label">{t('director.spec.deliveryLabel')}
                  <input value={preset.delivery_episode_label} onChange={(event) => setPreset({ delivery_episode_label: event.target.value })} placeholder={preset.source_episode_label || 'EP01'} />
                </label>
                <label className="dc-field-label">{t('director.spec.fidelity')}
                  <select value={preset.fidelity} onChange={(event) => setPreset({ fidelity: event.target.value as DirectorPreset['fidelity'] })}>
                    <option value="strict">{t('director.spec.fidelityStrict')}</option><option value="approved_changes">{t('director.spec.fidelityApproved')}</option>
                  </select>
                </label>
                <label className="dc-field-label">{t('director.spec.allowedAdditions')}
                  <textarea value={preset.allowed_additions} onChange={(event) => setPreset({ allowed_additions: event.target.value })} maxLength={5000} />
                </label>
                <label className="dc-field-label">{t('director.sourceFile')}
                  <input type="file" disabled={sourceLocked} accept=".txt,.md,text/plain,text/markdown" onChange={onFile} />
                </label>
                {draft.sourceFileName && <span className="dc-source-chip">{draft.sourceFileName}</span>}
              </div>
            )}
            {preset.mode === 'adaptation' && <label className="dc-field-label dc-source-text">{t('director.sourceText')}
              <textarea readOnly={sourceLocked} value={draft.sourceText} onChange={(event) => onChange({ ...draft, sourceText: event.target.value, sourceFileName: '' })} maxLength={1024 * 1024} />
            </label>}
            <div className="dc-preset-fields">
              <label>{t('director.audience')}<input value={preset.audience} onChange={(event) => setPreset({ audience: event.target.value })} /></label>
              <label>{t('director.characters')}<input value={preset.characters} onChange={(event) => setPreset({ characters: event.target.value })} /></label>
              <label>{t('director.era')}<input value={preset.era} onChange={(event) => setPreset({ era: event.target.value })} /></label>
              <label>{t('director.highlights')}<input value={preset.highlights} onChange={(event) => setPreset({ highlights: event.target.value })} /></label>
              <label>{t('director.visualStyle')}<input value={preset.visual_style} onChange={(event) => setPreset({ visual_style: event.target.value })} /></label>
              <label>{t('director.spec.narrativeTone')}<input value={preset.narrative_tone} maxLength={2000} onChange={(event) => setPreset({ narrative_tone: event.target.value })} /></label>
              <label>{t('director.spec.endingType')}<select value={preset.ending_type} onChange={(event) => setPreset({ ending_type: event.target.value as DirectorPreset['ending_type'] })}>
                {(['closed', 'open', 'reversal', 'tragic'] as const).map((value) => <option key={value} value={value}>{t(`director.spec.ending.${value}`)}</option>)}
              </select></label>
              <label>{t('director.spec.language')}<select value={preset.output_language} onChange={(event) => setPreset({ output_language: event.target.value })}>
                <option value="zh-CN">{t('director.spec.chinese')}</option><option value="en">{t('director.spec.english')}</option><option value="vi">{t('director.spec.vietnamese')}</option>
                {!['zh-CN', 'en', 'vi'].includes(preset.output_language ?? '') && <option value={preset.output_language}>{preset.output_language}</option>}
              </select></label>
              <label>{t('director.spec.market')}<input value={preset.market} maxLength={100} onChange={(event) => setPreset({ market: event.target.value })} /></label>
              <label>{t('director.textModel')}{modelOptions ? <select value={preset.model_name} onChange={event => setPreset({ model_name: event.target.value })}>
                {!modelOptions.some(option => option.id === preset.model_name) && <option value={preset.model_name} disabled>{preset.model_name || t('director.modelUnavailable')}</option>}
                {modelOptions.map(option => <option key={option.id} value={option.id}>{option.label} · {option.providerLabel}</option>)}
              </select> : <input value={fixedModel ?? preset.model_name ?? ''} disabled={Boolean(fixedModel)} onChange={(event) => setPreset({ model_name: event.target.value })} placeholder={t('director.systemModel')} />}{fixedModel && <small>{t('director.fixedModel')}</small>}</label>
              <label>{t('director.structure.label')}<select value={preset.structure} onChange={(event) => setPreset({ structure: event.target.value })}>
                {STRUCTURES.map((value) => <option key={value} value={value}>{t(`director.spec.structures.${value}`)}</option>)}
                {!STRUCTURES.includes(preset.structure as typeof STRUCTURES[number]) && <option value={preset.structure}>{t('director.spec.legacyStructure', { value: preset.structure })}</option>}
              </select></label>
            </div>
            <label className="dc-field-label">{t('director.spec.lockedFacts')}<textarea value={preset.locked_facts} maxLength={10000} onChange={(event) => setPreset({ locked_facts: event.target.value })} /></label>
            <div className="dc-numeric-fields">
              <label>{t('director.episodeCount')}<input type="number" min={1} max={100} value={preset.episode_count} onChange={(event) => setPreset({ episode_count: Math.min(100, Math.max(1, Number(event.target.value) || 1)) })} /></label>
              <label>{t('director.durationSeconds')}<input type="number" min={1} step={1} aria-invalid={!durationValid} value={durationInput} onChange={(event) => setDurationInput(event.target.value)} /></label>
            </div>
          </fieldset>}
          {(readOnly || sourceLocked) && <div className="dc-preset-locked-note" role="status">{t(readOnly ? 'director.presetLocked' : 'director.revision.settingsHint')}</div>}
          <footer className="dc-preset-footer">
            <label className="dc-presets-toggle"><input type="checkbox" role="switch" checked={showPresets} onChange={(event) => setShowPresets(event.target.checked)} /><span>{t('director.ui.showPresets')}</span></label>
            <button type="button" onClick={onClose}>{t('director.cancel')}</button>
            <button type="button" disabled={readOnly || !durationValid} className="dc-primary-button" onClick={() => {
              if (durationValid) onConfirm({ ...draft, preset: { ...preset, duration_seconds: durationSeconds } });
            }}>{t(sourceLocked ? 'director.revision.preview' : 'director.confirm')}</button>
          </footer>
          {currentCard && <div className="dc-field-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setField(null); }}>
            <section className={`dc-field-popover${field === 'structure' ? ' is-structure' : ''}${field === 'visual_style' ? ' is-style' : ''}`} style={{ left: fieldAnchor.left, bottom: fieldAnchor.bottom, maxHeight: Math.max(120, (dialogRef.current?.getBoundingClientRect().bottom ?? window.innerHeight) - fieldAnchor.bottom - 16) }} role="dialog" aria-modal="true" aria-label={t(`director.${currentCard.label}`)}>
              {field !== 'structure' && <header><h3>{t(`director.${currentCard.label}`)}</h3><small>{t('director.ui.maxChoices', { count: CHOICE_LIMITS[field!] })}</small></header>}
              {field === 'structure' ? <>
                <h3>{t('director.ui.episodeCountLabel')}</h3>
                <div className="dc-range-row"><input autoFocus className="dc-episode-range" type="range" min={1} max={100} value={preset.episode_count} aria-label={t('director.ui.episodeSlider')} onChange={(event) => setPreset({ episode_count: Number(event.target.value) })} /><label><input type="number" min={1} max={100} aria-label={t('director.episodeCount')} value={preset.episode_count} onChange={(event) => setPreset({ episode_count: Math.max(1, Math.min(100, Number(event.target.value) || 1)) })} />{t('director.episodeUnit')}</label></div>
                <h3>{t('director.structure.label')}</h3>
                <div className="dc-structure-options">{STRUCTURES.map((value) => <button type="button" key={value} aria-pressed={preset.structure === value} onClick={() => setPreset({ structure: value })}>{t(`director.spec.structures.${value}`)}{preset.structure === value && <Check size={14} />}</button>)}</div>
              </> : <>
                <div className={`dc-choice-options${field === 'visual_style' ? ' dc-style-grid' : ''}`}>
                  {field === 'visual_style' && <button type="button" className="dc-style-custom" aria-expanded={customField} onClick={() => setCustomField(!customField)}><Plus size={20} /><span>{t('director.ui.custom')}</span></button>}
                  {CHOICES[field!]?.map((option, index) => {
                  const chosen = selectedChoices.includes(option);
                  return <button type="button" key={option} aria-pressed={chosen} disabled={!chosen && CHOICE_LIMITS[field!] > 1 && selectedChoices.length >= CHOICE_LIMITS[field!]} onClick={() => {
                    const next = chosen ? selectedChoices.filter((value) => value !== option) : CHOICE_LIMITS[field!] === 1 ? [option] : [...selectedChoices, option];
                    setPreset({ [currentCard.key]: next.join('、') });
                    if (option === SUBJECTS[14]) setCustomField(!chosen);
                  }}>{field === 'visual_style' && <img src={assets.styles[index].path} alt="" loading="lazy" />}<span>{t(`director.ui.choices.${field}.${index}`)}</span>{chosen && <Check size={12} />}</button>;
                })}</div>
                {customField && <label className="dc-field-label">{t(`director.${currentCard.label}`)}<textarea autoFocus value={currentCard.value} onChange={(event) => setPreset({ [currentCard.key]: event.target.value })} /></label>}
              </>}
            </section>
          </div>}
          {customGenre && <div className="dc-field-scrim"><form className="dc-custom-genre" role="dialog" aria-modal="true" aria-label={t('director.surface.customGenre')} onSubmit={event => {
            event.preventDefault(); const value = customGenreText.trim();
            if (!value || value === preset[customGenre === 'primary_genre' ? 'fusion_genre' : 'primary_genre']) return;
            setPreset({ [customGenre]: value }); setActiveTemplate(null); setCustomGenre(null);
          }}><h3>{t('director.surface.customGenre')}</h3><input autoFocus maxLength={100} aria-label={t('director.surface.customGenre')} value={customGenreText} onChange={e => setCustomGenreText(e.target.value)} /><footer><button type="button" onClick={() => setCustomGenre(null)}>{t('director.cancel')}</button><button className="dc-primary-button" type="submit" disabled={!customGenreText.trim() || customGenreText.trim() === preset[customGenre === 'primary_genre' ? 'fusion_genre' : 'primary_genre']}>{t('director.confirm')}</button></footer></form></div>}
        </section>
      </div>
    </div>
  );
}

function MinusMark() { return <DirectorReferenceIcon name="FusionRemove" size={14} />; }
