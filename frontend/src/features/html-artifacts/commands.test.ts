import {registerFreezoneCanvasRuntime} from '@/features/freezone/canvasSyncRuntime';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {useCanvasStore} from '@/stores/canvasStore';
import {applyCanvasChatCommandsAsync,extractCanvasChatCommandEnvelopes,partitionCanvasChatCommandEnvelopes} from '@/features/freezone/canvasChatCommands';
import * as api from './api';
vi.mock('./api',()=>({createHtmlArtifact:vi.fn(),saveHtmlArtifact:vi.fn(),restoreHtmlVersion:vi.fn(),announceHtmlArtifact:vi.fn(),recordHtmlNodeHistory:vi.fn()}));
const artifact = {id:'a1',title:'Hello',html:'<h1>Hello</h1>',version:1,created_at:'now',updated_at:'now'};
const envelope=(command:unknown)=>({schema_version:'canvas_chat_commands.v1',project_id:'p',canvas_id:'c',commands:[command]});
describe('director HTML commands',()=>{
 beforeEach(()=>{vi.clearAllMocks();vi.mocked(api.recordHtmlNodeHistory).mockResolvedValue(artifact);registerFreezoneCanvasRuntime("p","c",()=>{});useCanvasStore.setState({nodes:[],edges:[]});});
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
