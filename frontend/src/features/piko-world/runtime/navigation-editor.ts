import type { PikoNavigation } from './map-package-schema';

export function navigationIssues(nav: PikoNavigation, width = 2048, height = 1152): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const region of [...nav.walkableAreas, ...nav.colliders]) {
    if (ids.has(region.id)) issues.push(`${region.id}：名称重复`);
    ids.add(region.id);
    const p = region.points;
    if (p.some(v => !Number.isFinite(v.x) || !Number.isFinite(v.y) || v.x < 0 || v.y < 0 || v.x > width || v.y > height)) issues.push(`${region.id}：节点超出地图`);
    const cross = (a: typeof p[number], b: typeof p[number], c: typeof p[number]) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    const on = (a: typeof p[number], b: typeof p[number], c: typeof p[number]) => cross(a,b,c) === 0 && c.x >= Math.min(a.x,b.x) && c.x <= Math.max(a.x,b.x) && c.y >= Math.min(a.y,b.y) && c.y <= Math.max(a.y,b.y);
    let invalid = false;
    let area = 0;
    for (let i=0;i<p.length;i++) {
      const a=p[i], b=p[(i+1)%p.length];
      area += a.x*b.y-b.x*a.y;
      if(a.x===b.x && a.y===b.y) invalid=true;
      for(let j=i+1;j<p.length;j++) {
        if(j===i+1 || (i===0 && j===p.length-1)) continue;
        const c=p[j], d=p[(j+1)%p.length];
        if ((cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0) || on(a,b,c) || on(a,b,d) || on(c,d,a) || on(c,d,b)) invalid=true;
      }
    }
    if(invalid || Math.abs(area)<1) issues.push(`${region.id}：轮廓自交、重叠或面积为零`);
  }
  return issues;
}

/** Keep the runtime navigation format while editing only obstacles. */
export function collisionOnlyDraft(nav: PikoNavigation): PikoNavigation {
  const result = structuredClone(nav);
  result.walkableAreas = [{ id: 'map-ground', points: [{x:0,y:0},{x:2048,y:0},{x:2048,y:1152},{x:0,y:1152}] }];
  return result;
}

export function translateRegion(points: {x:number;y:number}[], dx: number, dy: number) {
  const x = Math.max(-Math.min(...points.map(p=>p.x)), Math.min(2048-Math.max(...points.map(p=>p.x)), dx));
  const y = Math.max(-Math.min(...points.map(p=>p.y)), Math.min(1152-Math.max(...points.map(p=>p.y)), dy));
  return points.map(p=>({x:p.x+x,y:p.y+y}));
}
