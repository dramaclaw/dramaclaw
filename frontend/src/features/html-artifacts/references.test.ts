import {expect, it} from 'vitest';
import {buildHtmlReferences} from './references';

it('uses stable per-kind numbering and actual outputs in connection order',()=>{
 const nodes = [
  {id:'t',type:'textAnnotationNode',data:{content:'Coffee',displayName:'Copy'}},
  {id:'i',type:'imageGenNode',data:{imageUrl:'/real.png',referenceImageUrl:'/ref.png',imageNaturalWidth:1088,imageNaturalHeight:608,aspectRatio:'34:19'}},
  {id:'v',type:'videoComposeNode',data:{videoUrl:'/movie.mp4',widthPx:1920,heightPx:1080,aspectRatio:'16:9',durationMs:8000}},
 ];
 expect(buildHtmlReferences([...nodes,nodes[1]] as any)).toMatchObject([
  {nodeId:'t',mention:'文本1',text:'Coffee',name:'Copy'},
  {nodeId:'i',mention:'图片1',url:'/real.png',width:1088,height:608,aspectRatio:'34:19'},
  {nodeId:'v',mention:'视频1',url:'/movie.mp4',width:1920,height:1080,aspectRatio:'16:9',durationMs:8000},
 ]);
});
it('omits invalid dimensions while preserving a known aspect ratio',()=>{
 expect(buildHtmlReferences([{id:'i',type:'imageNode',data:{imageUrl:'/image.png',imageNaturalWidth:0,imageNaturalHeight:'bad',aspectRatio:'4:3'}}] as any)).toMatchObject([
  {mention:'图片1',aspectRatio:'4:3',width:undefined,height:undefined},
 ]);
});
it('keeps a pending image reference numbered without substituting its input image',()=>{
 expect(buildHtmlReferences([{id:'i',type:'imageGenNode',data:{referenceImageUrl:'/ref.png'}}] as any)).toMatchObject([{mention:'图片1',url:undefined}]);
});
