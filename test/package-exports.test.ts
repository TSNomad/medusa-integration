/**
 * The public entry point, imported by package name.
 */

import { expect, test } from 'vitest';
import * as medusa from '@tsnomad/medusa-integration';

test('exports the strategies, the initializer, the bootstrap, the task event names, the actor reader and the Medusa tokens', () => {
  expect(Object.keys(medusa).sort()).toEqual([
    'MedusaActionBindingStrategy',
    'MedusaBootstrap',
    'MedusaContainer',
    'MedusaEventBus',
    'MedusaInitializer',
    'MedusaLogger',
    'MedusaLoggerStrategy',
    'MedusaRestStrategy',
    'MedusaTaskEvents',
    'MedusaTaskStrategy',
    'TASK_EVENT_PREFIX',
    'medusaActorOf',
    'taskEventName',
  ]);
});

test('names each Medusa token after its interface', () => {
  expect([medusa.MedusaContainer.name, medusa.MedusaLogger.name, medusa.MedusaEventBus.name, medusa.MedusaTaskEvents.name]).toEqual([
    'MedusaContainer',
    'MedusaLogger',
    'MedusaEventBus',
    'MedusaTaskEvents',
  ]);
});
