// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** Markdown remains the save boundary; never rewrite a document merely on open. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { useTranslation } from 'react-i18next';
import { DirectorReferenceIcon, ChevronDown } from './DirectorReferenceIcon';

export function richTextExtensions(screenplay = false) {
  return [StarterKit.configure({ link: { openOnClick: false, autolink: false }, trailingNode: false }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: screenplay } }), TableKit, TaskList, TaskItem.configure({ nested: true })];
}

// Unknown source constructs must remain editable without passing through a lossy parser.
export function requiresSourceEditor(text: string): boolean {
  // A screenplay's internal horizontal rules are not YAML front matter.
  return /^---\s*\n/.test(text) || /(<\/?[a-zA-Z!][^>]*>|!\[|\[\^[^\]]+\]|^\s*\[[^\]]+\]:|\$\$)/m.test(text);
}

export function DirectorRichText({ value, onChange, readOnly, label, onSelection, sections = [], onSection, screenplay = false }: {
  value: string; onChange: (text: string) => void; readOnly: boolean; label: string;
  onSelection?: (text: string) => void; sections?: Array<{ id: string; label: string; selected: boolean }>;
  onSection?: (id: string) => void;
  screenplay?: boolean;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState(() => requiresSourceEditor(value));
  const [zoom, setZoom] = useState(100);
  const [menu, setMenu] = useState<'heading' | 'list' | null>(null);
  const [selection, setSelection] = useState('');
  const [activeHeading, setActiveHeading] = useState<number | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const navigationTarget = useRef<number | null>(null);
  const [, render] = useState(0);
  const extensions = useMemo(() => richTextExtensions(screenplay), [screenplay]);
  const editor = useEditor({ extensions, content: source ? '' : value, contentType: 'markdown', editable: !readOnly,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': t('director.documentBody'), 'aria-multiline': 'true', class: 'dc-rich-body' },
      handlePaste: (view, event) => {
        const plain = event.clipboardData?.getData('text/plain');
        if (plain == null) return false;
        event.preventDefault(); view.dispatch(view.state.tr.insertText(plain)); return true;
      },
    },
    onUpdate: ({ editor: current, transaction }) => { if (!source && transaction.docChanged) onChange(current.getMarkdown()); render(n => n + 1); },
    onSelectionUpdate: ({ editor: current }) => {
      const { from, to } = current.state.selection;
      setSelection(from === to ? '' : current.state.doc.textBetween(from, to, '\n'));
      render(n => n + 1);
    },
  });
  useEffect(() => { editor?.setEditable(!readOnly, false); }, [editor, readOnly]);
  useEffect(() => {
    if (requiresSourceEditor(value)) { setSource(true); return; }
    if (!editor || source || editor.getMarkdown() === value) return;
    // External changes are explicit private-draft restores, not background polling.
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
  }, [editor, value, source]);
  const headings: Array<{ title: string; pos: number; level: number }> = [];
  if (editor && !source) editor.state.doc.descendants((node, pos) => { if (node.type.name === 'heading') headings.push({ title: node.textContent, pos, level: node.attrs.level as number }); });
  const jumpToHeading = (pos: number) => {
    const dom = editor?.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      navigationTarget.current = pos;
      dom.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setActiveHeading(pos);
    }
  };
  const followScroll = () => {
    if (!scroll.current || !editor || source) return;
    // A short final section cannot reach the viewport top. Keep the clicked
    // destination selected until the user starts scrolling independently.
    if (navigationTarget.current !== null) return;
    const top = scroll.current.getBoundingClientRect().top + 24;
    let pos = headings[0]?.pos ?? null;
    for (const item of headings) {
      const dom = editor.view.nodeDOM(item.pos);
      if (dom instanceof HTMLElement && dom.getBoundingClientRect().top <= top) pos = item.pos;
    }
    setActiveHeading(pos);
  };
  const headingButtons = headings.map(item => <button key={item.pos} type="button"
    style={{ paddingLeft: 8 + (item.level - 1) * 8 }} title={item.title}
    aria-current={(activeHeading ?? headings[0]?.pos) === item.pos ? 'location' : undefined}
    onClick={() => jumpToHeading(item.pos)}>{item.title}</button>);
  const format = (kind: 'Bold' | 'Italic' | 'Strike') => {
    if (!editor) return;
    if (kind === 'Bold') editor.chain().focus().toggleBold().run();
    if (kind === 'Italic') editor.chain().focus().toggleItalic().run();
    if (kind === 'Strike') editor.chain().focus().toggleStrike().run();
  };
  return <>
    <div className="dc-rich-toolbar" role="toolbar" aria-label={t('director.surface.formatting')} onKeyDown={event => { if (event.key === 'Escape' && menu) { event.stopPropagation(); setMenu(null); } }}>
      <button type="button" title={t('director.surface.undo')} aria-label={t('director.surface.undo')} disabled={readOnly || source || !editor?.can().undo()} onClick={() => editor?.chain().focus().undo().run()}><DirectorReferenceIcon name="Undo" /></button>
      <button type="button" title={t('director.surface.redo')} aria-label={t('director.surface.redo')} disabled={readOnly || source || !editor?.can().redo()} onClick={() => editor?.chain().focus().redo().run()}><DirectorReferenceIcon name="Redo" /></button><i />
      <button type="button" aria-label={t('director.surface.zoomOut')} disabled={zoom <= 50} onClick={() => setZoom(value => Math.max(50, value - 10))}><DirectorReferenceIcon name="ZoomOut" /></button>
      <button type="button" className="dc-zoom-value" aria-label={t('director.surface.resetZoom')} onClick={() => setZoom(100)}>{zoom}%</button>
      <button type="button" aria-label={t('director.surface.zoomIn')} disabled={zoom >= 200} onClick={() => setZoom(value => Math.min(200, value + 10))}><DirectorReferenceIcon name="ZoomIn" /></button><i />
      <div className="dc-format-menu"><button type="button" disabled={source || readOnly} aria-expanded={menu === 'heading'} aria-label={t('director.surface.heading')} onMouseDown={e => e.preventDefault()} onClick={() => setMenu(menu === 'heading' ? null : 'heading')}><DirectorReferenceIcon name="Heading" /><ChevronDown size={10} /></button>
        {menu === 'heading' && <div role="menu">{[0, 1, 2, 3].map(level => <button type="button" key={level} onClick={() => { if (level) editor?.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 }).run(); else editor?.chain().focus().setParagraph().run(); setMenu(null); }}>{level ? `H${level}` : t('director.surface.paragraph')}</button>)}</div>}
      </div>
      <div className="dc-format-menu"><button type="button" disabled={source || readOnly} aria-expanded={menu === 'list'} aria-label={t('director.surface.list')} onMouseDown={e => e.preventDefault()} onClick={() => setMenu(menu === 'list' ? null : 'list')}><DirectorReferenceIcon name="List" /><ChevronDown size={10} /></button>
        {menu === 'list' && <div role="menu"><button type="button" onClick={() => { editor?.chain().focus().toggleBulletList().run(); setMenu(null); }}>{t('director.surface.bullets')}</button><button type="button" onClick={() => { editor?.chain().focus().toggleOrderedList().run(); setMenu(null); }}>{t('director.surface.numbered')}</button></div>}
      </div><i />
      {(['Bold', 'Italic', 'Strike'] as const).map(name => <button type="button" key={name} disabled={source || readOnly} aria-label={t(`director.surface.${name.toLowerCase()}`)} aria-pressed={editor?.isActive(name.toLowerCase()) ?? false} onMouseDown={e => e.preventDefault()} onClick={() => format(name)}><DirectorReferenceIcon name={name} /></button>)}
    </div>
    <div className="dc-rich-scroll" ref={scroll} onScroll={followScroll}
      onWheel={() => { navigationTarget.current = null; }} onTouchStart={() => { navigationTarget.current = null; }}
      onPointerDown={event => { if (!(event.target as HTMLElement).closest('nav')) navigationTarget.current = null; }}
      onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) navigationTarget.current = null; }}
      onClick={() => { if (menu) setMenu(null); }}>
      <nav className="dc-rich-outline" aria-label={t('director.sections')}>
        {sections.length ? sections.map(section => <div key={section.id}><button type="button" aria-current={section.selected ? 'page' : undefined} onClick={() => { if (!section.selected) onSection?.(section.id); }}>{section.label}</button>{section.selected && <div className="dc-rich-headings">{headingButtons}</div>}</div>) : <><strong>{label}</strong><div className="dc-rich-headings">{headingButtons}</div></>}
      </nav>
      <article className="dc-rich-paper" style={{ zoom: zoom / 100 }}><h2>{label}</h2>
        {source ? <><p className="dc-planning-hint">{requiresSourceEditor(value) && t('director.surface.sourcePreserved')}</p><textarea className="dc-source-editor" aria-label={t('director.documentBody')} value={value} readOnly={readOnly} onChange={e => onChange(e.target.value)} /></> : <EditorContent editor={editor} />}
      </article>
    </div>
    <div className="dc-editor-view-controls"><button type="button" aria-pressed={source} disabled={source && requiresSourceEditor(value)} onClick={() => { setSource(!source); setSelection(''); }}>{t(source ? 'director.surface.richView' : 'director.surface.sourceView')}</button></div>
    {!!selection && onSelection && <div className="dc-selection-bar"><span>{t('director.surface.selected', { count: [...selection].length })}</span><button type="button" onClick={() => onSelection(selection)}>{t('director.surface.sendSelection')}</button></div>}
  </>;
}
