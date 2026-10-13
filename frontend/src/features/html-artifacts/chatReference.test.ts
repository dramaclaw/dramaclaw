import {expect,it} from 'vitest';
import {parseHtmlArtifactReference,appendHtmlArtifactTransportContext} from './chatReference';
it('bounds element references and rejects wrong project or invalid revision',()=>{
 const reference=parseHtmlArtifactReference({projectId:'p',artifactId:'a1',version:2,title:'Page',selector:'#hero',text:'x'.repeat(2000)},'p');
 expect(reference?.text).toHaveLength(500);
 expect(parseHtmlArtifactReference({...reference,projectId:'other'},'p')).toBeNull();
 expect(parseHtmlArtifactReference({...reference,version:0},'p')).toBeNull();
});
it('keeps structured metadata in transport while retaining ordinary prompt text',()=>{
 const reference={projectId:'p',artifactId:'a1',version:2,title:'Page',selector:'#hero',text:'Heading'};
 const transport=appendHtmlArtifactTransportContext('Make this blue','p',null,reference);
 expect(transport).toContain('Make this blue');
 expect(transport).toContain('"selector":"#hero"');
 expect(transport).toContain('untrusted');
 expect(appendHtmlArtifactTransportContext('Make this blue','other',null,reference)).toBe('Make this blue');
});
