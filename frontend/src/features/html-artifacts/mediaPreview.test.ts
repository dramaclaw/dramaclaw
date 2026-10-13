import {beforeEach, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({apiCall:vi.fn(), apiClient:vi.fn(), download:vi.fn()}));
vi.mock('@/api/client',()=>mocks);
vi.mock('@/lib/browserDownload',()=>({downloadUrlAsFile:mocks.download}));
import {readHtmlPreview,exportHtmlArtifact} from './api';
beforeEach(()=>{vi.clearAllMocks(); URL.createObjectURL=vi.fn(()=> 'blob:test-media'); URL.revokeObjectURL=vi.fn();});
it('returns scoped URLs without downloading media bytes',async()=>{
 const placeholder='html-media-'+'a'.repeat(64);
 mocks.apiCall.mockResolvedValue({html:`<video src="${placeholder}"></video>`,resources:[{placeholder,path:'/api/v1/projects/p/media/clip.mp4',url:'/api/v1/projects/p/freezone/html-artifacts/a/preview-media/1900/token/clip.mp4'}]});
 mocks.apiClient.mockReturnValue({blob:async()=>new Blob(['video'])});
 const result=await readHtmlPreview('p','a',2);
 expect(mocks.apiClient).not.toHaveBeenCalled();
 expect(result.html).toContain(placeholder);expect(result.media).toHaveLength(1);expect(result.media[0].url).toContain('/preview-media/');
});
it('rejects media outside the authorized project before fetching',async()=>{
 mocks.apiCall.mockResolvedValue({html:'',resources:[{placeholder:'html-media-'+'a'.repeat(64),path:'/api/v1/projects/peer/media/image.png'}]});
 await expect(readHtmlPreview('p','a')).rejects.toThrow('scope');expect(mocks.apiClient).not.toHaveBeenCalled();
});
it('rejects unscoped local media URLs',async()=>{
 const placeholder='html-media-'+'a'.repeat(64);
 mocks.apiCall.mockResolvedValue({html:'',resources:[{placeholder,path:'/api/v1/projects/p/media/image.png',url:'/api/v1/admin'}]});
 await expect(readHtmlPreview('p','a')).rejects.toThrow('URL');
});

it('downloads the requested version from the temporary export endpoint',async()=>{
 await exportHtmlArtifact('p','a',2);
 expect(mocks.apiCall).not.toHaveBeenCalled();
 expect(mocks.download).toHaveBeenCalledWith('/api/v1/projects/p/freezone/html-artifacts/a/export?version=2','webpage-a-v2.zip');
});
