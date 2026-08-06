// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { NodeTypes } from '@xyflow/react';

import { withLodShell } from './LodShellNode';
import { AudioNode } from './AudioNode';
import { BeatContextNode } from './BeatContextNode';
import { GroupNode } from './GroupNode';
import { ImageEditNode } from './ImageEditNode';
import { ImageGenNode } from './ImageGenNode';
import { ImageNode } from './ImageNode';
import { Pano360ViewerNode } from './Pano360ViewerNode';
import { ScriptNode } from './ScriptNode';
import { SkillNode } from './SkillNode';
import { StoryboardGenNode } from './StoryboardGenNode';
import { StoryboardNode } from './StoryboardNode';
import { TextAnnotationNode } from './TextAnnotationNode';
import { ThreeDWorldNode } from './ThreeDWorldNode';
import { UploadNode } from './UploadNode';
import { VideoComposeNode } from './VideoComposeNode';
import { VideoNode } from './VideoNode';
import { VideoStoryNode } from './VideoStoryNode';

// 全部经 withLodShell 包装：低缩放档渲染轻量外壳（豁免类型在包装器内部判断，
// 保持这张表均质）。包装发生在模块加载期，引用稳定，不会造成节点重挂。
export const nodeTypes: NodeTypes = {
  audioNode: withLodShell('audioNode', AudioNode),
  beatContextNode: withLodShell('beatContextNode', BeatContextNode),
  exportImageNode: withLodShell('exportImageNode', ImageNode),
  groupNode: withLodShell('groupNode', GroupNode),
  imageGenNode: withLodShell('imageGenNode', ImageGenNode),
  imageNode: withLodShell('imageNode', ImageEditNode),
  pano360ViewerNode: withLodShell('pano360ViewerNode', Pano360ViewerNode),
  scriptNode: withLodShell('scriptNode', ScriptNode),
  skillNode: withLodShell('skillNode', SkillNode),
  storyboardGenNode: withLodShell('storyboardGenNode', StoryboardGenNode),
  storyboardNode: withLodShell('storyboardNode', StoryboardNode),
  textAnnotationNode: withLodShell('textAnnotationNode', TextAnnotationNode),
  threeDWorldNode: withLodShell('threeDWorldNode', ThreeDWorldNode),
  uploadNode: withLodShell('uploadNode', UploadNode),
  videoComposeNode: withLodShell('videoComposeNode', VideoComposeNode),
  videoNode: withLodShell('videoNode', VideoNode),
  videoStoryNode: withLodShell('videoStoryNode', VideoStoryNode),
};

export { AudioNode, BeatContextNode, GroupNode, ImageEditNode, ImageGenNode, ImageNode, Pano360ViewerNode, ScriptNode, SkillNode, StoryboardGenNode, StoryboardNode, TextAnnotationNode, ThreeDWorldNode, UploadNode, VideoComposeNode, VideoNode, VideoStoryNode };
