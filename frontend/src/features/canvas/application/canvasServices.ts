// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { InMemoryCanvasEventBus } from './eventBus';
import { DefaultGraphContentResolver } from './graphContentResolver';
import { DefaultGraphImageResolver } from './graphImageResolver';
import { nodeCatalog } from './nodeCatalog';
import { CanvasNodeFactory } from './nodeFactory';
import { CanvasToolProcessor } from './toolProcessor';
import { browserNodeDataDefaults } from '../infrastructure/browserNodeDataDefaults';
import { uuidGenerator } from '../infrastructure/idGenerator';
import { freezoneAiGateway } from '../infrastructure/freezoneAiGateway';
import { webImageSplitGateway } from '../infrastructure/webImageSplitGateway';

export const canvasEventBus = new InMemoryCanvasEventBus();
export const canvasNodeFactory = new CanvasNodeFactory(
  uuidGenerator,
  nodeCatalog,
  browserNodeDataDefaults,
);
export const graphImageResolver = new DefaultGraphImageResolver();
export const graphContentResolver = new DefaultGraphContentResolver();
export const canvasToolProcessor = new CanvasToolProcessor(webImageSplitGateway, uuidGenerator);
export const canvasAiGateway = freezoneAiGateway;
