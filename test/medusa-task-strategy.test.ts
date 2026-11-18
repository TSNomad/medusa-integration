/**
 * Acceptance tests for MedusaTaskStrategy and taskEventName.
 *
 * The event bus is a fake that holds each emitted event. A test delivers
 * it the way a subscriber file would, by handing a copy that went through
 * JSON to `deliver`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LoggerStrategy } from '@tsnomad/logger';
import { TaskDispatchFailedException } from '@tsnomad/tasks';
import { MedusaEventBus, MedusaTaskEvents, MedusaTaskStrategy, TASK_EVENT_PREFIX, taskEventName } from '@tsnomad/medusa-integration';
import type { MedusaEventMessage } from '@tsnomad/medusa-integration';
import {
  BigIntTask,
  ExportOrder,
  FakeEventBus,
  ListPayload,
  NotAnEvent,
  RecordingLogger,
  SendReport,
  SyncProducts,
  BrokenRebuild,
  ThrowingLogger,
  Unbuildable,
  rejection,
  servedTaskEvents,
} from './fakes.js';

let bus: FakeEventBus;
let logger: RecordingLogger;
let strategy: MedusaTaskStrategy;

/** Delivers everything emitted so far, in order, as a subscriber file would. */
async function deliverAll(): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = [];
  for (const message of bus.drain()) {
    results.push((await Promise.allSettled([strategy.deliver(message)]))[0]);
  }
  return results;
}

beforeEach(() => {
  bus = new FakeEventBus();
  logger = new RecordingLogger();
  strategy = new MedusaTaskStrategy(bus, logger, servedTaskEvents());
  SyncProducts.rebuilt = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('taskEventName', () => {
  test("returns the prefix plus the task class's id", () => {
    expect(TASK_EVENT_PREFIX).toBe('tsnomad.task.');
    expect(taskEventName(SyncProducts)).toBe('tsnomad.task.catalog.sync-products');
    expect(taskEventName(SendReport)).toBe('tsnomad.task.reports.send');
  });

  test('refuses a class with no static id', () => {
    expect(() => taskEventName(NotAnEvent as never)).toThrow(TypeError);
  });
});

describe('MedusaTaskStrategy.attach', () => {
  test('refuses a class with no static id or a handler that is not a function, and attaches nothing', async () => {
    expect(() => strategy.attach(NotAnEvent as never, () => {})).toThrow(TypeError);
    expect(() => strategy.attach(SyncProducts, 'nope' as never)).toThrow(TypeError);

    expect(await rejection(strategy.dispatch(new SyncProducts('c')))).toBeInstanceOf(TaskDispatchFailedException);
    expect(bus.emitted).toEqual([]);
    expect(logger.calls).toEqual([]);
  });
});

describe('MedusaTaskStrategy.dispatch', () => {
  test("emits the task's event with its payload after a trip through JSON, and runs nothing yet", async () => {
    const seen: SyncProducts[] = [];
    strategy.attach(SyncProducts, (task) => {
      seen.push(task);
    });

    await strategy.dispatch(new SyncProducts('cursor-1', new Date('2026-11-12T00:00:00.000Z')));

    expect(bus.emitted).toEqual([
      { name: 'tsnomad.task.catalog.sync-products', data: { payload: { cursor: 'cursor-1', at: '2026-11-12T00:00:00.000Z' } } },
    ]);
    expect(bus.emitCalls).toHaveLength(1);
    expect(bus.emitCalls[0]).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  test('refuses a task whose event no task subscriber file serves, emitting nothing', async () => {
    const served = servedTaskEvents();
    served.delete('tsnomad.task.reports.send');
    const unserved = new MedusaTaskStrategy(bus, logger, served);
    unserved.attach(SendReport, () => {});

    const error = await rejection(unserved.dispatch(new SendReport('daily')));

    expect(error).toBeInstanceOf(TaskDispatchFailedException);
    expect((error as Error).message).toContain('reports.send');
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(((error as Error).cause as Error).message).toContain('tsnomad.task.reports.send');
    expect(bus.emitted).toEqual([]);
  });

  test('refuses a task no handler is attached for, emitting nothing', async () => {
    strategy.attach(SendReport, () => {});

    const error = await rejection(strategy.dispatch(new SyncProducts('c')));

    expect(error).toBeInstanceOf(TaskDispatchFailedException);
    expect((error as Error).message).toContain('catalog.sync-products');
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(bus.emitted).toEqual([]);
  });

  test('refuses a value that is not a task, with a TypeError as cause', async () => {
    const error = await rejection(strategy.dispatch({ toPayload: 'no' } as never));

    expect(error).toBeInstanceOf(TaskDispatchFailedException);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(bus.emitted).toEqual([]);
  });

  test('refuses a task whose class has an id but no toPayload method, naming that cause', async () => {
    class NoPayload {
      static getId(): string {
        return 'tasks.no-payload';
      }
      static fromPayload(): NoPayload {
        return new NoPayload();
      }
    }
    const local = new MedusaTaskStrategy(bus, logger, new Set(['tsnomad.task.tasks.no-payload']));
    local.attach(NoPayload as never, () => {});

    const error = await rejection(local.dispatch(new NoPayload() as never));

    expect(error).toBeInstanceOf(TaskDispatchFailedException);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(((error as Error).cause as Error).message).toBe("task 'tasks.no-payload' has no toPayload method");
    expect(bus.emitted).toEqual([]);
  });

  test('refuses a payload JSON cannot carry, with the JSON error as cause', async () => {
    strategy.attach(BigIntTask, () => {});

    const error = await rejection(strategy.dispatch(new BigIntTask()));

    expect(error).toBeInstanceOf(TaskDispatchFailedException);
    expect((error as Error).message).toContain('numbers.big');
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(bus.emitted).toEqual([]);
  });

  test('refuses a payload that is not a plain object, with a TypeError as cause', async () => {
    strategy.attach(ListPayload, () => {});

    const error = await rejection(strategy.dispatch(new ListPayload()));

    expect(error).toBeInstanceOf(TaskDispatchFailedException);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(bus.emitted).toEqual([]);
  });

  test('refuses a payload that is an object of another class, such as a Map, with a TypeError as cause', async () => {
    class MapPayload {
      static getId(): string {
        return 'tasks.map-payload';
      }
      static fromPayload(): MapPayload {
        return new MapPayload();
      }
      toPayload(): never {
        return new Map([['a', 1]]) as never;
      }
    }
    const local = new MedusaTaskStrategy(bus, logger, new Set(['tsnomad.task.tasks.map-payload']));
    local.attach(MapPayload as never, () => {});

    const error = await rejection(local.dispatch(new MapPayload() as never));

    expect(error).toBeInstanceOf(TaskDispatchFailedException);
    expect(((error as Error).cause as Error).message).toBe("the payload of task 'tasks.map-payload' is not a plain object");
    expect(bus.emitted).toEqual([]);
  });

  test('refuses a task its class cannot rebuild, with the fromPayload error as cause', async () => {
    strategy.attach(Unbuildable, () => {});

    const error = await rejection(strategy.dispatch(new Unbuildable()));

    expect(error).toBeInstanceOf(TaskDispatchFailedException);
    expect((error as Error).cause).toBe(Unbuildable.failure);
    expect(bus.emitted).toEqual([]);
  });

  test('rejects with the emit failure as cause when the bus refuses the event', async () => {
    strategy.attach(SyncProducts, () => {});
    const busDown = new Error('redis down');
    bus.failNextEmit = busDown;

    const error = await rejection(strategy.dispatch(new SyncProducts('c')));

    expect(error).toBeInstanceOf(TaskDispatchFailedException);
    expect((error as Error).message).toContain('catalog.sync-products');
    expect((error as Error).cause).toBe(busDown);
  });
});

describe('MedusaTaskStrategy.deliver', () => {
  test('runs the handlers in attach order, one at a time, with one task rebuilt from the payload', async () => {
    const log: string[] = [];
    const tasks: SyncProducts[] = [];
    for (const name of ['first', 'second']) {
      strategy.attach(SyncProducts, async (task) => {
        tasks.push(task);
        log.push(`${name} start`);
        await new Promise((resolve) => setImmediate(resolve));
        log.push(`${name} end`);
      });
    }
    const original = new SyncProducts('cursor-2');
    await strategy.dispatch(original);
    SyncProducts.rebuilt = 0;

    const results = await deliverAll();

    expect(results.map((r) => r.status)).toEqual(['fulfilled']);
    expect(log).toEqual(['first start', 'first end', 'second start', 'second end']);
    expect(tasks[0]).toBe(tasks[1]);
    expect(tasks[0]).not.toBe(original);
    expect(tasks[0]).toBeInstanceOf(SyncProducts);
    expect(tasks[0].cursor).toBe('cursor-2');
    expect(SyncProducts.rebuilt).toBe(1);
    expect(logger.calls).toEqual([]);
  });

  test('runs a handler attached during a delivery from the next task on, not in that delivery', async () => {
    const ran: string[] = [];
    strategy.attach(SyncProducts, () => {
      ran.push('first');
      if (ran.length === 1) {
        strategy.attach(SyncProducts, () => {
          ran.push('late');
        });
      }
    });

    await strategy.deliver({ name: 'tsnomad.task.catalog.sync-products', data: { payload: { cursor: 'a' } } });
    expect(ran).toEqual(['first']);

    await strategy.deliver({ name: 'tsnomad.task.catalog.sync-products', data: { payload: { cursor: 'b' } } });
    expect(ran).toEqual(['first', 'first', 'late']);
  });

  test('stops at the first failing handler, logs it once at error level, and rejects the delivery with it', async () => {
    const failure = new Error('handler broke');
    const ran: string[] = [];
    strategy.attach(SyncProducts, () => {
      ran.push('first');
      throw failure;
    });
    strategy.attach(SyncProducts, () => {
      ran.push('second');
    });
    await strategy.dispatch(new SyncProducts('c'));

    const results = await deliverAll();

    expect(ran).toEqual(['first']);
    expect(results).toEqual([{ status: 'rejected', reason: failure }]);
    expect((results[0] as PromiseRejectedResult).reason).toBe(failure);
    expect(logger.calls).toEqual([
      ['logException', failure, "Task 'catalog.sync-products' failed", { task: 'catalog.sync-products', payload: { cursor: 'c' } }, 'error'],
    ]);
  });

  test('adds the idempotency key to the failure context for a task that names its work', async () => {
    const failure = new Error('export broke');
    strategy.attach(ExportOrder, () => {
      throw failure;
    });
    await strategy.dispatch(new ExportOrder('order_1'));

    await deliverAll();

    expect(logger.calls).toEqual([
      [
        'logException',
        failure,
        "Task 'orders.export' failed",
        { task: 'orders.export', payload: { order: 'order_1' }, idempotencyKey: 'orders.export:order_1' },
        'error',
      ],
    ]);
  });

  test('reads the idempotency key only to report a failure, and a key that throws there goes to console.error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const keyFailure = new Error('key broke');
    const handlerFailure = new Error('export broke');
    class KeyBroken extends ExportOrder {
      static getId(): string {
        return 'orders.key-broken';
      }
      static fromPayload(payload: { order?: unknown }): KeyBroken {
        return new KeyBroken(String(payload.order));
      }
      idempotencyKey(): string {
        throw keyFailure;
      }
    }
    const ran: string[] = [];
    strategy.attach(KeyBroken, () => {
      ran.push('first');
    });

    await strategy.deliver({ name: 'tsnomad.task.orders.key-broken', data: { payload: { order: 'order_1' } } });

    expect(ran).toEqual(['first']);
    expect(consoleError).not.toHaveBeenCalled();

    strategy.attach(KeyBroken, () => {
      ran.push('second');
      throw handlerFailure;
    });

    const error = await rejection(strategy.deliver({ name: 'tsnomad.task.orders.key-broken', data: { payload: { order: 'order_2' } } }));

    expect(error).toBe(handlerFailure);
    expect(ran).toEqual(['first', 'first', 'second']);
    expect(logger.calls).toEqual([]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("Task 'orders.key-broken' failed, and the logger threw while reporting it", {
      task: 'orders.key-broken',
      payload: { order: 'order_2' },
      error: handlerFailure,
      loggerError: keyFailure,
    });
  });

  test('logs a payload its class cannot rebuild with the payload, runs no handler, and resolves the delivery', async () => {
    const ran: string[] = [];
    strategy.attach(SyncProducts, () => {
      ran.push('handler');
    });

    await strategy.deliver({ name: 'tsnomad.task.catalog.sync-products', data: { payload: { cursor: 7 } } });

    expect(ran).toEqual([]);
    expect(logger.calls).toHaveLength(1);
    const [method, error, message, context, level] = logger.calls[0];
    expect(method).toBe('logException');
    expect((error as Error).message).toBe('cursor must be a string');
    expect(message).toBe("Task 'catalog.sync-products' could not be rebuilt");
    expect(context).toEqual({ task: 'catalog.sync-products', payload: { cursor: 7 } });
    expect(level).toBe('error');
  });

  test('logs and drops a payload whose class throws a plain Error while it rebuilds, as for a task exception', async () => {
    strategy.attach(BrokenRebuild, () => {});

    await strategy.deliver({ name: 'tsnomad.task.tasks.broken-rebuild', data: { payload: { at: 1 } } });

    expect(logger.calls).toEqual([
      ['logException', BrokenRebuild.failure, "Task 'tasks.broken-rebuild' could not be rebuilt", { task: 'tasks.broken-rebuild', payload: { at: 1 } }, 'error'],
    ]);
  });

  test('runs a task as often as it was dispatched, a task that names its work included', async () => {
    const seen: string[] = [];
    strategy.attach(SendReport, (task) => {
      seen.push(task.name);
    });
    strategy.attach(ExportOrder, (task) => {
      seen.push(task.order);
    });
    await strategy.dispatch(new SendReport('daily'));
    await strategy.dispatch(new SendReport('daily'));
    await strategy.dispatch(new ExportOrder('order_1'));
    await strategy.dispatch(new ExportOrder('order_1'));

    await deliverAll();

    expect(seen).toEqual(['daily', 'daily', 'order_1', 'order_1']);
  });

  test('logs an event that is not a task event, or a task with no handler in this process, runs nothing, and resolves', async () => {
    strategy.attach(SendReport, () => {});
    const notTask: MedusaEventMessage = { name: 'order.placed', data: { payload: {} } };
    const noHandler: MedusaEventMessage = { name: 'tsnomad.task.catalog.sync-products', data: { payload: { cursor: 'c' } } };

    await strategy.deliver(notTask);
    await strategy.deliver(noHandler);

    expect(SyncProducts.rebuilt).toBe(0);
    expect(logger.calls).toEqual([
      ['error', "'order.placed' is not a task event", { event: 'order.placed' }],
      [
        'error',
        "No handler is attached for task 'catalog.sync-products' in this process",
        { event: 'tsnomad.task.catalog.sync-products', payload: { cursor: 'c' } },
      ],
    ]);
  });

  test('still resolves an event it cannot run when the logger throws, and writes each line to console.error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const local = new MedusaTaskStrategy(bus, new ThrowingLogger(), servedTaskEvents());

    await local.deliver({ name: 'order.placed', data: { payload: {} } });
    await local.deliver({ name: 'tsnomad.task.catalog.sync-products', data: { payload: { cursor: 'c' } } });

    expect(consoleError.mock.calls).toEqual([
      ["'order.placed' is not a task event, and the logger threw while reporting it", { event: 'order.placed', loggerError: ThrowingLogger.failure }],
      [
        "No handler is attached for task 'catalog.sync-products' in this process, and the logger threw while reporting it",
        { event: 'tsnomad.task.catalog.sync-products', payload: { cursor: 'c' }, loggerError: ThrowingLogger.failure },
      ],
    ]);
  });

  test("still rejects with the handler's error when the logger throws, and writes both errors to console.error", async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = new ThrowingLogger();
    const local = new MedusaTaskStrategy(bus, throwing, servedTaskEvents());
    const failure = new Error('handler broke');
    local.attach(SyncProducts, () => {
      throw failure;
    });

    const error = await rejection(local.deliver({ name: 'tsnomad.task.catalog.sync-products', data: { payload: { cursor: 'c' } } }));

    expect(error).toBe(failure);
    expect(throwing.calls).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("Task 'catalog.sync-products' failed, and the logger threw while reporting it", {
      task: 'catalog.sync-products',
      payload: { cursor: 'c' },
      error: failure,
      loggerError: ThrowingLogger.failure,
    });
  });

  test('still resolves a payload it cannot rebuild when the logger throws, and writes both errors to console.error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const local = new MedusaTaskStrategy(bus, new ThrowingLogger(), servedTaskEvents());
    local.attach(Unbuildable, () => {});

    await local.deliver({ name: 'tsnomad.task.tasks.unbuildable', data: { payload: { at: 2 } } });

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("Task 'tasks.unbuildable' could not be rebuilt, and the logger threw while reporting it", {
      task: 'tasks.unbuildable',
      payload: { at: 2 },
      error: Unbuildable.failure,
      loggerError: ThrowingLogger.failure,
    });
  });
});

test('declares the event bus, the logger and the served task events for autowiring', () => {
  expect(MedusaTaskStrategy.inject).toEqual([MedusaEventBus, LoggerStrategy, MedusaTaskEvents]);
});
