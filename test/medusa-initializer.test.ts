/**
 * Acceptance tests for MedusaInitializer.
 *
 * They use real wiring: a real container and the real loader, with
 * Medusa replaced by a fake logger and event bus.
 */

import { describe, expect, test } from 'vitest';
import { Container } from '@tsnomad/di-container';
import { ActionBindingStrategy, EventStrategy, InMemoryEventStrategy } from '@tsnomad/event';
import { FetchStrategy } from '@tsnomad/fetch';
import { ResponseFactory } from '@tsnomad/http';
import { Bootstrapper } from '@tsnomad/loader';
import { LoggerStrategy } from '@tsnomad/logger';
import { NativeFetchStrategy, NodeResponseFactory } from '@tsnomad/node-integration';
import { RestStrategy } from '@tsnomad/rest';
import { TaskStrategy } from '@tsnomad/tasks';
import {
  MedusaActionBindingStrategy,
  MedusaEventBus,
  MedusaInitializer,
  MedusaLogger,
  MedusaLoggerStrategy,
  MedusaRestStrategy,
  MedusaTaskEvents,
  MedusaTaskStrategy,
} from '@tsnomad/medusa-integration';
import { fakeMedusa } from './fakes.js';

const table = [
  [MedusaActionBindingStrategy, ActionBindingStrategy],
  [MedusaRestStrategy, RestStrategy],
  [MedusaTaskStrategy, TaskStrategy],
  [MedusaLoggerStrategy, LoggerStrategy],
  [InMemoryEventStrategy, EventStrategy],
  [NativeFetchStrategy, FetchStrategy],
  [NodeResponseFactory, ResponseFactory],
] as const;

async function loaded(): Promise<Container> {
  const { logger, bus } = fakeMedusa();
  const container = new Container();
  container.bindFactory(MedusaLogger, () => logger);
  container.bindFactory(MedusaEventBus, () => bus);
  container.bindFactory(MedusaTaskEvents, () => new Set<string>());
  await new Bootstrapper(container, new MedusaInitializer()).load();
  return container;
}

describe('MedusaInitializer', () => {
  test('binds each strategy under its interface token and its own class, one instance for both', async () => {
    const container = await loaded();

    for (const [concrete, token] of table) {
      const byToken = await container.get(token as never);
      const byClass = await container.get(concrete as never);
      expect(byToken).toBeInstanceOf(concrete);
      expect(byClass).toBe(byToken);
    }
  });

  test('defines exactly those seven pairs and nothing else', () => {
    const definitions = new MedusaInitializer().getClassDefinitions();

    expect(definitions).toEqual(table.map(([concrete, token]) => [concrete, [token, concrete]]));
  });
});
