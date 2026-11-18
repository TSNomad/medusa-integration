/**
 * Acceptance tests for MedusaTaskStrategy with an IdempotencyStore. The
 * bus is the fake that holds each emitted event, and the store is a small
 * in-memory one that keeps every call, so a test reads the order the
 * strategy used it in.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { IdempotencyStore, IsIdempotent } from '@tsnomad/tasks';
import { MedusaTaskStrategy } from '@tsnomad/medusa-integration';
import { ExportOrder, FakeEventBus, RecordingLogger, SyncProducts, servedTaskEvents } from './fakes.js';

/** An in-memory store that records each call as `<method> <key>`. */
class RecordingStore implements IdempotencyStore {
  readonly calls: string[] = [];
  readonly done = new Set<string>();
  readonly locks = new Map<string, string>();
  next = 1;
  /** A method name that rejects with `failure` when called. */
  failOn: string | null = null;
  readonly failure = new Error('the store is down');

  protected fail(method: string): void {
    if (this.failOn === method) throw this.failure;
  }

  async isDone(task: IsIdempotent): Promise<boolean> {
    this.calls.push(`isDone ${task.idempotencyKey()}`);
    this.fail('isDone');
    return this.done.has(task.idempotencyKey());
  }

  async acquire(task: IsIdempotent, ttl: number): Promise<string | null> {
    this.calls.push(`acquire ${task.idempotencyKey()} ${ttl}`);
    this.fail('acquire');
    if (this.locks.has(task.idempotencyKey())) return null;
    const token = `t${this.next++}`;
    this.locks.set(task.idempotencyKey(), token);
    return token;
  }

  async markDone(task: IsIdempotent, token: string, ttl: number): Promise<void> {
    this.calls.push(`markDone ${task.idempotencyKey()} ${token} ${ttl}`);
    this.fail('markDone');
    this.done.add(task.idempotencyKey());
    if (this.locks.get(task.idempotencyKey()) === token) this.locks.delete(task.idempotencyKey());
  }

  async release(task: IsIdempotent, token: string): Promise<void> {
    this.calls.push(`release ${task.idempotencyKey()} ${token}`);
    this.fail('release');
    if (this.locks.get(task.idempotencyKey()) === token) this.locks.delete(task.idempotencyKey());
  }
}

let bus: FakeEventBus;
let logger: RecordingLogger;
let store: RecordingStore;
let strategy: MedusaTaskStrategy;

/** Dispatches the task and delivers what the bus took, as a subscriber file would. */
async function run(task: ExportOrder | SyncProducts): Promise<PromiseSettledResult<void>> {
  await strategy.dispatch(task);
  const [message] = bus.drain();
  return (await Promise.allSettled([strategy.deliver(message)]))[0];
}

const KEY = 'orders.export:o-1';
const CTX = { task: 'orders.export', idempotencyKey: KEY };

beforeEach(() => {
  bus = new FakeEventBus();
  logger = new RecordingLogger();
  store = new RecordingStore();
  strategy = new MedusaTaskStrategy(bus, logger, servedTaskEvents());
  strategy.useIdempotencyStore(store);
});

describe('MedusaTaskStrategy with an IdempotencyStore', () => {
  test('runs a keyed task once: checks, locks, checks again, runs, and marks it done with its own TTL', async () => {
    const ran: string[] = [];
    strategy.attach(ExportOrder, (task) => void ran.push(task.order));
    expect((await run(new ExportOrder('o-1'))).status).toBe('fulfilled');
    expect(ran).toEqual(['o-1']);
    expect(store.calls).toEqual([`isDone ${KEY}`, `acquire ${KEY} 600`, `isDone ${KEY}`, `markDone ${KEY} t1 60`]);
    expect(MedusaTaskStrategy.LOCK_TTL_SECONDS).toBe(600);
    expect(logger.calls).toEqual([]);
  });

  test('skips a task whose key is done, with a debug line, and runs nothing', async () => {
    const ran: string[] = [];
    strategy.attach(ExportOrder, (task) => void ran.push(task.order));
    store.done.add(KEY);
    expect((await run(new ExportOrder('o-1'))).status).toBe('fulfilled');
    expect(ran).toEqual([]);
    expect(store.calls).toEqual([`isDone ${KEY}`]);
    expect(logger.calls).toEqual([['debug', "Task 'orders.export' was skipped: its idempotency key is already done", CTX]]);
  });

  test('skips a task another run holds, with a debug line, and runs nothing', async () => {
    const ran: string[] = [];
    strategy.attach(ExportOrder, (task) => void ran.push(task.order));
    store.locks.set(KEY, 'other');
    expect((await run(new ExportOrder('o-1'))).status).toBe('fulfilled');
    expect(ran).toEqual([]);
    expect(store.calls).toEqual([`isDone ${KEY}`, `acquire ${KEY} 600`]);
    expect(logger.calls).toEqual([['debug', "Task 'orders.export' was skipped: another run holds its idempotency key", CTX]]);
  });

  test('a key that finished between the check and the lock is released and skipped', async () => {
    const ran: string[] = [];
    strategy.attach(ExportOrder, (task) => void ran.push(task.order));
    const original = store.acquire.bind(store);
    store.acquire = async (task, ttl) => {
      const token = await original(task, ttl);
      store.done.add(task.idempotencyKey());
      return token;
    };
    expect((await run(new ExportOrder('o-1'))).status).toBe('fulfilled');
    expect(ran).toEqual([]);
    expect(store.calls).toEqual([`isDone ${KEY}`, `acquire ${KEY} 600`, `isDone ${KEY}`, `release ${KEY} t1`]);
    expect(logger.calls).toEqual([['debug', "Task 'orders.export' was skipped: its idempotency key is already done", CTX]]);
  });

  test('the same task delivered twice runs once, one after the other or both at once', async () => {
    let runs = 0;
    let finish: () => void = () => {};
    strategy.attach(ExportOrder, async () => {
      runs += 1;
      await new Promise<void>((resolve) => (finish = resolve));
    });
    await strategy.dispatch(new ExportOrder('o-1'));
    await strategy.dispatch(new ExportOrder('o-1'));
    const [first, second] = bus.drain();
    const both = Promise.allSettled([strategy.deliver(first), strategy.deliver(second)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish();
    expect((await both).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(runs).toBe(1);
    await strategy.dispatch(new ExportOrder('o-1'));
    expect((await Promise.allSettled([strategy.deliver(bus.drain()[0])]))[0].status).toBe('fulfilled');
    expect(runs).toBe(1);
  });

  test('a store that rejects on the second check releases the lock first, so a retry can run', async () => {
    let runs = 0;
    strategy.attach(ExportOrder, () => void (runs += 1));
    const original = store.isDone.bind(store);
    let checks = 0;
    store.isDone = async (task) => {
      checks += 1;
      if (checks === 2) throw store.failure;
      return original(task);
    };
    expect(await run(new ExportOrder('o-1'))).toEqual({ status: 'rejected', reason: store.failure });
    expect(runs).toBe(0);
    expect(store.calls).toEqual([`isDone ${KEY}`, `acquire ${KEY} 600`, `release ${KEY} t1`]);
    expect(store.locks.size).toBe(0);
    expect(logger.calls).toEqual([['logException', store.failure, "Task 'orders.export' could not check its idempotency key", CTX, 'error']]);
    expect((await run(new ExportOrder('o-1'))).status).toBe('fulfilled');
    expect(runs).toBe(1);
  });

  test('a release that rejects on the skip or the failed second check is logged, and the delivery keeps its own outcome', async () => {
    let runs = 0;
    strategy.attach(ExportOrder, () => void (runs += 1));
    const releaseLine = (ctx: unknown) => ['logException', store.failure, "Task 'orders.export' failed, and its idempotency lock could not be released", ctx, 'error'];
    store.failOn = 'release';
    // The key finished between the check and the lock: the skip still resolves.
    const acquire = store.acquire.bind(store);
    store.acquire = async (task, ttl) => {
      const token = await acquire(task, ttl);
      store.done.add(task.idempotencyKey());
      return token;
    };
    expect((await run(new ExportOrder('o-1'))).status).toBe('fulfilled');
    expect(logger.calls).toEqual([releaseLine(CTX), ['debug', "Task 'orders.export' was skipped: its idempotency key is already done", CTX]]);
    // The second check rejects: its own error still rejects, after both lines.
    store.acquire = acquire;
    logger.calls.length = 0;
    const checkFailure = new Error('the second check failed');
    const isDone = store.isDone.bind(store);
    let checks = 0;
    store.isDone = async (task) => {
      checks += 1;
      if (checks === 2) throw checkFailure;
      return isDone(task);
    };
    const ctx2 = { task: 'orders.export', idempotencyKey: 'orders.export:o-2' };
    expect(await run(new ExportOrder('o-2'))).toEqual({ status: 'rejected', reason: checkFailure });
    expect(logger.calls).toEqual([['logException', checkFailure, "Task 'orders.export' could not check its idempotency key", ctx2, 'error'], releaseLine(ctx2)]);
    expect(runs).toBe(0);
  });

  test('a handler that throws releases the lock and rejects with its own error, so a retry can run', async () => {
    const failure = new Error('The service is down');
    let tries = 0;
    strategy.attach(ExportOrder, () => {
      tries += 1;
      if (tries === 1) throw failure;
    });
    const first = await run(new ExportOrder('o-1'));
    expect(first).toEqual({ status: 'rejected', reason: failure });
    expect(store.calls.slice(-1)).toEqual([`release ${KEY} t1`]);
    expect(store.locks.size).toBe(0);
    expect((await run(new ExportOrder('o-1'))).status).toBe('fulfilled');
    expect(tries).toBe(2);
    expect(store.done.has(KEY)).toBe(true);
  });

  test('a release that rejects after a failed handler is logged beside it, and the handler\'s error still rejects', async () => {
    const failure = new Error('The service is down');
    strategy.attach(ExportOrder, () => {
      throw failure;
    });
    store.failOn = 'release';
    expect(await run(new ExportOrder('o-1'))).toEqual({ status: 'rejected', reason: failure });
    expect(logger.calls).toContainEqual(['logException', store.failure, "Task 'orders.export' failed, and its idempotency lock could not be released", CTX, 'error']);
    expect(store.done.has(KEY)).toBe(false);
  });

  test('a markDone that rejects is logged at error and the delivery still resolves', async () => {
    let runs = 0;
    strategy.attach(ExportOrder, () => void (runs += 1));
    store.failOn = 'markDone';
    expect((await run(new ExportOrder('o-1'))).status).toBe('fulfilled');
    expect(runs).toBe(1);
    expect(logger.calls).toEqual([['logException', store.failure, "Task 'orders.export' ran, but its idempotency key could not be marked done", CTX, 'error']]);
  });

  test('a store that rejects while checking runs nothing, logs, and rejects with the store\'s error', async () => {
    for (const method of ['isDone', 'acquire']) {
      let runs = 0;
      strategy.attach(ExportOrder, () => void (runs += 1));
      store.failOn = method;
      logger.calls.length = 0;
      expect(await run(new ExportOrder('o-1'))).toEqual({ status: 'rejected', reason: store.failure });
      expect(runs).toBe(0);
      expect(logger.calls).toEqual([['logException', store.failure, "Task 'orders.export' could not check its idempotency key", CTX, 'error']]);
    }
  });

  test('a task whose idempotencyKey() throws is reported as a failure, runs nothing, never touches the store, and rejects', async () => {
    const keyError = new Error('the key cannot be read');
    class UnreadableKey extends ExportOrder {
      static fromPayload(payload: { order?: unknown }): UnreadableKey {
        return new UnreadableKey(String(payload.order));
      }
      idempotencyKey(): string {
        throw keyError;
      }
    }
    let runs = 0;
    strategy.attach(UnreadableKey, () => void (runs += 1));
    const console = vi.spyOn(globalThis.console, 'error').mockImplementation(() => {});
    try {
      expect(await run(new UnreadableKey('o-1'))).toEqual({ status: 'rejected', reason: keyError });
      expect(runs).toBe(0);
      expect(store.calls).toEqual([]);
      expect(logger.calls).toEqual([]);
      expect(console.mock.calls).toEqual([
        ["Task 'orders.export' failed, and the logger threw while reporting it", { task: 'orders.export', payload: { order: 'o-1' }, error: keyError, loggerError: keyError }],
      ]);
    } finally {
      console.mockRestore();
    }
  });

  test('a task without a key never touches the store (a guard, runs now)', async () => {
    let runs = 0;
    strategy.attach(SyncProducts, () => void (runs += 1));
    await run(new SyncProducts('c'));
    await run(new SyncProducts('c'));
    expect(runs).toBe(2);
    expect(store.calls).toEqual([]);
  });

  test('useIdempotencyStore(null) removes the store (a guard, runs now)', async () => {
    let runs = 0;
    strategy.attach(ExportOrder, () => void (runs += 1));
    strategy.useIdempotencyStore(null);
    await run(new ExportOrder('o-1'));
    await run(new ExportOrder('o-1'));
    expect(runs).toBe(2);
    expect(store.calls).toEqual([]);
  });

  test('with no store set, a keyed task runs every time it is delivered (runs now)', async () => {
    const plain = new MedusaTaskStrategy(bus, logger, servedTaskEvents());
    let runs = 0;
    plain.attach(ExportOrder, () => void (runs += 1));
    await plain.dispatch(new ExportOrder('o-1'));
    await plain.dispatch(new ExportOrder('o-1'));
    for (const message of bus.drain()) await plain.deliver(message);
    expect(runs).toBe(2);
  });
});
