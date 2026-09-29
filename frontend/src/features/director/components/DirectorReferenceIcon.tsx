// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** Render pinned reference geometry, never HTML or remote SVG at runtime. */
import { createElement, useId, type SVGProps } from 'react';
import catalog from '../assets/libtv-icons.json';

type Part = { tag: string; attrs: Record<string, string | undefined>; children: Part[] };
type IconProps = Omit<SVGProps<SVGSVGElement>, 'name'> & { size?: number };
export type ReferenceIconName = keyof typeof catalog;
const allowedTags = new Set(['svg', 'g', 'path', 'circle', 'rect', 'ellipse', 'polygon', 'polyline', 'line', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath']);

export function DirectorReferenceIcon({ name, size = 16, ...props }: IconProps & { name: ReferenceIconName }) {
  const id = useId().replace(/:/g, '');
  const shape: Part = catalog[name];
  const render = (part: Part, key: number): ReturnType<typeof createElement> | null => {
    if (!allowedTags.has(part.tag)) return null;
    const attrs: Record<string, string> = {};
    for (const [name, value] of Object.entries(part.attrs)) {
      // Only embedded fragment references are allowed; no scripts or network links.
      if (value === undefined || /^on|href|style/i.test(name) || /https?:|javascript:|data:/i.test(value)) continue;
      const prop = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      attrs[prop] = name === 'id' ? `${id}-${value}` : value.replace(/url\(#([^)]+)\)/g, `url(#${id}-$1)`);
    }
    return createElement(part.tag, { ...attrs, key }, part.children.map(render));
  };
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox={shape.attrs.viewBox} fill="none" {...props}>
    {shape.children.map(render)}
  </svg>;
}

const icon = (name: ReferenceIconName) => function ReferenceGlyph(props: IconProps) { return <DirectorReferenceIcon name={name} {...props} />; };
export const ArrowUp = icon('Send');
export const ChevronDown = icon('ChevronDown');
export const Clock3 = icon('History');
export const History = icon('History');
export const Minus = icon('Minimize');
export const PanelRight = icon('Dock');
export const Plus = icon('Plus');
export const Settings2 = icon('Settings');
export const SlidersHorizontal = icon('Settings');
export const Share2 = icon('Share');
export const Plug = icon('Plugin');
export const Hand = icon('Hand');
export const ScrollText = icon('Preset');
export const MessageCirclePlus = icon('NewConversation');
export const UsersRound = icon('Audience');
export const Smile = icon('Character');
export const Theater = icon('Era');
export const KeyRound = icon('Highlights');
export const Image = icon('Style');
export const Film = icon('Structure');
export const X = icon('Close');
export const Check = icon('Check');
export const ChevronRight = icon('ChevronRight');
export const FileText = icon('Document');
export const Caption = icon('Caption');
export const Sparkles = icon('Creation');
export const Maximize2 = icon('Expand');
export const Download = icon('Download');
export const Search = icon('Search');
export const NodeCharacter = icon('NodeCharacter');
