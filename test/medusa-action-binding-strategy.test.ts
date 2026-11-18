/**
 * Acceptance tests for MedusaActionBindingStrategy.
 *
 * The strategy broadcasts through the real InMemoryEventStrategy from
 * @tsnomad/event and logs to a recording TS Nomad logger.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventStrategy, InMemoryEventStrategy } from '@tsnomad/event';
import type { Event, EventClass } from '@tsnomad/event';
import { LoggerStrategy } from '@tsnomad/logger';
import { MedusaActionBindingStrategy } from '@tsnomad/medusa-integration';
import { NotAnEvent, OrderCompleted, OrderPlaced, RecordingLogger, ThrowingLogger, deferred, rejection, tick } from './fakes.js';

let events: InMemoryEventStrategy;
let logger: RecordingLogger;
let strategy: MedusaActionBindingStrategy;
let seen: Event[];

/** The error `runAction` logs for an action with no bindings. */
function unbound(action: string): unknown[] {
  return ['error', `No TS Nomad binding for action '${action}'`, { action }];
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  events = new InMemoryEventStrategy();
  logger = new RecordingLogger();
  strategy = new MedusaActionBindingStrategy(events, logger);
  seen = [];
  events.attach(OrderPlaced, (event) => {
    seen.push(event);
  });
  events.attach(OrderCompleted, (event) => {
    seen.push(event);
  });
});

describe('MedusaActionBindingStrategy.runAction', () => {
  test("broadcasts the transformer's event, built from the action's arguments", async () => {
    const received: unknown[][] = [];
    strategy.bindAction(OrderPlaced, 'order.placed', (data: { id: string }, message: unknown) => {
      received.push([data, message]);
      return new OrderPlaced({ id: data.id });
    });
    const message = { name: 'order.placed', data: { id: 'order_1' } };

    await strategy.runAction('order.placed', { id: 'order_1' }, message);

    expect(received).toEqual([[{ id: 'order_1' }, message]]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(OrderPlaced);
    expect((seen[0] as OrderPlaced).orderId).toBe('order_1');
  });

  test('awaits an async transformer before it broadcasts', async () => {
    strategy.bindAction(OrderPlaced, 'order.placed', async (data: { id: string }) => {
      await tick();
      return new OrderPlaced({ id: data.id });
    });

    await strategy.runAction('order.placed', { id: 'order_2' });

    expect(seen.map((e) => (e as OrderPlaced).orderId)).toEqual(['order_2']);
  });

  test('builds the event class from the arguments when the binding has no transformer', async () => {
    strategy.bindAction(OrderPlaced, 'order.placed');

    await strategy.runAction('order.placed', { id: 'order_3' }, 'second', 3);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(OrderPlaced);
    expect((seen[0] as OrderPlaced).orderId).toBe('order_3');
    expect((seen[0] as OrderPlaced).extra).toEqual(['second', 3]);
  });

  test('binds by event id when a transformer is given', async () => {
    strategy.bindAction('shop.order-completed', 'order.completed', (data: { id: string }) => new OrderCompleted(data.id));

    await strategy.runAction('order.completed', { id: 'order_4' });

    expect(seen).toHaveLength(1);
    expect((seen[0] as OrderCompleted).orderId).toBe('order_4');
  });

  test('raises nothing when the transformer returns null, and the next binding still runs', async () => {
    strategy.bindAction(OrderPlaced, 'order.placed', () => null);
    strategy.bindAction(OrderPlaced, 'order.placed', (data: { id: string }) => new OrderPlaced({ id: `${data.id}-b` }));

    await strategy.runAction('order.placed', { id: 'order_5' });

    expect(seen.map((e) => (e as OrderPlaced).orderId)).toEqual(['order_5-b']);
  });

  test('runs only the bindings of the named action', async () => {
    strategy.bindAction(OrderPlaced, 'order.placed', (data: { id: string }) => new OrderPlaced(data));
    strategy.bindAction(OrderCompleted, 'order.completed', (data: { id: string }) => new OrderCompleted(data.id));

    await strategy.runAction('order.completed', { id: 'order_6' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(OrderCompleted);
  });

  test('resolves, raises nothing and logs an error for an action with no bindings', async () => {
    strategy.bindAction(OrderPlaced, 'order.placed', (data: { id: string }) => new OrderPlaced(data));

    await expect(strategy.runAction('order.canceled', { id: 'order_7' })).resolves.toBeUndefined();

    expect(seen).toEqual([]);
    expect(logger.calls).toEqual([unbound('order.canceled')]);
    await strategy.runAction('order.placed', { id: 'order_7' });
    expect(seen).toHaveLength(1);
  });

  test('runs bindings one at a time, in bind order, each awaited before the next starts', async () => {
    const log: string[] = [];
    const first = deferred();
    strategy.bindAction(OrderPlaced, 'order.placed', async (data: { id: string }) => {
      log.push('first start');
      await first.promise;
      log.push('first end');
      return new OrderPlaced({ id: 'first' });
    });
    strategy.bindAction(OrderPlaced, 'order.placed', async () => {
      log.push('second start');
      return new OrderPlaced({ id: 'second' });
    });

    const run = strategy.runAction('order.placed', { id: 'x' });
    await tick();
    expect(log).toEqual(['first start']);
    first.resolve();
    await run;

    expect(log).toEqual(['first start', 'first end', 'second start']);
    expect(seen.map((e) => (e as OrderPlaced).orderId)).toEqual(['first', 'second']);
  });

  test('runs a binding as often as it was bound', async () => {
    const transformer = (data: { id: string }) => new OrderPlaced(data);
    strategy.bindAction(OrderPlaced, 'order.placed', transformer);
    strategy.bindAction(OrderPlaced, 'order.placed', transformer);

    await strategy.runAction('order.placed', { id: 'twice' });

    expect(seen).toHaveLength(2);
  });
});

describe('MedusaActionBindingStrategy.runAction failures', () => {
  test('runs every binding, logs each failure, then rejects once with an AggregateError of each failure, in run order', async () => {
    const first = new Error('first broke');
    const third = new Error('third broke');
    strategy.bindAction(OrderPlaced, 'order.placed', () => {
      throw first;
    });
    strategy.bindAction(OrderPlaced, 'order.placed', (data: { id: string }) => new OrderPlaced(data));
    strategy.bindAction(OrderPlaced, 'order.placed', async () => {
      throw third;
    });

    const error = await rejection(strategy.runAction('order.placed', { id: 'order_8' }));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([first, third]);
    expect((error as AggregateError).errors[0]).toBe(first);
    expect((error as AggregateError).errors[1]).toBe(third);
    expect((error as AggregateError).message).toBe("2 binding(s) failed for action 'order.placed': first broke | third broke");
    expect(seen.map((e) => (e as OrderPlaced).orderId)).toEqual(['order_8']);
    const context = { action: 'order.placed', eventId: 'shop.order-placed' };
    expect(logger.calls).toEqual([
      ['logException', first, "Action 'order.placed' failed for event 'shop.order-placed'", context, 'error'],
      ['logException', third, "Action 'order.placed' failed for event 'shop.order-placed'", context, 'error'],
    ]);
    expect(logger.calls[0][1]).toBe(first);
  });

  test('writes a thrown value that is not an Error into the AggregateError message as text', async () => {
    strategy.bindAction(OrderPlaced, 'order.placed', () => {
      throw 'plain failure';
    });

    const error = (await rejection(strategy.runAction('order.placed', { id: 'order_16' }))) as AggregateError;

    expect(error.errors).toEqual(['plain failure']);
    expect(error.message).toBe("1 binding(s) failed for action 'order.placed': plain failure");
  });

  test("passes a broadcast's rejection on unchanged inside the AggregateError", async () => {
    const listenerError = new Error('listener broke');
    events.attach(OrderPlaced, () => {
      throw listenerError;
    });
    strategy.bindAction(OrderPlaced, 'order.placed', (data: { id: string }) => new OrderPlaced(data));

    const error = (await rejection(strategy.runAction('order.placed', { id: 'order_9' }))) as AggregateError;

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(1);
    const broadcastError = error.errors[0] as AggregateError;
    expect(broadcastError).toBeInstanceOf(AggregateError);
    expect(broadcastError.errors).toEqual([listenerError]);
    expect(seen).toHaveLength(1);
  });

  test('refuses a result that is not an event or null, naming the action, and broadcasts nothing', async () => {
    strategy.bindAction(OrderPlaced, 'order.placed', (() => undefined) as never);
    strategy.bindAction(OrderPlaced, 'order.placed', (() => 'order_10') as never);

    const error = (await rejection(strategy.runAction('order.placed', { id: 'order_10' }))) as AggregateError;

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(2);
    for (const failure of error.errors) {
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).toContain('order.placed');
    }
    expect(seen).toEqual([]);
  });

  test("refuses an event whose id is not the bound event's, naming the action and both ids", async () => {
    strategy.bindAction(OrderPlaced as EventClass, 'order.placed', ((data: { id: string }) => new OrderCompleted(data.id)) as never);

    const error = (await rejection(strategy.runAction('order.placed', { id: 'order_11' }))) as AggregateError;

    expect(error.errors).toHaveLength(1);
    const failure = error.errors[0] as Error;
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure.message).toContain('order.placed');
    expect(failure.message).toContain('shop.order-placed');
    expect(failure.message).toContain('shop.order-completed');
    expect(seen).toEqual([]);
    expect(logger.calls).toEqual([
      ['logException', failure, "Action 'order.placed' failed for event 'shop.order-placed'", { action: 'order.placed', eventId: 'shop.order-placed' }, 'error'],
    ]);
  });
});

describe('MedusaActionBindingStrategy.runAction when the logger throws', () => {
  test('still resolves an action with no bindings, and writes the line to console.error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const local = new MedusaActionBindingStrategy(events, new ThrowingLogger());

    await expect(local.runAction('order.canceled', { id: 'order_7' })).resolves.toBeUndefined();

    expect(consoleError.mock.calls).toEqual([
      ["No TS Nomad binding for action 'order.canceled', and the logger threw while reporting it", { action: 'order.canceled', loggerError: ThrowingLogger.failure }],
    ]);
  });

  test('still runs every binding and rejects with the binding failures, and writes both errors to console.error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const local = new MedusaActionBindingStrategy(events, new ThrowingLogger());
    const failure = new Error('first broke');
    local.bindAction(OrderPlaced, 'order.placed', () => {
      throw failure;
    });
    local.bindAction(OrderPlaced, 'order.placed', (data: { id: string }) => new OrderPlaced(data));

    const error = (await rejection(local.runAction('order.placed', { id: 'order_15' }))) as AggregateError;

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(1);
    expect(error.errors[0]).toBe(failure);
    expect(seen).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("Action 'order.placed' failed for event 'shop.order-placed', and the logger threw while reporting it", {
      action: 'order.placed',
      eventId: 'shop.order-placed',
      error: failure,
      loggerError: ThrowingLogger.failure,
    });
  });
});

describe('MedusaActionBindingStrategy.bindAction refusals', () => {
  test('refuses an event id with no transformer, naming the action, and records nothing', async () => {
    expect(() => (strategy.bindAction as (...args: unknown[]) => void)('shop.order-placed', 'order.placed')).toThrow(TypeError);
    expect(() => (strategy.bindAction as (...args: unknown[]) => void)('shop.order-placed', 'order.placed')).toThrow(/order\.placed/);

    await strategy.runAction('order.placed', { id: 'order_12' });
    expect(seen).toEqual([]);
    expect(logger.calls).toEqual([unbound('order.placed')]);
  });

  test('refuses a class with no static id, naming the action, and records nothing', async () => {
    expect(() => strategy.bindAction(NotAnEvent as never, 'order.placed')).toThrow(TypeError);
    expect(() => strategy.bindAction(NotAnEvent as never, 'order.placed')).toThrow(/order\.placed/);

    await expect(strategy.runAction('order.placed', { id: 'order_13' })).resolves.toBeUndefined();
    expect(logger.calls).toEqual([unbound('order.placed')]);
  });

  test('refuses an action that is not a string, naming no binding', async () => {
    expect(() => strategy.bindAction(OrderPlaced, 42 as never)).toThrow(TypeError);

    await strategy.runAction(42 as never, { id: 'order_15' });
    expect(seen).toEqual([]);
  });

  test('refuses an empty action, an empty id and a transformer that is not a function', async () => {
    expect(() => strategy.bindAction(OrderPlaced, '')).toThrow(TypeError);
    expect(() => strategy.bindAction('', 'order.placed', (data: { id: string }) => new OrderPlaced(data))).toThrow(/order\.placed/);
    expect(() => strategy.bindAction(OrderPlaced, 'order.placed', 'nope' as never)).toThrow(TypeError);
    expect(() => strategy.bindAction(OrderPlaced, 'order.placed', 'nope' as never)).toThrow(/order\.placed/);

    await strategy.runAction('order.placed', { id: 'order_14' });
    expect(seen).toEqual([]);
    expect(logger.calls).toEqual([unbound('order.placed')]);
  });
});

test('declares the event strategy and the logger for autowiring', () => {
  expect(MedusaActionBindingStrategy.inject).toEqual([EventStrategy, LoggerStrategy]);
});
