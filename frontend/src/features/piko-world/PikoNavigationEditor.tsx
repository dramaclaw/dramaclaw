import { useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { PikoNavigationSchema, type PikoNavigation } from './runtime/map-package-schema';
import { collisionOnlyDraft, translateRegion, navigationIssues } from './runtime/navigation-editor';
import { canStand } from './runtime/character-movement';
import styles from './piko-navigation-editor.module.css';

type Props = {
  navigation: PikoNavigation;
  fit: { x: number; y: number; scale: number };
  player: { x: number; y: number };
  onApply: (value: PikoNavigation) => void;
  onEditing: (value: boolean) => void;
  onPlay: () => void;
};
const copy = (n: PikoNavigation): PikoNavigation => structuredClone(n);

export default function PikoNavigationEditor({ navigation, fit, player, onApply, onEditing, onPlay }: Props) {
  const [open, setOpen] = useState(false);
  const [panelHidden, setPanelHidden] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [path, setPath] = useState<{x:number;y:number}[]>([]);
  const [cursor, setCursor] = useState<{x:number;y:number}|null>(null);
  const [editing, setEditing] = useState(true);
  const [draft, setDraft] = useState(() => collisionOnlyDraft(navigation));
  const original = useRef(copy(navigation));
  const cleanup = useRef(() => { onApply(copy(original.current)); onEditing(false); });
  useEffect(() => () => cleanup.current(), []);
  const [selected, setSelected] = useState(navigation.colliders[0]?.id ?? '');
  const [vertex, setVertex] = useState<number | null>(null);
  const [undo, setUndo] = useState<PikoNavigation[]>([]);
  const [redo, setRedo] = useState<PikoNavigation[]>([]);
  const [message, setMessage] = useState('编辑草稿不会覆盖正式地图。');
  const [showBlocks, setShowBlocks] = useState(true);
  const drag = useRef<{ index: number | null; id: string; start: {x:number;y:number}; before: PikoNavigation; pointer: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const regions = draft.colliders;
  const active = regions.find(r => r.id === selected);
  useEffect(()=>{
    if(!draft.colliders.some(r=>r.id===selected)){setSelected(draft.colliders[0]?.id??'');setVertex(null);}
  },[draft.colliders,selected]);
  const issues = useMemo(() => navigationIssues(draft), [draft]);
  const key = `piko-navigation-draft-v1:${navigation.mapId}`;
  const commit = (next: PikoNavigation) => { setUndo(s => [...s.slice(-49), copy(draft)]); setRedo([]); setDraft(next); };
  const point = (event: React.PointerEvent | React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: Math.round(Math.max(0, Math.min(2048, (event.clientX-rect.left)*2048/rect.width))), y: Math.round(Math.max(0, Math.min(1152, (event.clientY-rect.top)*1152/rect.height))) };
  };
  const updatePoints = (next: PikoNavigation) => [...next.walkableAreas, ...next.colliders].find(r => r.id === selected)!;
  const cancelDrawing = () => {setDrawing(false);setPath([]);setCursor(null);};
  const closePath = () => {
    if(path.length<3){setMessage('至少需要三个节点才能闭合。');return;}
    const next=copy(draft),id=`prop-${crypto.randomUUID()}`;
    next.colliders.push({id,kind:'prop',points:structuredClone(path)});
    const errors=navigationIssues(next);
    if(errors.length){setMessage('轮廓存在交叉、重复或退化，请撤回节点修改后再闭合。');return;}
    commit(next);setSelected(id);setVertex(null);cancelDrawing();setMessage('区域已闭合，可拖动节点微调，或继续绘制下一块。');
  };
  const apply = () => {
    if(issues.length) { setMessage('请先修复轮廓问题，再试走。'); return; }
    if(!canStand(player,draft)) { setMessage('当前角色位置被草稿阻挡。请撤销该处修改，或恢复原图试走到空地后再编辑。'); return; }
    onApply(copy(draft)); setEditing(false); onEditing(false); onPlay();
  };
  const close = () => { cancelDrawing(); onApply(copy(original.current)); setOpen(false); onEditing(false); onPlay(); setMessage('已退出调试，恢复正式地图。草稿仍可继续编辑。'); };
  const finishDrag = (cancelled: boolean) => {
    const current=drag.current; if(!current)return;
    if(cancelled) setDraft(current.before);
    else if(JSON.stringify(current.before)!==JSON.stringify(draft)) { setUndo(s=>[...s.slice(-49),current.before]); setRedo([]); }
    drag.current=null;
  };
  const duplicate = () => {
    if(!active || !editing || drag.current)return;
    const next=copy(draft);
    let suffix=1;
    while(next.colliders.some(r=>r.id===`${active.id}-copy-${suffix}`))suffix++;
    const id=`${active.id}-copy-${suffix}`;
    const dx=Math.max(...active.points.map(p=>p.x))+24>2048?-24:24;
    const dy=Math.max(...active.points.map(p=>p.y))+24>1152?-24:24;
    next.colliders.push({...structuredClone(active),id,points:translateRegion(active.points,dx,dy)});
    commit(next);setSelected(id);setVertex(null);setMessage('已复制区域，可拖动整个色块定位。');
  };
  useEffect(()=>{
    if(!open || !editing)return;
    const keydown=(event: KeyboardEvent)=>{
      const target=event.target;
      if(target instanceof HTMLElement && (target.matches('input,textarea,select') || target.isContentEditable))return;
      if(drawing){
        if(['Escape','Enter','Backspace','Delete'].includes(event.key)){event.preventDefault();if(event.repeat)return;if(event.key==='Escape')cancelDrawing();else if(event.key==='Enter')closePath();else setPath(p=>p.slice(0,-1));}
        return;
      }
      if((event.key==='Delete' || event.key==='Backspace') && !event.metaKey && !event.ctrlKey && !event.altKey && active && !drag.current){
        event.preventDefault();if(event.repeat)return;const next=copy(draft);next.colliders=next.colliders.filter(r=>r.id!==selected);commit(next);setVertex(null);setMessage('已删除区域，可撤销恢复。');
      }
      if((event.metaKey||event.ctrlKey) && event.code==='KeyD' && !event.altKey){event.preventDefault();if(!event.repeat)duplicate();}
    };
    window.addEventListener('keydown',keydown);
    return ()=>window.removeEventListener('keydown',keydown);
  });
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
          if(d.index===null)region.points=translateRegion(region.points,p.x-d.start.x,p.y-d.start.y);
          else region.points[d.index]=p;
          setDraft(next);
        }}
        onDoubleClick={e=>{
          if(drawing || !editing || !showBlocks || drag.current)return;
          const p=point(e);let hit: {id:string;index:number;point:{x:number;y:number};distance:number}|null=null;
          for(const region of regions)region.points.forEach((a,i)=>{
            const b=region.points[(i+1)%region.points.length],dx=b.x-a.x,dy=b.y-a.y;
            const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));
            const projected={x:a.x+t*dx,y:a.y+t*dy},distance=Math.hypot(p.x-projected.x,p.y-projected.y);
            if(t>0.001 && t<0.999 && distance*fit.scale<=6 && (!hit || distance<hit.distance))hit={id:region.id,index:i,point:projected,distance};
          });
          const edge=hit as {id:string;index:number;point:{x:number;y:number};distance:number}|null;
          if(!edge)return;
          const next=copy(draft);next.colliders.find(r=>r.id===edge.id)!.points.splice(edge.index+1,0,edge.point);
          commit(next);setSelected(edge.id);setVertex(edge.index+1);
        }}
        onPointerUp={()=>finishDrag(false)} onPointerCancel={()=>finishDrag(true)} onLostPointerCapture={()=>finishDrag(false)}>
        {regions.map(region=>{
          if(!showBlocks)return null;
          const color='#ff7777';
          return <polygon key={region.id} points={region.points.map(p=>`${p.x},${p.y}`).join(' ')} fill={color} fillOpacity={region.id===selected?0.25:0.1} stroke={color} strokeWidth={region.id===selected?2:1} vectorEffect="non-scaling-stroke"
            onPointerDown={e=>{if(!editing || e.button!==0 || drag.current)return;e.stopPropagation();setSelected(region.id);setVertex(null);
              drag.current={id:region.id,index:null,start:point(e),before:copy(draft),pointer:e.pointerId};svgRef.current?.setPointerCapture(e.pointerId);
            }} style={{cursor:editing?'move':undefined}}
            />;
        })}
        {!drawing && editing && showBlocks && active?.points.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={(vertex===i?6:4)/fit.scale} fill={vertex===i?'#ffda70':'white'} stroke="#17212b" strokeWidth={1/fit.scale}
          onPointerDown={e=>{if(e.button!==0 || drag.current)return;e.stopPropagation();setVertex(i);drag.current={id:selected,index:i,start:point(e),before:copy(draft),pointer:e.pointerId};svgRef.current?.setPointerCapture(e.pointerId);}} />)}
        {drawing && <g pointerEvents="none">
          <polyline points={[...path,...(cursor?[cursor]:[])].map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke="#ffda70" strokeWidth={2/fit.scale}/>
          {path.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={(i===0?7:4)/fit.scale} fill={i===0?'#62dca0':'#ffda70'} stroke="#17212b" strokeWidth={1/fit.scale}/>)}
          {path.length>=3 && cursor && Math.hypot(cursor.x-path[0].x,cursor.y-path[0].y)*fit.scale<=10 && <text x={path[0].x+12/fit.scale} y={path[0].y-12/fit.scale} fill="white" stroke="#17212b" strokeWidth={2/fit.scale} paintOrder="stroke" fontSize={12/fit.scale}>点击闭合</text>}
        </g>}
        <circle cx={player.x} cy={player.y} r={8} fill="none" stroke="#ffe06b" strokeWidth={2/fit.scale}/>
        <circle cx={player.x} cy={player.y} r={2/fit.scale} fill="#ffe06b"/>
      </svg>
      {panelHidden && <button className={styles.launch} aria-label="显示调试工具" title="显示调试工具" onClick={()=>setPanelHidden(false)}><PanelLeftOpen size={16} aria-hidden="true" /></button>}
      <section className={styles.panel} aria-label="场景调试工具" hidden={panelHidden}>
        <div className={styles.row}><strong>初遇庭院 · {editing?'编辑':'试走'}</strong><button onClick={close}>退出调试</button><button className={styles.hideButton} aria-label="隐藏调试工具" title="隐藏调试工具" onClick={()=>setPanelHidden(true)}><PanelLeftClose size={16} aria-hidden="true" /></button></div>
        <div className={styles.row}>{!editing && <button onClick={()=>{setEditing(true);onEditing(true);}}>返回编辑</button>}<button className={styles.primary} disabled={!editing||drawing} onClick={apply}>应用并试走</button></div>
        <div className={styles.row}>
          <button disabled={!editing||drawing} onClick={()=>{setDrawing(true);setPath([]);setCursor(null);setVertex(null);setShowBlocks(true);setMessage('请在地图上点击第一个点。');}}>开始画区域</button>
          {drawing && <><button disabled={path.length<3} onClick={closePath}>闭合路径</button><button onClick={()=>setPath(p=>p.slice(0,-1))} disabled={!path.length}>撤回一点</button><button onClick={cancelDrawing}>取消绘制</button></>}
        </div>
        <fieldset disabled={drawing} className={styles.editFields}>
        <div className={styles.row}>
          <button disabled={!editing||!undo.length} onClick={()=>{setRedo(s=>[...s,copy(draft)]);setDraft(undo[undo.length-1]);setUndo(s=>s.slice(0,-1));setVertex(null);}}>撤销</button>
          <button disabled={!editing||!redo.length} onClick={()=>{setUndo(s=>[...s,copy(draft)]);setDraft(redo[redo.length-1]);setRedo(s=>s.slice(0,-1));setVertex(null);}}>重做</button>
        </div>
        <div className={styles.row}>
          <button disabled={!!issues.length} onClick={()=>{try{localStorage.setItem(key,JSON.stringify(draft));setMessage('草稿已保存在当前浏览器。');}catch{setMessage('保存失败，可导出 JSON 备份。');}}}>保存草稿</button>
          <button disabled={!!issues.length} onClick={()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(draft,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`${navigation.mapId}-navigation.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>导出 JSON</button>
        </div>
        <details className={styles.more}><summary>更多工具</summary>
<div className={styles.row}><label><input type="checkbox" checked={showBlocks} onChange={e=>setShowBlocks(e.target.checked)}/>碰撞区</label></div>
        <select aria-label="选择地图区域" value={selected} disabled={!editing} onChange={e=>{setSelected(e.target.value);setVertex(null);}}>{regions.map(r=><option key={r.id} value={r.id}>碰撞 · {r.id}</option>)}</select>
        <p>地图边界内除碰撞区外均可走。拖色块整体移动，拖白点改形状；双击边框增加节点。Delete 删除区域，⌘D / Ctrl+D 复制；均可撤销。</p>
        <div className={styles.row}>
          <button disabled={!editing} onClick={()=>{
            const next=copy(draft);const id=`prop-${Date.now()}`;
            const x=Math.max(0,Math.min(1988,player.x+40)),y=Math.max(0,Math.min(1092,player.y));
            next.colliders.push({id,kind:'prop',points:[{x,y},{x:x+60,y},{x:x+60,y:y+60},{x,y:y+60}]});commit(next);setSelected(id);setVertex(null);
          }}>新增碰撞区</button>
          <button disabled={!editing||!active} onClick={duplicate}>复制区域</button>
        </div>
          <button disabled={!editing||vertex===null||!active||active.points.length<=3} onClick={()=>{const next=copy(draft);updatePoints(next).points.splice(vertex!,1);commit(next);setVertex(null);}}>删除节点</button>
          <button disabled={!editing} onClick={()=>{commit(collisionOnlyDraft(original.current));setVertex(null);}}>恢复原图</button>
          <button disabled={!editing} onClick={()=>{try{const n=PikoNavigationSchema.parse(JSON.parse(localStorage.getItem(key)??'null'));if(n.mapId!==navigation.mapId||navigationIssues(n).length)throw Error();commit(collisionOnlyDraft(n));setSelected(n.colliders[0]?.id??n.walkableAreas[0]?.id??'');setVertex(null);setMessage('已载入草稿，点击应用并试走验证。');}catch{setMessage('没有可用草稿，或草稿数据无效。');}}}>载入草稿</button>
        </details>
        </fieldset>
        {!drawing && <p>点击「开始画区域」，再到地图上逐点点击，最后点起点闭合。</p>}
        {drawing && <p>绘制中：{path.length} 个节点 · Delete 撤回一点 · Esc 取消</p>}
        <p role="status">{issues[0]??message}</p>
      </section>
    </>}
  </>;
}
