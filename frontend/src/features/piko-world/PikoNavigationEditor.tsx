import { useCallback, useEffect, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { PikoNavigation, PikoOcclusion } from './runtime/map-package-schema';
import { collisionOnlyDraft, translateRegion, navigationIssues } from './runtime/navigation-editor';
import { pointInPolygon } from './runtime/navigation-geometry';
import { canStand } from './runtime/character-movement';
import styles from './piko-navigation-editor.module.css';

type Occluder = PikoOcclusion['occluders'][number];

type Props = {
  navigation: PikoNavigation;
  fit: { x: number; y: number; scale: number };
  player: { x: number; y: number };
  onApply: (value: PikoNavigation) => void;
  onEditing: (value: boolean) => void;
  onPlay: () => void;
  occlusion?: PikoOcclusion | null;
  onOcclusionApply?: (value: PikoOcclusion) => void;
};
const copy = (n: PikoNavigation): PikoNavigation => structuredClone(n);

const round2 = (n: number) => Math.round(n * 100) / 100;

function polygonBounds(points: {x:number;y:number}[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: Math.floor(minX), y: Math.floor(minY), width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY) };
}

function createOccluderId(existing: Set<string>, base: string) {
  if (!existing.has(base)) return base;
  let i = 1;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export default function PikoNavigationEditor({ navigation, fit, player, onApply, onEditing, onPlay, occlusion, onOcclusionApply }: Props) {
  const [open, setOpen] = useState(false);
  const [panelHidden, setPanelHidden] = useState(false);
  const [mode, setMode] = useState<'collision' | 'occlusion'>('collision');
  const [drawing, setDrawing] = useState(false);
  const [path, setPath] = useState<{x:number;y:number}[]>([]);
  const [cursor, setCursor] = useState<{x:number;y:number}|null>(null);
  const [editing, setEditing] = useState(true);
  const [draft, setDraft] = useState(() => collisionOnlyDraft(navigation));
  const original = useRef(copy(navigation));
  const cleanup = useRef(() => { onApply(copy(original.current)); onEditing(false); });
  cleanup.current = () => {
    onApply(copy(original.current));
    onOcclusionApply?.(structuredClone(occlusion ?? { schemaVersion: 1, mapId: navigation.mapId, occluders: [] }));
    onEditing(false);
  };
  useEffect(() => () => cleanup.current(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const drag = useRef<{ id: string; start: {x:number;y:number}; before: PikoNavigation; pointer: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const [occluders, setOccluders] = useState<Occluder[]>(occlusion?.occluders ?? []);
  const [selectedOccluder, setSelectedOccluder] = useState<string | null>(null);
  const regions = draft.colliders;

  const point = (event: React.PointerEvent | React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: Math.round(Math.max(0, Math.min(2048, (event.clientX-rect.left)*2048/rect.width))), y: Math.round(Math.max(0, Math.min(1152, (event.clientY-rect.top)*1152/rect.height))) };
  };

  const cancelDrawing = useCallback(() => {setDrawing(false);setPath([]);setCursor(null);}, []);

  const closePath = useCallback(() => {
    if(path.length<3){setMessage('至少需要三个节点才能闭合。');setPanelHidden(false);return;}
    const errors = navigationIssues({ ...draft, walkableAreas: [], colliders: [{ id: 'outline', kind: 'prop', points: path }] });
    if (errors.length) { setMessage('轮廓存在交叉、重复或退化，请撤回节点修改后再闭合。'); setPanelHidden(false); return; }
    if (mode === 'collision') {
      const next=copy(draft),id=`prop-${crypto.randomUUID()}`;
      next.colliders.push({id,kind:'prop',points:structuredClone(path)});
      setDraft(next);
      onApply(copy(next));
      setSelected(id);
      cancelDrawing();
      setPanelHidden(true);
      setMessage('');
    } else {
      const bounds = polygonBounds(path);
      const outline = path.map(p => ({ x: round2(p.x - bounds.x), y: round2(p.y - bounds.y) }));
      const id = createOccluderId(new Set(occluders.map(o => o.id)), `occluder-${navigation.mapId}`);
      const newOccluder: Occluder = {
        id,
        src: 'base.png',
        position: { x: bounds.x, y: bounds.y },
        depthY: Math.round(bounds.y + bounds.height),
        frame: bounds,
        outline,
      };
      const nextOccluders = [...occluders, newOccluder];
      setOccluders(nextOccluders);
      const occlusionData: PikoOcclusion = { schemaVersion: 1, mapId: navigation.mapId, occluders: nextOccluders };
      onOcclusionApply?.(occlusionData);
      setSelectedOccluder(id);
      cancelDrawing();
      setPanelHidden(true);
      setMessage('');
    }
  }, [path, mode, draft, occluders, navigation.mapId, onApply, onOcclusionApply, cancelDrawing]);

  const apply = () => {
    const issues = navigationIssues(draft);
    if(issues.length) { setMessage('请先修复轮廓问题，再试走。'); return; }
    if(!canStand(player,draft)) { setMessage('当前角色位置被草稿阻挡。请撤销该处修改，或恢复原图试走到空地后再编辑。'); return; }
    onApply(copy(draft)); setEditing(false); onEditing(false); onPlay();
  };

  const close = () => {
    drag.current = null;
    cancelDrawing();
    setPanelHidden(false);
    onApply(copy(original.current));
    onOcclusionApply?.(structuredClone(occlusion ?? { schemaVersion: 1, mapId: navigation.mapId, occluders: [] }));
    setOpen(false);
    onEditing(false);
    onPlay();
    setMessage('');
  };

  const finishDrag = (cancelled: boolean) => {
    const current=drag.current; if(!current)return;
    if(cancelled) setDraft(current.before);
    else if(JSON.stringify(current.before)!==JSON.stringify(draft)) {
      onApply(copy(draft));
    }
    drag.current=null;
  };

  const handleExport = () => {
    const data = mode === 'collision' ? draft : { schemaVersion: 1, mapId: navigation.mapId, occluders };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${navigation.mapId}-${mode === 'collision' ? 'navigation' : 'occlusion'}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const resumeEditing = () => { setEditing(true); onEditing(true); };
  const startDrawing = () => {
    resumeEditing(); setDrawing(true); setPath([]); setCursor(null); setMessage(''); setPanelHidden(true);
  };

  // Switch tab: reset drawing state
  const switchMode = (newMode: 'collision' | 'occlusion') => {
    if (drawing) cancelDrawing();
    resumeEditing();
    setMode(newMode);
  };

  useEffect(()=>{
    if(!open || !editing)return;
    const keydown=(event: KeyboardEvent)=>{
      const target=event.target;
      if(target instanceof HTMLElement && (target.matches('input,textarea,select') || target.isContentEditable))return;
      if(drawing){
        if(event.key==='Escape'){event.preventDefault();if(!event.repeat)cancelDrawing();}
        else if(event.key==='Backspace' || event.key==='Delete'){event.preventDefault();if(!event.repeat)setPath(points=>points.slice(0,-1));}
        else if(event.key==='Enter'){event.preventDefault();if(!event.repeat)closePath();}
        return;
      }
      if (drag.current) return;
      // Delete selected region
      if((event.key==='Delete' || event.key==='Backspace') && !event.metaKey && !event.ctrlKey && !event.altKey){
        if(mode === 'collision' && selected){
          event.preventDefault();
          if(event.repeat)return;
          const next=copy(draft);
          next.colliders=next.colliders.filter(r=>r.id!==selected);
          setDraft(next);
          setSelected(null);
          onApply(copy(next));
          setMessage('');
        } else if(mode === 'occlusion' && selectedOccluder){
          event.preventDefault();
          if(event.repeat)return;
          const nextOccluders = occluders.filter(o => o.id !== selectedOccluder);
          setOccluders(nextOccluders);
          setSelectedOccluder(null);
          const occlusionData: PikoOcclusion = { schemaVersion: 1, mapId: navigation.mapId, occluders: nextOccluders };
          onOcclusionApply?.(occlusionData);
          setMessage('');
        }
      }
    };
    window.addEventListener('keydown',keydown);
    return ()=>window.removeEventListener('keydown',keydown);
  }, [open, editing, drawing, mode, selected, selectedOccluder, draft, occluders, navigation.mapId, onApply, onOcclusionApply, cancelDrawing, closePath]);

  // Handle SVG click for occluder selection (non-drawing mode)
  const handleOccluderClick = (event: React.MouseEvent) => {
    if (mode !== 'occlusion' || drawing || !editing) return;
    const p = point(event);
    for (let i = occluders.length - 1; i >= 0; i--) {
      const occluder = occluders[i];
      if (occluder.outline && occluder.frame) {
        const polygon = occluder.outline.map(pt => ({ x: pt.x + occluder.position.x, y: pt.y + occluder.position.y }));
        if (pointInPolygon(p, polygon)) {
          setSelectedOccluder(occluder.id);
          return;
        }
      }
    }
    setSelectedOccluder(null);
  };

  return <>
    {!open && <button className={styles.launch} onClick={()=>{setOpen(true);setEditing(true);onEditing(true);}}>场景调试</button>}
    {open && <>
      <svg ref={svgRef} className={styles.overlay} viewBox="0 0 2048 1152" aria-label="地图区域编辑层"
        style={{left:fit.x,top:fit.y,width:2048*fit.scale,height:1152*fit.scale,pointerEvents:editing?'auto':'none',cursor:drawing?'crosshair':undefined}}
        onPointerDownCapture={e=>{
          if(!drawing || e.button!==0)return;
          e.stopPropagation();e.preventDefault();const p=point(e);
          if(path.length>=3 && Math.hypot(p.x-path[0].x,p.y-path[0].y)*fit.scale<=10){closePath();return;}
          if(path.some(v=>v.x===p.x && v.y===p.y)){setMessage('节点重复，请选择新位置。');return;}
          setPath(v=>[...v,p]);setCursor(p);
        }}
        onPointerMove={e=>{
          if(drawing){setCursor(point(e));return;}
          const d=drag.current;if(!d || d.pointer!==e.pointerId)return;
          const next=copy(d.before),p=point(e),region=next.colliders.find(r=>r.id===d.id)!;
          region.points=translateRegion(region.points,p.x-d.start.x,p.y-d.start.y);
          setDraft(next);
        }}
        onClick={handleOccluderClick}
        onPointerUp={()=>finishDrag(false)} onPointerCancel={()=>finishDrag(true)} onLostPointerCapture={()=>finishDrag(false)}>
        {/* Collision zones */}
        {mode === 'collision' && regions.map(region=>{
          const color='#ff7777';
          const isSelected = selected === region.id;
          return <polygon key={region.id} points={region.points.map(p=>`${p.x},${p.y}`).join(' ')} fill={color} fillOpacity={isSelected?0.3:0.1} stroke={isSelected?'#ffaa00':color} strokeWidth={isSelected?3:1} vectorEffect="non-scaling-stroke"
            onPointerDown={e=>{if(!editing || e.button!==0 || drag.current)return;e.stopPropagation();setSelected(region.id);
              drag.current={id:region.id,start:point(e),before:copy(draft),pointer:e.pointerId};svgRef.current?.setPointerCapture(e.pointerId);
            }} style={{cursor:editing?'move':undefined}}
            />;
        })}
        {/* Occlusion zones */}
        {mode === 'occlusion' && occluders.map(occluder => {
          if (!occluder.outline || !occluder.frame) return null;
          const polygon = occluder.outline.map(p => `${p.x + occluder.position.x},${p.y + occluder.position.y}`).join(' ');
          const isSelected = selectedOccluder === occluder.id;
          return <g key={occluder.id} style={{cursor: editing ? 'pointer' : undefined}}>
            <polygon points={polygon} fill="#8b5cf6" fillOpacity={isSelected ? 0.3 : 0.15} stroke={isSelected ? '#fbbf24' : '#8b5cf6'} strokeWidth={isSelected ? 3 : 1} vectorEffect="non-scaling-stroke" />
          </g>;
        })}
        {/* Drawing path */}
        {drawing && <g pointerEvents="none">
          <polyline points={[...path,...(cursor?[cursor]:[])].map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke={mode === 'occlusion' ? '#22c55e' : '#ffda70'} strokeWidth={2/fit.scale}/>
          {path.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={5/fit.scale} fill={i===0?'#62dca0':(mode === 'occlusion' ? '#22c55e' : '#ffda70')} stroke="#17212b" strokeWidth={1/fit.scale}/>)}
        </g>}
        <circle cx={player.x} cy={player.y} r={8} fill="none" stroke="#ffe06b" strokeWidth={2/fit.scale}/>
        <circle cx={player.x} cy={player.y} r={2/fit.scale} fill="#ffe06b"/>
      </svg>
      {panelHidden && <button className={styles.launch} aria-label="显示调试工具" title="显示调试工具" onClick={()=>setPanelHidden(false)}><PanelLeftOpen size={16} aria-hidden="true" /></button>}
      <section className={styles.panel} aria-label="场景调试工具" hidden={panelHidden}>
        {/* Tab bar */}
        <div className={styles.row} style={{gap:4}}>
          <button
            onClick={() => switchMode('collision')} aria-pressed={mode === 'collision'}
            style={{background: mode === 'collision' ? '#0e333c' : undefined, borderColor: mode === 'collision' ? '#00bdcf' : undefined, flex:1}}
          >碰撞区</button>
          <button
            onClick={() => switchMode('occlusion')} aria-pressed={mode === 'occlusion'}
            style={{background: mode === 'occlusion' ? '#0e333c' : undefined, borderColor: mode === 'occlusion' ? '#00bdcf' : undefined, flex:1}}
          >遮挡层</button>
          <button className={styles.hideButton} aria-label="隐藏调试工具" title="隐藏调试工具" onClick={()=>setPanelHidden(true)}><PanelLeftClose size={16} aria-hidden="true" /></button>
        </div>

        <div className={styles.row}>
          <button className={styles.primary} disabled={drawing} onClick={startDrawing}>{mode === 'collision' ? '开始画区域' : '开始画遮挡区'}</button>
          {!editing && <button onClick={resumeEditing}>继续编辑</button>}
          {drawing && <button onClick={cancelDrawing}>取消绘制</button>}
        </div>
        <div className={styles.row}>
          {mode === 'collision' && <button disabled={!editing || drawing} onClick={apply}>试走</button>}
          <button disabled={drawing} onClick={handleExport}>导出 JSON</button>
          <button onClick={close}>退出调试</button>
        </div>
        <p>草稿仅用于调试，导出 JSON 后写入地图文件才会保存。</p>
        {mode === 'occlusion' && !onOcclusionApply && <p>遮挡轮廓可编辑和导出，导入地图后生效。</p>}

        {/* Error message */}
        {message && <p role="status" className={styles.error}>{message}</p>}
      </section>
    </>}
  </>;
}
