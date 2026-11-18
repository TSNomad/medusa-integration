/**
 * MedusaInitializer
 *
 * The platform initializer for Medusa, as PHPNomad's WordPress integration
 * ships `WordPressInitializer`. `MedusaBootstrap` loads it first, before
 * the application's own initializers. Its class definitions bind each
 * strategy under its interface token and under its own class, so both
 * names reach one instance:
 *
 * | Concrete | Abstracts |
 * |---|---|
 * | `MedusaActionBindingStrategy` | `ActionBindingStrategy`, `MedusaActionBindingStrategy` |
 * | `MedusaRestStrategy` | `RestStrategy`, `MedusaRestStrategy` |
 * | `MedusaTaskStrategy` | `TaskStrategy`, `MedusaTaskStrategy` |
 * | `MedusaLoggerStrategy` | `LoggerStrategy`, `MedusaLoggerStrategy` |
 * | `InMemoryEventStrategy` | `EventStrategy`, `InMemoryEventStrategy` |
 * | `NativeFetchStrategy` | `FetchStrategy`, `NativeFetchStrategy` |
 * | `NodeResponseFactory` | `ResponseFactory`, `NodeResponseFactory` |
 *
 * The last three come from @tsnomad/node-integration, since Medusa adds
 * nothing to an in-process event bus, Node's fetch or an in-memory
 * response. It binds nothing else. The Medusa tokens it relies on,
 * `MedusaContainer`, `MedusaLogger` and `MedusaEventBus`, are bound by
 * `MedusaBootstrap` before any initializer loads.
 */

import { ActionBindingStrategy, EventStrategy, InMemoryEventStrategy } from '@tsnomad/event';
import { FetchStrategy } from '@tsnomad/fetch';
import { ResponseFactory } from '@tsnomad/http';
import type { ClassDefinition, HasClassDefinitions } from '@tsnomad/loader';
import { LoggerStrategy } from '@tsnomad/logger';
import { NativeFetchStrategy, NodeResponseFactory } from '@tsnomad/node-integration';
import { RestStrategy } from '@tsnomad/rest';
import { TaskStrategy } from '@tsnomad/tasks';
import { MedusaActionBindingStrategy } from './MedusaActionBindingStrategy.js';
import { MedusaLoggerStrategy } from './MedusaLoggerStrategy.js';
import { MedusaRestStrategy } from './MedusaRestStrategy.js';
import { MedusaTaskStrategy } from './MedusaTaskStrategy.js';

export class MedusaInitializer implements HasClassDefinitions {
  getClassDefinitions(): readonly ClassDefinition[] {
    return [
      [MedusaActionBindingStrategy, [ActionBindingStrategy, MedusaActionBindingStrategy]],
      [MedusaRestStrategy, [RestStrategy, MedusaRestStrategy]],
      [MedusaTaskStrategy, [TaskStrategy, MedusaTaskStrategy]],
      [MedusaLoggerStrategy, [LoggerStrategy, MedusaLoggerStrategy]],
      [InMemoryEventStrategy, [EventStrategy, InMemoryEventStrategy]],
      [NativeFetchStrategy, [FetchStrategy, NativeFetchStrategy]],
      [NodeResponseFactory, [ResponseFactory, NodeResponseFactory]],
    ];
  }
}
