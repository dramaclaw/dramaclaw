import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { HtmlArtifactEditor } from './HtmlArtifactEditor';
import * as api from './api';
vi.mock('./api', async () => ({...await vi.importActual('./api'), readHtmlArtifact:vi.fn(),readHtmlPreview:vi.fn(),listHtmlVersions:vi.fn(),saveHtmlArtifact:vi.fn(),announceHtmlArtifact:vi.fn()}));
const artifact={id:'a',title:'Brand',version:1,html:'<h1>Original</h1>',created_at:'now',updated_at:'now'};
beforeEach(()=>{vi.clearAllMocks();vi.mocked(api.readHtmlArtifact).mockResolvedValue(artifact);vi.mocked(api.readHtmlPreview).mockResolvedValue({html:artifact.html});vi.mocked(api.listHtmlVersions).mockResolvedValue({versions:[{version:1,title:'Brand',created_at:'now'}]});});
it('retains unsaved source on a version conflict and uses the version read as base',async()=>{
  vi.mocked(api.saveHtmlArtifact).mockRejectedValue(new Error('Version conflict'));
  render(<HtmlArtifactEditor projectId="p" artifactId="a" onClose={()=>{}} />);
  await screen.findByDisplayValue('Brand');
  fireEvent.click(screen.getByRole('button',{name:'代码'}));
  fireEvent.change(screen.getByLabelText('HTML 源码'),{target:{value:'<h1>Edited</h1>'}});
  fireEvent.click(screen.getByRole('button',{name:'保存'}));
  await screen.findByText('Version conflict');
  expect(screen.getByLabelText('HTML 源码')).toHaveValue('<h1>Edited</h1>');
  expect(api.saveHtmlArtifact).toHaveBeenCalledWith('p','a','Brand','<h1>Edited</h1>',1);
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
  vi.mocked(api.readHtmlPreview).mockResolvedValue({html:'<h1>Second</h1>'});
  window.dispatchEvent(new CustomEvent(api.HTML_ARTIFACT_UPDATED_EVENT,{detail:{projectId:'revision',artifact:{...artifact,version:2}}}));
  await screen.findByText('v2');
  expect(container.querySelector('iframe')).not.toHaveAttribute('credentialless');
  expect(container.querySelector('iframe')?.srcdoc).not.toContain("script-src 'unsafe-inline'");
 }finally{delete (HTMLIFrameElement.prototype as unknown as Record<string,unknown>).credentialless;}
});
