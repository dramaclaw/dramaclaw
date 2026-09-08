import {fireEvent,render,screen} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {HtmlArtifactResultCard} from './HtmlArtifactResultCard';
import {openHtmlArtifact} from './api';
vi.mock('./api',()=>({openHtmlArtifact:vi.fn()}));
it('opens the exact saved historical identity and never executes HTML',()=>{
 render(<HtmlArtifactResultCard output={{project_id:'p',html_artifact:{id:'a1',title:'Page <script>',version:3,html:'<script>evil()</script>'}}}/>);
 fireEvent.click(screen.getByRole('button'));
 expect(openHtmlArtifact).toHaveBeenCalledWith({projectId:'p',artifactId:'a1',version:3});
 expect(document.querySelector('script')).toBeNull();
});
it('ignores incomplete or unscoped tool output',()=>{
 const {container}=render(<HtmlArtifactResultCard output={{html_artifact:{id:'a1',version:3}}}/>);
 expect(container).toBeEmptyDOMElement();
});
