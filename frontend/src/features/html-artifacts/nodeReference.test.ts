import {expect,it} from 'vitest';
import type {CanvasNode} from '@/features/canvas/domain/canvasNodes';
import {buildCanvasNodeReferenceAttachment,buildCanvasNodeReferenceContext,buildCanvasContextRequestResponses,extractCanvasContextRequestEnvelopes} from '@/features/freezone/chatNodeReferences';
const node:CanvasNode={id:'page-node',type:'htmlArtifactNode',position:{x:0,y:0},data:{artifactId:'artifact-123',artifactVersion:7,displayName:'Campaign'}};
it('carries saved identity through selected-node attachments and director text context',()=>{
 const attachment=buildCanvasNodeReferenceAttachment('p','c',[node])!;
 const payload=JSON.parse(attachment.content!);
 expect(payload.nodes[0].html_artifact).toEqual({id:'artifact-123',version:7});
 expect(payload.display_nodes[0].html_artifact).toEqual({id:'artifact-123',version:7});
 const context=buildCanvasNodeReferenceContext([attachment]);
 expect(context).toContain('html_artifact_json: {"id":"artifact-123","version":7}');
 expect(payload.nodes[0].action_catalog.editable_schema).not.toHaveProperty('artifactId');
 expect(payload.nodes[0].action_catalog.editable_schema).not.toHaveProperty('artifactVersion');
});
it('carries read-only identity through compact node-detail without editable parameters',async()=>{
 const responses=await buildCanvasContextRequestResponses({project:'p',canvasId:'c',nodes:[node],edges:[],ontologyContext:null,envelopes:extractCanvasContextRequestEnvelopes([{schema_version:'canvas_context_request.v1',requests:[{type:'node_detail',node_id:node.id}]}])});
 const detail=(responses![0].data as {nodes:Array<Record<string,unknown>>}).nodes[0];
 expect(detail.html_artifact).toEqual({id:'artifact-123',version:7});
 expect(detail.parameters ?? {}).not.toHaveProperty('artifactId');
 expect(detail.parameters ?? {}).not.toHaveProperty('artifactVersion');
});
it('does not invent identity for unsaved or unrelated nodes',()=>{
 const attachment=buildCanvasNodeReferenceAttachment('p','c',[{...node,data:{artifactId:'',artifactVersion:0}},{...node,id:'text',type:'textAnnotationNode'}])!;
 const payload=JSON.parse(attachment.content!);
 expect(payload.nodes.every((item:Record<string,unknown>)=>!item.html_artifact)).toBe(true);
});
