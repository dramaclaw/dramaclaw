import {describe,it,expect} from 'vitest';
import {editHtmlText} from './textEditing';
describe('manual text editing',()=>{
 it('updates text safely while retaining media and scripts',()=>{
  const result=editHtmlText('<h1>Hello</h1><img src="/project/image.png"><script>hello()</script>','h1',{text:'<img onerror=x>',fontSize:42,color:'#123456'});
  const doc=new DOMParser().parseFromString(result,'text/html');
  expect(doc.querySelector('h1')?.textContent).toBe('<img onerror=x>');
  expect(doc.querySelector('h1')?.style.fontSize).toBe('42px');
  expect(doc.querySelectorAll('img')).toHaveLength(1);
  expect(doc.querySelector('script')?.textContent).toBe('hello()');
 });
 it('preserves nested markup for styling and rejects destructive text replacement',()=>{
  const html='<p>Hello <strong>world</strong></p>';
  expect(editHtmlText(html,'p',{textAlign:'center'})).toContain('<strong>world</strong>');
  expect(()=>editHtmlText(html,'p',{text:'replace'})).toThrow();
 });
 it('rejects script targets and invalid styles',()=>{
  expect(()=>editHtmlText('<script>x</script>','script',{text:'y'})).toThrow();
  expect(()=>editHtmlText('<p>x</p>','p',{fontSize:-1})).toThrow();
 });
});

it('gives aligned block text room inside centered flex layouts',()=>{
 const result=editHtmlText('<body style="display:flex;flex-direction:column;align-items:center"><h1>Title</h1></body>','h1',{textAlign:'right'});
 const doc=new DOMParser().parseFromString(result,'text/html');
 expect(doc.querySelector('h1')?.style.width).toBe('100%');
 expect(doc.querySelector('h1')?.style.textAlign).toBe('right');
});
