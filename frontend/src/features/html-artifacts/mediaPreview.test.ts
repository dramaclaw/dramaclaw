import {beforeEach, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({apiCall:vi.fn(), apiClient:vi.fn(), download:vi.fn()}));
vi.mock('@/api/client',()=>mocks);
vi.mock('@/lib/browserDownload',()=>({downloadUrlAsFile:mocks.download}));
import {readHtmlPreview,exportHtmlArtifact} from './api';
beforeEach(()=>{vi.clearAllMocks(); URL.createObjectURL=vi.fn(()=> 'blob:test-media'); URL.revokeObjectURL=vi.fn();});
it('loads scoped media as transferable blobs using the authenticated client',async()=>{
 const placeholder='html-media-'+'a'.repeat(64);
 mocks.apiCall.mockResolvedValue({html:`<video src="${placeholder}"></video>`,resources:[{placeholder,path:'/api/v1/projects/p/media/clip.mp4'}]});
 mocks.apiClient.mockReturnValue({blob:async()=>new Blob(['video'])});
 const result=await readHtmlPreview('p','a',2);
 expect(mocks.apiClient).toHaveBeenCalledWith('projects/p/media/clip.mp4');
 expect(result.html).toContain(placeholder);expect(result.media).toHaveLength(1);expect(result.media[0].blob).toBeInstanceOf(Blob);
});
it('rejects media outside the authorized project before fetching',async()=>{
 mocks.apiCall.mockResolvedValue({html:'',resources:[{placeholder:'html-media-'+'a'.repeat(64),path:'/api/v1/projects/peer/media/image.png'}]});
 await expect(readHtmlPreview('p','a')).rejects.toThrow('scope');expect(mocks.apiClient).not.toHaveBeenCalled();
});
it('keeps the preview readable and reports a missing media file',async()=>{
 const placeholder='html-media-'+'a'.repeat(64);
 mocks.apiCall.mockResolvedValue({html:`<img src="${placeholder}">`,resources:[{placeholder,path:'/api/v1/projects/p/media/missing.png'}]});
 mocks.apiClient.mockReturnValue({blob:async()=>{throw Error('404');}});
 const result=await readHtmlPreview('p','a');expect(result.html).toContain('about:blank');expect(result.warnings).toHaveLength(1);
});

it('downloads the prepared version through the project files endpoint',async()=>{
 mocks.apiCall.mockResolvedValue({download_url:'/api/v1/projects/p/files/freezone/_html_artifacts/a/exports/v2.zip'});
 await exportHtmlArtifact('p','a',2);
 expect(mocks.download).toHaveBeenCalledWith('/api/v1/projects/p/files/freezone/_html_artifacts/a/exports/v2.zip','webpage-a-v2.zip');
});
