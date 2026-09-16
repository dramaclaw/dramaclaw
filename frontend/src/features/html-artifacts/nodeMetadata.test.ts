import {expect,it} from 'vitest';
import {htmlArtifactNodePatches} from './nodeMetadata';
it('refreshes every reference to the saved artifact without touching unrelated nodes',()=>{
 const nodes=[{id:'a',type:'htmlArtifactNode',data:{artifactId:'one'}},{id:'b',type:'htmlArtifactNode',data:{artifactId:'two'}},{id:'c',type:'htmlArtifactNode',data:{artifactId:'one'}}];
 expect(htmlArtifactNodePatches(nodes,{id:'one',version:3,title:'New title'})).toEqual([{id:'a',data:{artifactId:'one',artifactVersion:3,displayName:'New title'}},{id:'c',data:{artifactId:'one',artifactVersion:3,displayName:'New title'}}]);
});
