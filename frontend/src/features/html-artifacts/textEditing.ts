export type TextEdit = {text?:string;fontSize?:number;color?:string;fontWeight?:string;textAlign?:string;fontFamily?:string};
/** Apply only explicit text/style changes to authored source, never iframe markup. */
export function editHtmlText(html:string, selector:string, patch:TextEdit):string {
  const doc=new DOMParser().parseFromString(html,'text/html');
  const el=doc.querySelector(selector);
  if(!(el instanceof HTMLElement)||['SCRIPT','STYLE','HTML','BODY','IFRAME','SVG'].includes(el.tagName))throw new Error('Select a text element');
  if(patch.text!==undefined){
    if(el.children.length)throw new Error('Select the innermost text element');
    el.textContent=patch.text;
  }
  if(patch.fontSize!==undefined){if(!Number.isFinite(patch.fontSize)||patch.fontSize<1||patch.fontSize>300)throw new Error('Invalid font size');el.style.fontSize=`${patch.fontSize}px`;}
  if(patch.color!==undefined){if(!/^#[a-f0-9]{6}$/i.test(patch.color))throw new Error('Invalid color');el.style.color=patch.color;}
  if(patch.fontWeight!==undefined){if(!['400','700'].includes(patch.fontWeight))throw new Error('Invalid font weight');el.style.fontWeight=patch.fontWeight;}
  if(patch.textAlign!==undefined){if(!['left','center','right'].includes(patch.textAlign))throw new Error('Invalid alignment');el.style.textAlign=patch.textAlign;if(['H1','H2','H3','H4','H5','H6','P','DIV','BLOCKQUOTE'].includes(el.tagName)){el.style.width='100%';el.style.boxSizing='border-box';}}
  if(patch.fontFamily!==undefined){if(!['sans-serif','serif','monospace'].includes(patch.fontFamily))throw new Error('Invalid font family');el.style.fontFamily=patch.fontFamily;}
  return '<!doctype html>\n'+doc.documentElement.outerHTML;
}
