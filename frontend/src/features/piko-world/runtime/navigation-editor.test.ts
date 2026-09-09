import { describe, expect, it } from 'vitest';
import { navigationIssues } from './navigation-editor';
import type { PikoNavigation } from './map-package-schema';
const nav = (points: {x:number;y:number}[]): PikoNavigation => ({schemaVersion:1,mapId:'welcome-courtyard',walkableAreas:[{id:'ground',points}],colliders:[],spawnPoints:[],exits:[]});
describe('navigation draft validation',()=>{
  it('accepts a valid concave region',()=>expect(navigationIssues(nav([{x:0,y:0},{x:100,y:0},{x:50,y:50},{x:100,y:100},{x:0,y:100}]))).toEqual([]));
  it('rejects self intersections',()=>expect(navigationIssues(nav([{x:0,y:0},{x:100,y:100},{x:0,y:100},{x:100,y:0}]))).not.toEqual([]));
  it('rejects nonadjacent touching edges',()=>expect(navigationIssues(nav([{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:50,y:0},{x:0,y:100}]))).not.toEqual([]));
  it('rejects duplicate IDs and out of bounds points',()=>{const n=nav([{x:-1,y:0},{x:100,y:0},{x:0,y:100}]);n.colliders=[{...n.walkableAreas[0],kind:'prop'}];expect(navigationIssues(n)).toHaveLength(3);});
});

import { collisionOnlyDraft, translateRegion } from './navigation-editor';
it('opens the whole map in collision-only drafts without mutating the source',()=>{
 const n=nav([{x:10,y:10},{x:20,y:10},{x:10,y:20}]);
 expect(collisionOnlyDraft(n).walkableAreas[0].points[2]).toEqual({x:2048,y:1152});
 expect(n.walkableAreas[0].points[0]).toEqual({x:10,y:10});
});
it('clamps translation as a whole, preserving the shape at the edge',()=>{
 const points=[{x:2000,y:1100},{x:2040,y:1100},{x:2040,y:1140}];
 expect(translateRegion(points,24,24)).toEqual([{x:2008,y:1112},{x:2048,y:1112},{x:2048,y:1152}]);
});
