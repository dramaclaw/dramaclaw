import {act, fireEvent, render, screen, cleanup} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {HtmlArtifactNode} from './HtmlArtifactNode';
import {BillingRuleNotConfiguredError} from '@/lib/api-errors';
const billing = vi.hoisted(() => ({quote:vi.fn(), access:vi.fn()}));
const history = vi.hoisted(() => ({records:[] as any[], refresh:vi.fn()}));
vi.mock('@/lib/queries/generation-credit-cost',()=>({useGenerationCreditCost:billing.quote}));
vi.mock('@/lib/model-task-access',()=>({useModelTaskAccess:billing.access}));
vi.mock('@/components/credit-cost-inline',()=>({CreditCostInline:({display}:any)=><span>{display}</span>}));
vi.mock('@/features/canvas/hooks/useNodeGenerationHistory',()=>({useNodeGenerationHistory:()=>({records:history.records,isLoading:false,refresh:history.refresh})}));
vi.mock('@/features/canvas/ui/NodeGenerationHistory',()=>({
 hasCompletedHistoryRecords:(records:any[])=>records.length>0,
 historyRecordHtmlIdentity:(record:any)=>record.media_type==='html'&&record.result?.artifact_id&&record.result?.version?{artifactId:record.result.artifact_id,version:record.result.version}:null,
 NodeGenerationHistory:({records,onRestore}:any)=><button aria-label="html-history" onClick={()=>onRestore(records[0])}>history</button>,
}));
beforeEach(()=>{
 billing.quote.mockReturnValue({data:{data:{display:'6'}},error:null});
 billing.access.mockReturnValue({blocked:false,message:null});
});
const mocks = vi.hoisted(() => ({run:vi.fn(), create:vi.fn(), attach:vi.fn(), update:vi.fn(), open:vi.fn(), export:vi.fn(), accepted:vi.fn(), success:vi.fn(), error:vi.fn(), handler:undefined as any}));
vi.mock('@/features/canvas/application/useUpstreamGraph',()=>({useUpstreamNodes:()=>[{id:'copy',type:'textAnnotationNode',data:{displayName:'Coffee copy',content:'Coffee'}}]}));
vi.mock('@xyflow/react',()=>({Handle:({id,type}:any)=><span data-testid={`handle-${type}`} data-handle-id={id}/>,Position:{Left:'left',Right:'right'}}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('@/features/freezone/canvasSyncRuntime',()=>({captureFreezoneCanvasScope:()=>()=>true}));
vi.mock('@/lib/url-params',()=>({readUrl:()=>({project:'p',canvas:'c'})}));
vi.mock('@/stores/canvasStore',()=>({useCanvasStore:{getState:()=>({updateNodeData:mocks.update})}}));
vi.mock('@/features/canvas/application/workflowHtmlRuntime',()=>({executeWorkflowHtmlNode:mocks.run,attachSavedArtifact:mocks.attach}));
vi.mock('@/features/canvas/application/nodeActionResult',()=>({subscribeNodeAction:(handler:any)=>{mocks.handler=handler;return ()=>{};},publishNodeActionAccepted:mocks.accepted,publishNodeActionSuccess:mocks.success,publishNodeActionError:mocks.error}));
vi.mock('./api',()=>({HTML_ARTIFACT_UPDATED_EVENT:'updated',createHtmlArtifact:mocks.create,readHtmlPreview:vi.fn().mockResolvedValue({html:'<html>Saved</html>'}),openHtmlArtifact:mocks.open,exportHtmlArtifact:mocks.export}));
vi.mock('./preview',()=>({buildHtmlPreview:(html:string)=>html}));
vi.mock('@/features/canvas/ui/NodeHeader',()=>({NodeHeader:()=>null,NODE_HEADER_FLOATING_POSITION_CLASS:''}));
vi.mock('@/features/canvas/ui/NodeGenerationOverlay',()=>({NodeGenerationOverlay:()=> <div role="progressbar"/>}));
const props=(data:any)=>({id:'page',data,selected:true} as any);
beforeEach(()=>{vi.clearAllMocks();history.records=[];mocks.run.mockResolvedValue({artifact_id:'a',version:1});mocks.export.mockResolvedValue(undefined);});
afterEach(cleanup);
it('shows the ordinary text generation quote next to HTML generation',()=>{
 render(<HtmlArtifactNode {...props({prompt:'Build page'})}/>);
 expect(screen.getByText('6')).toBeTruthy();
 expect(billing.quote).toHaveBeenCalledWith('feature','freezone.text_generate',expect.objectContaining({surface:'canvas',quantity:9}));
});
it('blocks ordinary HTML generation when the pricing rule is missing',()=>{
 billing.quote.mockReturnValue({error:new BillingRuleNotConfiguredError('Missing rule',400)});
 render(<HtmlArtifactNode {...props({prompt:'Build'})}/>);
 expect(screen.getByText('common.billingRuleNotConfiguredShort')).toBeTruthy();
 expect(screen.getByRole('button',{name:'htmlArtifact.generate'})).toBeDisabled();
});
it('blocks generation when organization model access is denied',()=>{
 billing.access.mockReturnValue({blocked:true,message:'Bind a gateway key'});
 render(<HtmlArtifactNode {...props({prompt:'Build'})}/>);
 expect(screen.getByRole('button',{name:'htmlArtifact.generate'})).toBeDisabled();
});
it('does not quote ordinary text pricing for a Recipe node',()=>{
 render(<HtmlArtifactNode {...props({prompt:'Build',workflowCatalog:{recipeId:'page'}})}/>);
 expect(billing.quote).toHaveBeenCalledWith('feature',null,expect.anything());
 expect(screen.queryByText('6')).toBeNull();
});
it('keeps a direct-agent artifact previewable without requiring a Recipe',async()=>{
 await act(async()=>{render(<HtmlArtifactNode {...props({artifactId:'a',artifactVersion:1})}/>);});
 expect(screen.getByRole('button',{name:'htmlArtifact.regenerate'})).toBeTruthy();
 expect(screen.getByTitle('htmlArtifact.thumbnail')).toBeTruthy();
 expect(mocks.run).not.toHaveBeenCalled();
});
it('submits the same executor from the node button and action event',async()=>{
 render(<HtmlArtifactNode {...props({prompt:'Build page',workflowCatalog:{recipeId:'r'}})}/>);
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'htmlArtifact.generate'}));});
 expect(mocks.run).toHaveBeenCalledWith('page','p','c');
 await act(async()=>{mocks.handler({nodeId:'page',action:'generate_html',requestId:'req'});});
 expect(mocks.accepted).toHaveBeenCalledWith('req','page','generate_html');
 expect(mocks.success).toHaveBeenCalledWith('req','page','generate_html',{artifact_id:'a',version:1});
});
it('runs open, export and upload UI actions through the HTML node',async()=>{
 const saved=render(<HtmlArtifactNode {...props({artifactId:'a',artifactVersion:2})}/>);
 await act(async()=>{mocks.handler({nodeId:'page',action:'open',requestId:'open-req'});});
 expect(mocks.open).toHaveBeenCalledWith({projectId:'p',artifactId:'a',version:2,nodeId:'page'});
 await act(async()=>{mocks.handler({nodeId:'page',action:'export',requestId:'export-req'});});
 expect(mocks.export).toHaveBeenCalledWith('p','a',2);
 saved.unmount();
 const {container}=render(<HtmlArtifactNode {...props({})}/>);
 const click=vi.spyOn(container.querySelector('input[type="file"]') as HTMLInputElement,'click');
 await act(async()=>{mocks.handler({nodeId:'page',action:'upload',requestId:'upload-req'});});
 expect(click).toHaveBeenCalled();
});
it('shows generating and failed states and offers retry',()=>{
 const {rerender}=render(<HtmlArtifactNode {...props({prompt:'Build',workflowCatalog:{recipeId:'r'},isGenerating:true})}/>);
 expect(screen.getByRole('progressbar')).toBeTruthy();
 expect(screen.getByRole('button',{name:'htmlArtifact.generating'})).toBeDisabled();
 rerender(<HtmlArtifactNode {...props({prompt:'Build',workflowCatalog:{recipeId:'r'},generationError:'Conflict'})}/>);
 expect(screen.getByRole('alert')).toHaveTextContent('Conflict');
 expect(screen.getByRole('button',{name:'htmlArtifact.retry'})).toBeEnabled();
});

it('exposes the named handles used by manual and workflow connections',()=>{
 render(<HtmlArtifactNode {...props({})}/>);
 expect(screen.getByTestId('handle-target')).toHaveAttribute('data-handle-id','target');
 expect(screen.getByTestId('handle-source')).toHaveAttribute('data-handle-id','source');
});

it('shows connected input names in the generation panel',()=>{render(<HtmlArtifactNode {...props({workflowCatalog:{recipeId:'r'}})}/>);expect(screen.getByTitle('Coffee copy')).toBeTruthy();});

it('keeps reference thumbnails free of an extra mention button while rendering inline mentions',()=>{
 render(<HtmlArtifactNode {...props({prompt:'Use @文本1 ',workflowCatalog:{recipeId:'r'}})}/>);
 expect(screen.queryByTitle('canvas.reference.mention')).toBeNull();
 expect(document.querySelector('[data-mention="copy"]')).toBeTruthy();
});

it('imports an HTML file and attaches the saved artifact to the empty node',async()=>{
 mocks.create.mockResolvedValue({id:'uploaded',version:1});
 const {container}=render(<HtmlArtifactNode {...props({})}/>);
 const file=new File(['<html><body>Hello</body></html>'],'page.html',{type:'text/html'});
 Object.defineProperty(file,'text',{value:async()=>'<html><body>Hello</body></html>'});
 await act(async()=>{fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[file]}});});
 expect(mocks.create).toHaveBeenCalledWith('p','page','<html><body>Hello</body></html>');
 expect(mocks.attach).toHaveBeenCalledWith({id:'uploaded',version:1},'page','p','c',expect.any(Function));
});
it('rejects an invalid upload without creating an artifact',async()=>{
 const {container}=render(<HtmlArtifactNode {...props({})}/>);
 await act(async()=>{fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[new File(['bad'],'bad.txt')]}});});
 expect(mocks.create).not.toHaveBeenCalled();
 expect(screen.getByText('htmlArtifact.invalidFile')).toBeTruthy();
});

it('selects an HTML history result by changing only this node revision',()=>{
 history.records=[{id:'html:a:1',status:'completed',recorded_at:'2026-09-11T00:00:00Z',media_type:'html',result:{artifact_id:'a',version:1}}];
 render(<HtmlArtifactNode {...props({artifactId:'a',artifactVersion:2,prompt:'Build'})}/>);
 fireEvent.click(screen.getByRole('button',{name:'html-history'}));
 expect(mocks.update).toHaveBeenCalledWith('page',expect.objectContaining({artifactVersion:1}));
 expect(mocks.create).not.toHaveBeenCalled();
 expect(mocks.run).not.toHaveBeenCalled();
});
