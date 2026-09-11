import {registerFreezoneCanvasRuntime} from '@/features/freezone/canvasSyncRuntime';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {useCanvasStore} from '@/stores/canvasStore';
import {applyCanvasChatCommandsAsync,extractCanvasChatCommandEnvelopes,partitionCanvasChatCommandEnvelopes} from '@/features/freezone/canvasChatCommands';
import * as api from './api';
import {parseHtmlArtifactCommand} from './commands';
import {subscribeNodeAction,publishNodeActionAccepted,publishNodeActionSuccess} from '@/features/canvas/application/nodeActionResult';
import {executeWorkflowHtmlNode} from '@/features/canvas/application/workflowHtmlRuntime';
vi.mock('@/features/canvas/application/workflowHtmlRuntime',()=>({executeWorkflowHtmlNode:vi.fn()}));
vi.mock('@/api/tasks',()=>({getProjectTaskLimits:vi.fn(async()=>({}))}));
vi.mock('@/api/canvas',async(importOriginal)=>({...await importOriginal<typeof import('@/api/canvas')>(),createFreezoneWorkflowRun:vi.fn(async()=>({run_id:'run-html',actions:[]})),updateFreezoneWorkflowRun:vi.fn(async()=>({run_id:'run-html'}))}));
vi.mock('./api',()=>({createHtmlArtifact:vi.fn(),saveHtmlArtifact:vi.fn(),restoreHtmlVersion:vi.fn(),readHtmlArtifact:vi.fn(),announceHtmlArtifact:vi.fn(),recordHtmlNodeHistory:vi.fn()}));
const artifact = {id:'a1',title:'Hello',html:'<h1>Hello</h1>',version:1,created_at:'now',updated_at:'now'};
const envelope=(command:unknown)=>({schema_version:'canvas_chat_commands.v1',project_id:'p',canvas_id:'c',commands:[command]});
describe('director HTML commands',()=>{
 beforeEach(()=>{vi.clearAllMocks();vi.mocked(api.recordHtmlNodeHistory).mockResolvedValue(artifact);registerFreezoneCanvasRuntime("p","c",()=>{});useCanvasStore.setState({nodes:[],edges:[]});});
 it('preserves create aliases and rejects aliases on version writes',()=>{
  expect(parseHtmlArtifactCommand({type:'html_artifact',action:'create',client_id:'page',title:'Hello',html:'hello'})).toMatchObject({client_id:'page'});
  expect(parseHtmlArtifactCommand({type:'html_artifact',action:'create',client_id:' ',title:'Hello',html:'hello'})).toBeNull();
  expect(parseHtmlArtifactCommand({type:'html_artifact',action:'update',client_id:'page',artifact_id:'a1',base_version:1,title:'Hello',html:'hello'})).toBeNull();
 });
 it('runs HTML in batch order with reference, move, connection and group aliases',async()=>{
  vi.mocked(api.createHtmlArtifact).mockResolvedValue(artifact);
  const envelopes=extractCanvasChatCommandEnvelopes([{...envelope(null),commands:[
   {type:'create_node',node_type:'imageGenNode',client_id:'picture'},
   {type:'html_artifact',action:'create',client_id:'page',title:'Hello',html:'hello',reference_node_ids:['picture']},
   {type:'move_nodes',positions:{page:{x:700,y:400}}},
   {type:'create_edge',source:'picture',target:'page',link_type:'media_input_for'},
   {type:'group_nodes',node_ids:['picture','page'],label:'Page assets'},
  ]}]);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(result.errors).toEqual([]);
  expect(result.commandResults.map(receipt=>receipt.type)).toEqual(['create_node','html_artifact','move_nodes','create_edge','group_nodes']);
  const page=useCanvasStore.getState().nodes.find(node=>node.type==='htmlArtifactNode')!;
  expect(page.parentId).toBeTruthy();
  expect(useCanvasStore.getState().edges.some(edge=>edge.target===page.id)).toBe(true);
  expect(api.createHtmlArtifact).toHaveBeenCalledTimes(1);
 });
 it('keeps saved identity and continues without retrying create when history recording fails',async()=>{
  vi.mocked(api.createHtmlArtifact).mockResolvedValue(artifact);
  vi.mocked(api.recordHtmlNodeHistory).mockRejectedValue(new Error('history unavailable'));
  const envelopes=extractCanvasChatCommandEnvelopes([{...envelope(null),commands:[
   {type:'html_artifact',action:'create',client_id:'page',title:'Hello',html:'hello'},
   {type:'move_nodes',positions:{page:{x:700,y:400}}},
  ]}]);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(result.commandResults.map(receipt=>receipt.status)).toEqual(['success','success']);
  expect(result.commandResults[0].output).toMatchObject({html_artifact:{id:'a1'}});
  expect(useCanvasStore.getState().nodes[0].position).toEqual({x:700,y:400});
  expect(api.createHtmlArtifact).toHaveBeenCalledTimes(1);
 });
 it('reports dependent failures after a save rejection and still executes independent commands',async()=>{
  vi.mocked(api.createHtmlArtifact).mockRejectedValue(new Error('save unavailable'));
  const envelopes=extractCanvasChatCommandEnvelopes([{...envelope(null),commands:[
   {type:'html_artifact',action:'create',client_id:'page',title:'Hello',html:'hello'},
   {type:'move_nodes',positions:{page:{x:700,y:400}}},
   {type:'create_node',node_type:'imageGenNode',client_id:'picture'},
  ]}]);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(result.commandResults.map(receipt=>receipt.status)).toEqual(['error','error','success']);
  expect(result.commandResults[0].error).toContain('save unavailable');
  expect(api.createHtmlArtifact).toHaveBeenCalledTimes(1);
 });
 it('retains saved artifact identity if canvas attachment throws',async()=>{
  vi.mocked(api.createHtmlArtifact).mockResolvedValue(artifact);
  const addNode=vi.spyOn(useCanvasStore.getState(),'addNode').mockImplementationOnce(()=>{throw new Error('attachment unavailable');});
  try {
   const envelopes=extractCanvasChatCommandEnvelopes([envelope({type:'html_artifact',action:'create',client_id:'page',title:'Hello',html:'hello'})]);
   const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
   expect(result.commandResults[0]).toMatchObject({status:'success',output:{html_artifact:{id:'a1'},canvas_attached:false}});
   expect(result.errors.join()).toContain('do not create a duplicate');
   expect(api.createHtmlArtifact).toHaveBeenCalledTimes(1);
  } finally {addNode.mockRestore();}
 });
 it('prepares an aliased workflow placeholder without persisting invented HTML',async()=>{
  const prepare={type:'html_artifact',action:'prepare',client_id:'page',workflow_data:{workflowCatalog:{recipeId:'test'},workflowInstanceId:'wf1',workflowPlanNodeId:'page',prompt:'Build page'}};
  const envelopes=extractCanvasChatCommandEnvelopes([{...envelope(null),commands:[prepare,{type:'move_nodes',positions:{page:{x:50,y:60}}}]}]);
  expect(envelopes[0].commands).toHaveLength(2);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(result.errors).toEqual([]);
  expect(useCanvasStore.getState().nodes[0]).toMatchObject({type:'htmlArtifactNode',position:{x:50,y:60},data:{prompt:'Build page',workflowPlanNodeId:'page'}});
  expect(useCanvasStore.getState().nodes[0].data.artifactId).toBeFalsy();
  expect(api.createHtmlArtifact).not.toHaveBeenCalled();
  expect(parseHtmlArtifactCommand({...prepare,workflow_data:{...prepare.workflow_data,artifactId:'invented'}})).toBeNull();
  expect(parseHtmlArtifactCommand({...prepare,html:'invented'})).toBeNull();
 });
 it('executes HTML generation without a mounted UI handler and returns saved identity',async()=>{
  const id=useCanvasStore.getState().addNode('htmlArtifactNode',{x:0,y:0},{prompt:'Build page',workflowCatalog:{recipeId:'test'}});
  vi.mocked(executeWorkflowHtmlNode).mockImplementation(async(nodeId)=>{
   useCanvasStore.getState().updateNodeData(nodeId,{artifactId:'a1',artifactVersion:1});
   return {nodeId,artifact_id:'a1',version:1,html_artifact:{id:'a1',title:'Hello',version:1}};
  });
  const envelopes=extractCanvasChatCommandEnvelopes([envelope({type:'run_node_action',node_id:id,action:'generate_html'})]);
  expect(envelopes).toHaveLength(1);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c',actionAcceptTimeoutMs:10,actionTimeoutMs:100});
  expect(result.errors).toEqual([]);
  expect(executeWorkflowHtmlNode).toHaveBeenCalledWith(id,'p','c');
  expect(result.commandResults.find(receipt=>receipt.action==='generate_html')?.output).toMatchObject({html_artifact:{id:'a1',version:1}});
 });
 it('saves source through a generic node action without creating a duplicate node',async()=>{
  const id=useCanvasStore.getState().addNode('htmlArtifactNode',{x:0,y:0},{displayName:'Landing page'});
  vi.mocked(api.createHtmlArtifact).mockResolvedValue(artifact);
  const envelopes=extractCanvasChatCommandEnvelopes([envelope({
   type:'run_node_action',node_id:id,action:'update_source',parameters:{html:artifact.html,title:'Hello'},
  })]);
  expect(envelopes).toHaveLength(1);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(result.errors).toEqual([]);
  expect(useCanvasStore.getState().nodes).toHaveLength(1);
  expect(useCanvasStore.getState().nodes[0]).toMatchObject({id,data:{artifactId:'a1',artifactVersion:1}});
  expect(result.commandResults[0]).toMatchObject({action:'update_source',status:'success',label:'保存网页源码',nodeId:id,output:{html_artifact:{id:'a1',version:1}}});
 });
 it('does not accept source or artifact identity through generic node creation data',async()=>{
  const envelopes=extractCanvasChatCommandEnvelopes([envelope({
   type:'create_node',node_type:'htmlArtifactNode',data:{displayName:'Page',prompt:'Build it',html:'invented',artifactId:'foreign',artifactVersion:99},
  })]);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(result.errors).toEqual([]);
  expect(useCanvasStore.getState().nodes[0].data).toMatchObject({displayName:'Page',prompt:'Build it'});
  expect(useCanvasStore.getState().nodes[0].data).not.toHaveProperty('html');
  expect(useCanvasStore.getState().nodes[0].data.artifactId).toBe('');
  expect(useCanvasStore.getState().nodes[0].data.artifactVersion).toBe(0);
 });
 it('updates and restores HTML through generic node actions',async()=>{
  const id=useCanvasStore.getState().addNode('htmlArtifactNode',{x:0,y:0},{artifactId:'a1',artifactVersion:4,displayName:'Hello'});
  vi.mocked(api.saveHtmlArtifact).mockResolvedValue({...artifact,version:5,title:'Updated'});
  vi.mocked(api.restoreHtmlVersion).mockResolvedValue({...artifact,version:6,title:'Restored'});
  const envelopes=extractCanvasChatCommandEnvelopes([{...envelope(null),commands:[
   {type:'run_node_action',node_id:id,action:'update_source',parameters:{html:'<h1>Updated</h1>',title:'Updated',base_version:4}},
   {type:'run_node_action',node_id:id,action:'restore',parameters:{version:2,base_version:5}},
  ]}]);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(result.errors).toEqual([]);
  expect(api.saveHtmlArtifact).toHaveBeenCalledWith('p','a1','Updated','<h1>Updated</h1>',4);
  expect(api.restoreHtmlVersion).toHaveBeenCalledWith('p','a1',2,5);
  expect(useCanvasStore.getState().nodes[0].data.artifactVersion).toBe(6);
  expect(result.commandResults.map(receipt=>receipt.action)).toEqual(['update_source','restore']);
 });
 it('selects an existing HTML version without creating a new revision',async()=>{
  const id=useCanvasStore.getState().addNode('htmlArtifactNode',{x:0,y:0},{artifactId:'a1',artifactVersion:4,displayName:'Current'});
  vi.mocked(api.readHtmlArtifact).mockResolvedValue({...artifact,version:2,title:'Earlier'});
  const envelopes=extractCanvasChatCommandEnvelopes([envelope({
   type:'run_node_action',node_id:id,action:'select_version',parameters:{version:2},
  })]);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(result.errors).toEqual([]);
  expect(api.readHtmlArtifact).toHaveBeenCalledWith('p','a1',2);
  expect(api.saveHtmlArtifact).not.toHaveBeenCalled();
  expect(api.restoreHtmlVersion).not.toHaveBeenCalled();
  expect(useCanvasStore.getState().nodes[0].data.artifactVersion).toBe(2);
  expect(result.commandResults[0]).toMatchObject({action:'select_version',label:'选择网页版本',output:{artifact_id:'a1',selected_version:2}});
 });
 it('waits for upstream image completion before running the prepared HTML workflow step',async()=>{
  const imageId=useCanvasStore.getState().addNode('imageGenNode',{x:0,y:0},{prompt:'Create image'});
  let finishImage: (()=>void)|undefined;
  const unsubscribe=subscribeNodeAction(payload=>{
   if(payload.action!=='generate_image') return;
   publishNodeActionAccepted(payload.requestId,payload.nodeId,payload.action);
   finishImage=()=>{
    useCanvasStore.getState().updateNodeData(imageId,{imageUrl:'https://example.com/generated.png'});
    publishNodeActionSuccess(payload.requestId,payload.nodeId,payload.action,{imageUrl:'https://example.com/generated.png'});
   };
  });
  vi.mocked(executeWorkflowHtmlNode).mockImplementation(async(nodeId)=>{
   expect(useCanvasStore.getState().nodes.find(node=>node.id===imageId)?.data.imageUrl).toBe('https://example.com/generated.png');
   useCanvasStore.getState().updateNodeData(nodeId,{artifactId:'a1',artifactVersion:1});
   return {nodeId,artifact_id:'a1',version:1,html_artifact:{id:'a1',title:'Hello',version:1}};
  });
  try {
   const envelopes=extractCanvasChatCommandEnvelopes([{...envelope(null),commands:[
    {type:'html_artifact',action:'prepare',client_id:'page',workflow_data:{workflowCatalog:{recipeId:'test'},workflowInstanceId:'wf1',workflowPlanNodeId:'page',prompt:'Build page'}},
    {type:'create_edge',source:imageId,target:'page',link_type:'media_input_for'},
    {type:'run_workflow',node_ids:[imageId,'page']},
   ]}]);
   const pending=applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c',actionTimeoutMs:2000});
   await vi.waitFor(()=>expect(finishImage).toBeTypeOf('function'));
   expect(executeWorkflowHtmlNode).not.toHaveBeenCalled();
   finishImage!();
   const result=await pending;
   expect(result.errors).toEqual([]);
   expect(executeWorkflowHtmlNode).toHaveBeenCalledTimes(1);
  } finally {unsubscribe();}
 });
 it('recovers missing HTML preparation when the same workflow media node already exists',async()=>{
  useCanvasStore.getState().addNode('imageGenNode',{x:0,y:0},{workflowInstanceId:'wf1',workflowPlanNodeId:'image'});
  const envelopes=extractCanvasChatCommandEnvelopes([{...envelope(null),commands:[
   {type:'create_node',node_type:'imageGenNode',client_id:'image',data:{workflowInstanceId:'wf1',workflowPlanNodeId:'image'}},
   {type:'html_artifact',action:'prepare',client_id:'page',workflow_data:{workflowCatalog:{recipeId:'html'},workflowInstanceId:'wf1',workflowPlanNodeId:'page',prompt:'Build page'}},
  ]}]);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(result.errors).toEqual([]);
  expect(useCanvasStore.getState().nodes.filter(node=>node.type==='htmlArtifactNode')).toHaveLength(1);
  expect(useCanvasStore.getState().nodes.filter(node=>node.type==='imageGenNode')).toHaveLength(1);
 });
 it('requires approval and creates artifact and node only on execution',async()=>{
  const envelopes=extractCanvasChatCommandEnvelopes([envelope({type:'html_artifact',action:'create',title:'Hello',html:artifact.html})]);
  expect(envelopes).toHaveLength(1);
  expect(partitionCanvasChatCommandEnvelopes(envelopes).requiresApproval).toHaveLength(1);
  expect(api.createHtmlArtifact).not.toHaveBeenCalled();
  vi.mocked(api.createHtmlArtifact).mockResolvedValue(artifact);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(result.errors).toEqual([]);
  expect(useCanvasStore.getState().nodes[0].data).toMatchObject({artifactId:'a1',artifactVersion:1});
  expect(api.recordHtmlNodeHistory).toHaveBeenCalledWith('p','a1',1,{canvas_id:'c',node_id:useCanvasStore.getState().nodes[0].id});
  expect(result.commandResults[0].output).toMatchObject({project_id:'p',html_artifact:{id:'a1',version:1}});
 });
 it('updates the same node and leaves it intact on a stale write',async()=>{
  const id=useCanvasStore.getState().addNode('htmlArtifactNode',{x:0,y:0},{artifactId:'a1',artifactVersion:1,displayName:'Hello'});
  const envelopes=extractCanvasChatCommandEnvelopes([envelope({type:'html_artifact',action:'update',artifact_id:'a1',base_version:1,title:'New',html:'new'})]);
  vi.mocked(api.saveHtmlArtifact).mockRejectedValue(new Error('stale base_version'));
  const failed=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(failed.errors.join()).toContain('stale');
  expect(useCanvasStore.getState().nodes[0].data.artifactVersion).toBe(1);
  vi.mocked(api.saveHtmlArtifact).mockResolvedValue({...artifact,version:2,title:'New'});
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(result.errors).toEqual([]);
  expect(useCanvasStore.getState().nodes).toHaveLength(1);
  expect(useCanvasStore.getState().nodes[0]).toMatchObject({id,data:{artifactVersion:2}});
 });
 it('does not attach a saved artifact to another canvas after switching',async()=>{
  const envelopes=extractCanvasChatCommandEnvelopes([envelope({type:'html_artifact',action:'create',title:'Hello',html:'hello'})]);
  vi.mocked(api.createHtmlArtifact).mockImplementation(async()=>{registerFreezoneCanvasRuntime('other','new',()=>{});return artifact;});
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(useCanvasStore.getState().nodes).toHaveLength(0);
  expect(result.commandResults[0].output).toMatchObject({html_artifact:{id:'a1'},canvas_attached:false});
  expect(result.errors.join()).toContain('canvas');
 });
 it('restores a historical version into the same node',async()=>{
  const id=useCanvasStore.getState().addNode('htmlArtifactNode',{x:0,y:0},{artifactId:'a1',artifactVersion:4});
  const envelopes=extractCanvasChatCommandEnvelopes([envelope({type:'html_artifact',action:'restore',artifact_id:'a1',version:1,base_version:4})]);
  vi.mocked(api.restoreHtmlVersion).mockResolvedValue({...artifact,version:5});
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(api.restoreHtmlVersion).toHaveBeenCalledWith('p','a1',1,4);
  expect(result.errors).toEqual([]);
  expect(useCanvasStore.getState().nodes[0]).toMatchObject({id,data:{artifactVersion:5}});
 });
 it('creates requested reference edges and rejects missing sources before saving',async()=>{
  const id=useCanvasStore.getState().addNode('imageGenNode',{x:0,y:0},{});
  vi.mocked(api.createHtmlArtifact).mockResolvedValue(artifact);
  const envelopes=extractCanvasChatCommandEnvelopes([envelope({type:'html_artifact',action:'create',title:'Hello',html:'hello',reference_node_ids:[id]})]);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'p',canvasId:'c'});
  expect(result.errors).toEqual([]);
  expect(useCanvasStore.getState().edges).toHaveLength(1);
  const missing=extractCanvasChatCommandEnvelopes([envelope({type:'html_artifact',action:'create',title:'Hello',html:'hello',reference_node_ids:['missing']})]);
  const failed=await applyCanvasChatCommandsAsync(missing,{projectId:'p',canvasId:'c'});
  expect(failed.errors.join()).toContain('missing');
  expect(api.createHtmlArtifact).toHaveBeenCalledTimes(1);
 });
 it('rejects cross-project commands before network writes',async()=>{
  const envelopes=extractCanvasChatCommandEnvelopes([envelope({type:'html_artifact',action:'create',title:'Hello',html:'hello'})]);
  const result=await applyCanvasChatCommandsAsync(envelopes,{projectId:'other',canvasId:'c'});
  expect(result.errors.length).toBeGreaterThan(0);
  expect(api.createHtmlArtifact).not.toHaveBeenCalled();
 });
});
