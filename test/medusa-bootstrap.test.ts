/**
 * Acceptance tests for MedusaBootstrap.
 *
 * They use a fake Medusa container and the real container and loader.
 *
 * The boot tests stand in for MedusaInitializer with a spy. The adapter
 * tests resolve the strategies MedusaInitializer binds, and spy on the
 * strategy method each adapter must call. The `taskEvents()` tests, and
 * the test of the served task events, name each event with
 * `taskEventName`.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { Container } from '@tsnomad/di-container';
import type { Initializer } from '@tsnomad/loader';
import {
  MedusaActionBindingStrategy,
  MedusaBootstrap,
  MedusaContainer,
  MedusaEventBus,
  MedusaInitializer,
  MedusaLogger,
  MedusaLoggerStrategy,
  MedusaRestStrategy,
  MedusaTaskEvents,
  MedusaTaskStrategy,
} from '@tsnomad/medusa-integration';
import { ExportOrder, FakeMedusaContainer, FakeResponse, SendReport, SyncProducts, deferred, fakeMedusa, fakeRequest, rejection, tick } from './fakes.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** An initializer that records each load, and can wait on a gate first. */
class Recorder implements Initializer {
  static loads: string[] = [];
  constructor(
    private readonly name: string,
    private readonly gate?: Promise<void>,
    private readonly failure?: unknown,
  ) {}
  async load(): Promise<void> {
    if (this.gate) await this.gate;
    Recorder.loads.push(this.name);
    if (this.failure !== undefined) throw this.failure;
  }
}

function stubInitializer(order?: string[]): void {
  vi.spyOn(MedusaInitializer.prototype, 'getClassDefinitions').mockImplementation(() => {
    order?.push('medusa');
    return [];
  });
}

describe('MedusaBootstrap.boot', () => {
  test('binds the Medusa container, and its logger and event bus by their Medusa names when first asked for', async () => {
    stubInitializer();
    const { container: medusa, logger, bus } = fakeMedusa();

    const container = await new MedusaBootstrap().boot(medusa);

    expect(container).toBeInstanceOf(Container);
    expect(await container.get(MedusaContainer)).toBe(medusa);
    expect(medusa.resolved).toEqual([]);
    expect(await container.get(MedusaLogger)).toBe(logger);
    expect(medusa.resolved).toEqual(['logger']);
    expect(await container.get(MedusaEventBus)).toBe(bus);
    expect(medusa.resolved).toEqual(['logger', 'event_bus']);
  });

  test("loads MedusaInitializer first, then the application's initializers in order", async () => {
    Recorder.loads = [];
    const order: string[] = [];
    stubInitializer(order);
    vi.spyOn(Recorder.prototype, 'load').mockImplementation(async function (this: Recorder) {
      order.push((this as unknown as { name: string }).name);
    });

    await new MedusaBootstrap({ initializers: () => [new Recorder('first'), new Recorder('second')] }).boot(fakeMedusa().container);

    expect(order).toEqual(['medusa', 'first', 'second']);
  });

  test('boots once for concurrent first calls, and every caller gets the one container', async () => {
    Recorder.loads = [];
    stubInitializer();
    const gate = deferred();
    let built = 0;
    const bootstrap = new MedusaBootstrap({
      initializers: () => {
        built++;
        return [new Recorder('app', gate.promise)];
      },
    });
    const { container: medusa } = fakeMedusa();

    const calls = Array.from({ length: 10 }, () => bootstrap.boot(medusa));
    await tick();
    expect(Recorder.loads).toEqual([]);
    gate.resolve();
    const containers = await Promise.all(calls);

    expect(built).toBe(1);
    expect(Recorder.loads).toEqual(['app']);
    expect(new Set(containers).size).toBe(1);
  });

  test('returns the booted container to a later call with another Medusa container, without loading again', async () => {
    Recorder.loads = [];
    stubInitializer();
    const bootstrap = new MedusaBootstrap({ initializers: () => [new Recorder('app')] });
    const first = fakeMedusa().container;

    const booted = await bootstrap.boot(first);
    const again = await bootstrap.boot(new FakeMedusaContainer());

    expect(again).toBe(booted);
    expect(await again.get(MedusaContainer)).toBe(first);
    expect(Recorder.loads).toEqual(['app']);
  });

  test('rejects every waiting caller with a failed boot, unchanged, then boots afresh on the next call', async () => {
    Recorder.loads = [];
    stubInitializer();
    const failure = new Error('initializer broke');
    const gate = deferred();
    let attempt = 0;
    const bootstrap = new MedusaBootstrap({
      initializers: () => {
        attempt++;
        return attempt === 1 ? [new Recorder('broken', gate.promise, failure)] : [new Recorder('fixed')];
      },
    });
    const { container: medusa, logger } = fakeMedusa();

    const waiting = [bootstrap.boot(medusa), bootstrap.boot(medusa), bootstrap.boot(medusa)];
    gate.resolve();
    const errors = await Promise.all(waiting.map((call) => rejection(call)));
    expect(errors).toEqual([failure, failure, failure]);
    expect(errors.every((error) => error === failure)).toBe(true);
    expect(logger.calls).toEqual([['error', 'TS Nomad boot failed: initializer broke', failure]]);
    expect(logger.calls[0][2]).toBe(failure);

    const container = await bootstrap.boot(medusa);
    const again = await bootstrap.boot(medusa);

    expect(attempt).toBe(2);
    expect(Recorder.loads).toEqual(['broken', 'fixed']);
    expect(again).toBe(container);
  });

  test('builds a new container for the boot after a failed one', async () => {
    stubInitializer();
    const containers: Container[] = [];
    let attempt = 0;
    class Capture implements Initializer {
      setContainer(container: Container): void {
        containers.push(container);
      }
      load(): void {
        if (++attempt === 1) throw new Error('first boot fails');
      }
    }
    const bootstrap = new MedusaBootstrap({ initializers: () => [new Capture()] });
    const { container: medusa } = fakeMedusa();

    await rejection(bootstrap.boot(medusa));
    const booted = await bootstrap.boot(medusa);

    expect(containers).toHaveLength(2);
    expect(containers[0]).not.toBe(containers[1]);
    expect(booted).toBe(containers[1]);
  });

  test('writes a failed boot to console.error when the Medusa logger cannot be resolved, and still rejects with the failure', async () => {
    stubInitializer();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('initializer broke');
    const bootstrap = new MedusaBootstrap({
      initializers: () => [
        {
          load() {
            throw failure;
          },
        },
      ],
    });
    const noLogger = new FakeMedusaContainer({});

    expect(await rejection(bootstrap.boot(noLogger))).toBe(failure);

    expect(consoleError).toHaveBeenCalledTimes(1);
    const [text, detail] = consoleError.mock.calls[0] as [string, { error: unknown; loggerError: unknown }];
    expect(text).toBe('TS Nomad boot failed, and the Medusa logger threw while reporting it');
    expect(detail.error).toBe(failure);
    expect(detail.loggerError).toBeInstanceOf(Error);
  });

  test('binds MedusaTaskEvents to the names taskEvents() returned, once tasks() is built', async () => {
    stubInitializer();
    class Handler {
      handle(): void {}
    }
    // The boot loads no initializer, so it needs no task strategy. Later calls, from taskEvents(), list one task.
    let calls = 0;
    const bootstrap = new MedusaBootstrap({
      initializers: () => (calls++ === 0 ? [] : [{ getTaskHandlers: () => [[SendReport, Handler]] as const }]),
    });

    const container = await bootstrap.boot(fakeMedusa().container);
    const served = await container.get(MedusaTaskEvents);
    expect(served.has('tsnomad.task.reports.send')).toBe(false);
    bootstrap.taskEvents();
    expect(served.has('tsnomad.task.reports.send')).toBe(false);
    bootstrap.tasks();

    expect(served.has('tsnomad.task.reports.send')).toBe(true);
    expect(served.has('tsnomad.task.catalog.sync-products')).toBe(false);
  });

  test('refuses a value with no resolve function before it builds anything', async () => {
    let built = 0;
    const bootstrap = new MedusaBootstrap({
      initializers: () => {
        built++;
        return [];
      },
    });

    const error = await rejection(bootstrap.boot({} as never));

    expect(error).toBeInstanceOf(TypeError);
    expect(built).toBe(0);
  });
});

describe('MedusaBootstrap adapters', () => {
  test("subscriber() boots from the subscriber's container and runs the event's action with its data and message", async () => {
    const runAction = vi.spyOn(MedusaActionBindingStrategy.prototype, 'runAction').mockResolvedValue();
    const bootstrap = new MedusaBootstrap();
    const boot = vi.spyOn(bootstrap, 'boot');
    const { container } = fakeMedusa();
    const event = { name: 'order.placed', data: { id: 'order_1' }, metadata: { source: 'test' } };

    await bootstrap.subscriber()({ event, container, pluginOptions: {} });

    expect(boot).toHaveBeenCalledWith(container);
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenCalledWith('order.placed', { id: 'order_1' }, event);
    expect(runAction.mock.contexts[0]).toBeInstanceOf(MedusaActionBindingStrategy);
  });

  test('subscriber() rejects with a failure from the bindings, unchanged, after one run', async () => {
    const failure = new AggregateError([new Error('x')], 'bindings failed');
    const runAction = vi.spyOn(MedusaActionBindingStrategy.prototype, 'runAction').mockRejectedValue(failure);
    const { container } = fakeMedusa();

    await expect(new MedusaBootstrap().subscriber()({ event: { name: 'order.placed', data: {} }, container })).rejects.toBe(failure);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  test('job() boots from the job container and awaits the run with the booted container', async () => {
    const bootstrap = new MedusaBootstrap();
    const { container: medusa } = fakeMedusa();
    const seen: Container[] = [];
    const gate = deferred();
    let finished = false;

    let settled = false;
    const run = bootstrap
      .job(async (container) => {
        seen.push(container);
        await gate.promise;
        finished = true;
      })(medusa)
      .then(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await tick();
    expect(settled).toBe(false);
    gate.resolve();
    await run;

    expect(finished).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(await bootstrap.boot(medusa));
  });

  test("job() logs the run's failure through the logger strategy, then rejects with it unchanged, after one run", async () => {
    const logException = vi.spyOn(MedusaLoggerStrategy.prototype, 'logException').mockImplementation(() => {});
    const failure = new Error('job broke');
    let runs = 0;

    await expect(
      new MedusaBootstrap().job(() => {
        runs++;
        throw failure;
      })(fakeMedusa().container),
    ).rejects.toBe(failure);
    expect(runs).toBe(1);
    expect(logException).toHaveBeenCalledTimes(1);
    expect(logException).toHaveBeenCalledWith(failure, 'Scheduled job failed', {}, 'error');
  });

  test("job() writes the run's failure to console.error when the logger throws, and still rejects with it", async () => {
    const loggerError = new Error('logger broke');
    vi.spyOn(MedusaLoggerStrategy.prototype, 'logException').mockImplementation(() => {
      throw loggerError;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('job broke');

    await expect(
      new MedusaBootstrap().job(() => {
        throw failure;
      })(fakeMedusa().container),
    ).rejects.toBe(failure);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('Scheduled job failed, and the logger threw while reporting it', { error: failure, loggerError });
  });

  test("route() boots from the request's scope and hands the request and response to MedusaRestStrategy", async () => {
    const handle = vi.spyOn(MedusaRestStrategy.prototype, 'handle').mockResolvedValue();
    const bootstrap = new MedusaBootstrap();
    const boot = vi.spyOn(bootstrap, 'boot');
    const scope = fakeMedusa().container;
    const req = fakeRequest({ scope, path: '/admin/reviews' });
    const res = new FakeResponse();

    await bootstrap.route()(req, res);

    expect(boot).toHaveBeenCalledWith(scope);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0][0]).toBe(req);
    expect(handle.mock.calls[0][1]).toBe(res);
    expect(handle.mock.contexts[0]).toBeInstanceOf(MedusaRestStrategy);
  });

  test('route() rejects with a failed boot, unchanged, so Medusa responds to it', async () => {
    const failure = new Error('boot broke');
    const bootstrap = new MedusaBootstrap({
      initializers: () => [
        {
          load() {
            throw failure;
          },
        },
      ],
    });

    await expect(bootstrap.route()(fakeRequest({ scope: fakeMedusa().container }), new FakeResponse())).rejects.toBe(failure);
  });

  test('subscriber(), job() and tasks() reject with a failed boot, unchanged, and run nothing', async () => {
    const failure = new Error('boot broke');
    const runAction = vi.spyOn(MedusaActionBindingStrategy.prototype, 'runAction').mockResolvedValue();
    const deliver = vi.spyOn(MedusaTaskStrategy.prototype, 'deliver').mockResolvedValue();
    const bootstrap = new MedusaBootstrap({
      initializers: () => [
        {
          load() {
            throw failure;
          },
        },
      ],
    });
    const { container } = fakeMedusa();
    let ran = false;

    await expect(bootstrap.subscriber()({ event: { name: 'order.placed', data: {} }, container })).rejects.toBe(failure);
    await expect(
      bootstrap.job(() => {
        ran = true;
      })(container),
    ).rejects.toBe(failure);
    await expect(bootstrap.tasks()({ event: { name: 'tsnomad.task.reports.send', data: { payload: {} } }, container })).rejects.toBe(failure);

    expect(ran).toBe(false);
    expect(runAction).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  test("tasks() boots from the subscriber's container and hands the event to MedusaTaskStrategy", async () => {
    const deliver = vi.spyOn(MedusaTaskStrategy.prototype, 'deliver').mockResolvedValue();
    const bootstrap = new MedusaBootstrap();
    const boot = vi.spyOn(bootstrap, 'boot');
    const { container } = fakeMedusa();
    const event = { name: 'tsnomad.task.reports.send', data: { payload: { name: 'daily' } } };

    await bootstrap.tasks()({ event, container, pluginOptions: {} });

    expect(boot).toHaveBeenCalledWith(container);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe(event);
    expect(deliver.mock.contexts[0]).toBeInstanceOf(MedusaTaskStrategy);
  });

  test('tasks() rejects with a failed delivery, unchanged, after one run', async () => {
    const failure = new Error('handler broke');
    const deliver = vi.spyOn(MedusaTaskStrategy.prototype, 'deliver').mockRejectedValue(failure);

    await expect(new MedusaBootstrap().tasks()({ event: { name: 'tsnomad.task.x', data: {} }, container: fakeMedusa().container })).rejects.toBe(failure);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('MedusaBootstrap.taskEvents', () => {
  class Handler {
    handle(): void {}
  }

  test("returns each task class's bus event once, in initializer and list order, without booting", () => {
    let built = 0;
    const bootstrap = new MedusaBootstrap({
      initializers: () => {
        built++;
        return [
          { getTaskHandlers: () => [[SyncProducts, Handler], [SendReport, [Handler, Handler]]] as const },
          { load() {} },
          { getTaskHandlers: () => [[ExportOrder, Handler], [SyncProducts, Handler]] as const },
        ];
      },
    });
    const boot = vi.spyOn(bootstrap, 'boot');

    expect(bootstrap.taskEvents()).toEqual(['tsnomad.task.catalog.sync-products', 'tsnomad.task.reports.send', 'tsnomad.task.orders.export']);
    expect(built).toBe(1);
    expect(boot).not.toHaveBeenCalled();
  });

  test('returns an empty list when no initializer has task handlers', () => {
    expect(new MedusaBootstrap().taskEvents()).toEqual([]);
    expect(new MedusaBootstrap({ initializers: () => [{ load() {} }] }).taskEvents()).toEqual([]);
  });

  test('refuses a task class with no static id', () => {
    class NoId {}
    const bootstrap = new MedusaBootstrap({ initializers: () => [{ getTaskHandlers: () => [[NoId as never, Handler]] as const }] });

    expect(() => bootstrap.taskEvents()).toThrow(TypeError);
  });
});
