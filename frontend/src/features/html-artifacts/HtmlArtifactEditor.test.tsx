import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { HtmlArtifactEditor } from './HtmlArtifactEditor';
import * as api from './api';
const canvasStore = vi.hoisted(() => ({updateNodeData: vi.fn()}));
vi.mock('./api', async () => ({...await vi.importActual('./api'), readHtmlArtifact:vi.fn(),readHtmlPreview:vi.fn(),listHtmlVersions:vi.fn(),saveHtmlArtifact:vi.fn(),announceHtmlArtifact:vi.fn()}));
vi.mock('@/stores/canvasStore', () => ({useCanvasStore:{getState:()=>canvasStore}}));
const artifact={id:'a',title:'Brand',version:1,html:'<h1>Original</h1>',created_at:'now',updated_at:'now'};
beforeEach(()=>{vi.clearAllMocks();vi.mocked(api.readHtmlArtifact).mockResolvedValue(artifact);vi.mocked(api.readHtmlPreview).mockResolvedValue({html:artifact.html,warnings:[],media:[],release:vi.fn()});vi.mocked(api.listHtmlVersions).mockResolvedValue({versions:[{version:1,title:'Brand',created_at:'now'}]});});
it('retains unsaved source on a version conflict and uses the version read as base',async()=>{
  vi.mocked(api.saveHtmlArtifact).mockRejectedValue(new Error('Version conflict'));
  render(<HtmlArtifactEditor projectId="p" artifactId="a" onClose={()=>{}} />);
  await screen.findByDisplayValue('Brand');
  fireEvent.click(screen.getByRole('button',{name:'代码'}));
  fireEvent.change(screen.getByLabelText('HTML 源码'),{target:{value:'<h1>Edited</h1>'}});
  fireEvent.click(screen.getByRole('button',{name:'保存'}));
  await screen.findByText('Version conflict');
  expect(screen.getByLabelText('HTML 源码')).toHaveValue('<h1>Edited</h1>');
  expect(api.saveHtmlArtifact).toHaveBeenCalledWith('p','a','Brand','<h1>Edited</h1>',1,undefined);
});
it('uses opaque-origin script sandbox and does not silently close a dirty editor',async()=>{
  const onClose=vi.fn(); const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
  const {container}=render(<HtmlArtifactEditor projectId="p" artifactId="a" onClose={onClose} />);
  await waitFor(()=>expect(container.querySelector('iframe')).toBeTruthy());
  expect(container.querySelector('iframe')).toHaveAttribute('sandbox','allow-scripts');
  fireEvent.change(screen.getByLabelText('网页名称'),{target:{value:'Changed'}});
  fireEvent.click(screen.getByRole('button',{name:'返回画布'}));
  expect(onClose).not.toHaveBeenCalled(); confirm.mockRestore();
});
it('renders the exact revision that was read, avoiding mixed-version previews',async()=>{
  render(<HtmlArtifactEditor projectId="p" artifactId="a" onClose={()=>{}} />);
  await waitFor(()=>expect(api.readHtmlPreview).toHaveBeenCalledWith('p','a',1));
});
it('retains a source draft when navigating away and reopening the artifact',async()=>{
  const first=render(<HtmlArtifactEditor projectId="navigation" artifactId="a" onClose={()=>{}} />);
  await screen.findByDisplayValue('Brand');
  fireEvent.click(screen.getByRole('button',{name:'代码'}));
  fireEvent.change(screen.getByLabelText('HTML 源码'),{target:{value:'draft after navigation'}});
  first.unmount();
  render(<HtmlArtifactEditor projectId="navigation" artifactId="a" onClose={()=>{}} />);
  await screen.findByDisplayValue('Brand');
  fireEvent.click(screen.getByRole('button',{name:'代码'}));
  expect(screen.getByLabelText('HTML 源码')).toHaveValue('draft after navigation');
});
it('remounts a credentialless frame only after explicit interactive opt-in',async()=>{
 Object.defineProperty(HTMLIFrameElement.prototype,'credentialless',{configurable:true,value:false});
 try{
  const {container}=render(<HtmlArtifactEditor projectId="interactive" artifactId="a" onClose={()=>{}} />);
  await screen.findByDisplayValue('Brand');
  const staticFrame=container.querySelector('iframe');
  expect(staticFrame).not.toHaveAttribute('credentialless');
  fireEvent.click(screen.getByRole('button',{name:'运行网页脚本'}));
  const interactiveFrame=container.querySelector('iframe');
  expect(interactiveFrame).not.toBe(staticFrame);
  expect(interactiveFrame).toHaveAttribute('credentialless','');
  fireEvent.click(screen.getByRole('button',{name:'停止网页脚本'}));
  expect(container.querySelector('iframe')).not.toBe(interactiveFrame);
 }finally{delete (HTMLIFrameElement.prototype as unknown as Record<string,unknown>).credentialless;}
});
it('keeps interactive mode disabled when credential isolation is unavailable',async()=>{
 render(<HtmlArtifactEditor projectId="unsupported" artifactId="a" onClose={()=>{}} />);
 await screen.findByDisplayValue('Brand');
 expect(screen.getByRole('button',{name:'运行网页脚本'})).toBeDisabled();
});
it('requires a fresh interactive opt-in after a saved revision changes',async()=>{
 Object.defineProperty(HTMLIFrameElement.prototype,'credentialless',{configurable:true,value:false});
 try{
  const {container}=render(<HtmlArtifactEditor projectId="revision" artifactId="a" onClose={()=>{}} />);
  await screen.findByDisplayValue('Brand');
  fireEvent.click(screen.getByRole('button',{name:'运行网页脚本'}));
  vi.mocked(api.readHtmlArtifact).mockResolvedValue({...artifact,version:2,html:'<h1>Second</h1>'});
  vi.mocked(api.readHtmlPreview).mockResolvedValue({html:'<h1>Second</h1>',warnings:[],media:[],release:vi.fn()});
  window.dispatchEvent(new CustomEvent(api.HTML_ARTIFACT_UPDATED_EVENT,{detail:{projectId:'revision',artifact:{...artifact,version:2}}}));
  await screen.findByText('v2');
  expect(container.querySelector('iframe')).not.toHaveAttribute('credentialless');
  expect(container.querySelector('iframe')?.srcdoc).not.toContain("script-src 'unsafe-inline'");
 }finally{delete (HTMLIFrameElement.prototype as unknown as Record<string,unknown>).credentialless;}
});

it('opens the requested historical version and saves against the head observed at load',async()=>{
  vi.mocked(api.listHtmlVersions).mockResolvedValue({versions:[{version:3,title:'New',created_at:'now'},{version:1,title:'Brand',created_at:'now'}]});
  vi.mocked(api.saveHtmlArtifact).mockRejectedValue(new Error('Version conflict'));
  render(<HtmlArtifactEditor projectId="historical" artifactId="a" version={1} nodeId="n" onClose={()=>{}} />);
  await screen.findByDisplayValue('Brand');
  expect(api.readHtmlArtifact).toHaveBeenCalledWith('historical','a',1);
  fireEvent.change(screen.getByLabelText('网页名称'),{target:{value:'Based on old version'}});
  fireEvent.click(screen.getByRole('button',{name:'保存'}));
  await screen.findByText('Version conflict');
  expect(api.saveHtmlArtifact).toHaveBeenCalledWith('historical','a','Based on old version',artifact.html,3,undefined);
});
it('using a historical version only switches the selected node reference',async()=>{
  render(<HtmlArtifactEditor projectId="select-history" artifactId="a" version={1} nodeId="node" onClose={()=>{}} />);
  await screen.findByDisplayValue('Brand');
  fireEvent.click(screen.getByRole('button',{name:'使用此版本'}));
  expect(canvasStore.updateNodeData).toHaveBeenCalledWith('node',expect.objectContaining({
    artifactId:'a', artifactVersion:1, displayName:'Brand', htmlSelectionToken:expect.any(String),
  }));
  expect(api.announceHtmlArtifact).toHaveBeenCalledWith('select-history',artifact,'node');
  expect(api.saveHtmlArtifact).not.toHaveBeenCalled();
});
it('does not advance a saved draft conflict base when reopened after another edit',async()=>{
  vi.mocked(api.listHtmlVersions).mockResolvedValue({versions:[{version:2,title:'New',created_at:'now'}]});
  const first=render(<HtmlArtifactEditor projectId="stale-draft" artifactId="a" version={1} onClose={()=>{}} />);
  await screen.findByDisplayValue('Brand');
  fireEvent.change(screen.getByLabelText('网页名称'),{target:{value:'Draft'}});
  first.unmount();
  vi.mocked(api.listHtmlVersions).mockResolvedValue({versions:[{version:3,title:'Newer',created_at:'now'}]});
  vi.mocked(api.saveHtmlArtifact).mockRejectedValue(new Error('Version conflict'));
  render(<HtmlArtifactEditor projectId="stale-draft" artifactId="a" version={1} onClose={()=>{}} />);
  await screen.findByDisplayValue('Draft');
  fireEvent.click(screen.getByRole('button',{name:'保存'}));
  await screen.findByText('Version conflict');
  expect(api.saveHtmlArtifact).toHaveBeenCalledWith('stale-draft','a','Draft',artifact.html,2,undefined);
});
it('sends preview media URLs into the opaque iframe after load',async()=>{
  const media=[{placeholder:'html-artifact-resource-0',url:'https://media.example/image.png'}];
  vi.mocked(api.readHtmlPreview).mockResolvedValue({html:artifact.html,media,warnings:[],release:vi.fn()});
  const {container}=render(<HtmlArtifactEditor projectId="media-bridge" artifactId="a" onClose={()=>{}} />);
  await screen.findByDisplayValue('Brand');
  const iframe=container.querySelector('iframe')!;
  const post=vi.spyOn(iframe.contentWindow!,'postMessage');
  fireEvent.load(iframe);
  expect(post).toHaveBeenCalledWith({type:'html-artifact-media',token:expect.any(String),media},'*');
  expect(iframe).toHaveAttribute('sandbox','allow-scripts');
});
it('edits selected text into source and saves through the version API',async()=>{
 const {container}=render(<HtmlArtifactEditor projectId="manual" artifactId="a" onClose={()=>{}}/>);
 await screen.findByDisplayValue('Brand');
 fireEvent.click(screen.getByRole('button',{name:'选择元素'}));
 const iframe=container.querySelector('iframe')!;
 const doc=new DOMParser().parseFromString(iframe.srcdoc,'text/html');
 const token=doc.querySelector('script[nonce]')!.getAttribute('nonce');
 fireEvent(window,new MessageEvent('message',{source:iframe.contentWindow,data:{type:'html-artifact-selection',token,selector:'body > h1:nth-of-type(1)',text:'Original'}}));
 fireEvent.change(await screen.findByLabelText('文字内容'),{target:{value:'New heading'}});
 expect(container.querySelector('iframe')!.srcdoc).toContain('New heading');
 fireEvent.click(screen.getByRole('button',{name:'保存'}));
 await waitFor(()=>expect(api.saveHtmlArtifact).toHaveBeenCalledWith('manual','a','Brand',expect.stringContaining('<h1>New heading</h1>'),1,undefined));
});
