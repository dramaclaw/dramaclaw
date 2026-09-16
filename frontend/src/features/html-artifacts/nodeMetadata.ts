import type {HtmlArtifact} from './api';
export function htmlArtifactNodePatches(
  nodes:ReadonlyArray<{id:string;type?:string;data:Record<string,unknown>}>,
  artifact:Pick<HtmlArtifact,'id'|'version'|'title'>,
){
  return nodes.filter(node=>node.type==='htmlArtifactNode'&&node.data.artifactId===artifact.id)
    .map(node=>({id:node.id,data:{artifactId:artifact.id,artifactVersion:artifact.version,displayName:artifact.title}}));
}
