/**
 * Integration tests for the whole package.
 *
 * They use real wiring: a real MedusaBootstrap, container, loader,
 * MedusaInitializer, every strategy and the real RestLifecycle, with only
 * Medusa replaced by a fake app container, logger and event bus. An
 * application initializer binds a Medusa action, listens for its event,
 * dispatches a task from the listener, handles that task and serves one
 * route, the way an application would. Unless a test says otherwise, the
 * application also has its task subscriber file, built from
 * `taskEvents()` and `tasks()` as Medusa loads it when it starts.
 *
 * They use every class of this package, and the tasks and rest
 * packages' taskIdOf, task exceptions and RestLifecycle.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { EventStrategy } from '@tsnomad/event';
import type { Event } from '@tsnomad/event';
import { Method } from '@tsnomad/http';
import type { Request, Response } from '@tsnomad/http';
import type { Initializer } from '@tsnomad/loader';
import { LoggerStrategy } from '@tsnomad/logger';
import { RestException } from '@tsnomad/rest';
import type { Controller, HasMiddleware, Middleware } from '@tsnomad/rest';
import { TaskDispatchFailedException, TaskStrategy } from '@tsnomad/tasks';
import type { CanHandleTask } from '@tsnomad/tasks';
import { MedusaBootstrap, MedusaLoggerStrategy, medusaActorOf } from '@tsnomad/medusa-integration';
import type { MedusaSubscriberHandler } from '@tsnomad/medusa-integration';
import { FakeResponse, PlainResponse, SyncProducts, fakeMedusa, fakeRequest, rejection } from './fakes.js';

/** The listener throws for this review id. */
const BROKEN_REVIEW = 'r-broken';
/** The task handler throws for this cursor. */
const BROKEN_SYNC = 'sync-broken';

class ReviewPosted implements Event {
  static getId(): string {
    return 'reviews.posted';
  }
  constructor(readonly reviewId: string) {}
}

const record = { boots: 0, events: [] as string[], tasks: [] as string[] };

/** Dispatches a sync task for each review it hears about. */
class QueueSync {
  static readonly inject = [TaskStrategy] as const;
  constructor(private readonly tasks: TaskStrategy) {}
  async handle(event: ReviewPosted): Promise<void> {
    if (event.reviewId === BROKEN_REVIEW) throw new Error('queue sync broke');
    record.events.push(event.reviewId);
    await this.tasks.dispatch(new SyncProducts(event.reviewId));
  }
}

class RunSync implements CanHandleTask<SyncProducts> {
  async handle(task: SyncProducts): Promise<void> {
    if (task.cursor === BROKEN_SYNC) throw new Error('sync broke');
    record.tasks.push(task.cursor);
  }
}

class ShowReview implements Controller {
  getEndpoint(): string {
    return '/admin/reviews/{id}';
  }
  getMethod(): Method {
    return Method.Get;
  }
  async getResponse(request: Request): Promise<Response> {
    return new PlainResponse().setJson({ id: request.getParam('id') });
  }
}

/** Refuses a request with no signed-in user, the way an application's own middleware would. */
class RequireUser implements Middleware {
  process(request: Request): void {
    if (medusaActorOf(request)?.actorType !== 'user') throw new RestException('Sign in first', {}, 401);
  }
}

class ShowMyReviews implements Controller, HasMiddleware {
  getEndpoint(): string {
    return '/admin/my-reviews';
  }
  getMethod(): Method {
    return Method.Get;
  }
  getMiddleware(): readonly Middleware[] {
    return [new RequireUser()];
  }
  async getResponse(request: Request): Promise<Response> {
    return new PlainResponse().setJson({ actor: medusaActorOf(request)?.actorId });
  }
}

class ReviewsInitializer implements Initializer {
  load(): void {
    record.boots++;
  }
  getEventBindings() {
    return [[ReviewPosted, { action: 'review.created', transformer: (data: { id: string }) => new ReviewPosted(data.id) }]] as const;
  }
  getListeners() {
    return { [ReviewPosted.getId()]: QueueSync };
  }
  getTaskHandlers() {
    return [[SyncProducts, RunSync]] as const;
  }
  getControllers() {
    return [ShowReview, ShowMyReviews];
  }
}

let consoleError: MockInstance;
let medusa: ReturnType<typeof fakeMedusa>;
/** How many error or panic lines a test expects on Medusa's logger. */
let expectedErrorLines: number;

/** The application, with its task subscriber file in place unless `withTaskFile` is false. */
function app(withTaskFile = true): { bootstrap: MedusaBootstrap; tasks: MedusaSubscriberHandler } {
  const bootstrap = new MedusaBootstrap({ initializers: () => [new ReviewsInitializer()] });
  if (!withTaskFile) return { bootstrap, tasks: async () => {} };
  expect(bootstrap.taskEvents()).toEqual(['tsnomad.task.catalog.sync-products']);
  return { bootstrap, tasks: bootstrap.tasks() };
}

beforeEach(() => {
  medusa = fakeMedusa();
  record.boots = 0;
  record.events = [];
  record.tasks = [];
  expectedErrorLines = 0;
  // A strategy writes to console.error only when the logger itself failed.
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  const consoleCalls = consoleError.mock.calls.length;
  vi.restoreAllMocks();
  const errorLines = medusa.logger.calls.filter(([method]) => method === 'error' || method === 'panic');
  expect(consoleCalls).toBe(0);
  expect(errorLines).toHaveLength(expectedErrorLines);
});

describe('Medusa integration, real wiring with a fake Medusa', () => {
  test('boots once for concurrent first subscriber calls, and every event reaches its listener', async () => {
    const { container } = medusa;
    const subscriber = app().bootstrap.subscriber();

    await Promise.all(
      ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => subscriber({ event: { name: 'review.created', data: { id } }, container, pluginOptions: {} })),
    );

    expect(record.boots).toBe(1);
    expect([...record.events].sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
  });

  test("runs a task a listener dispatched when Medusa's event bus delivers it to the task subscriber", async () => {
    const { container, bus } = medusa;
    const { bootstrap, tasks } = app();

    await bootstrap.subscriber()({ event: { name: 'review.created', data: { id: 'r9' } }, container, pluginOptions: {} });
    expect(record.tasks).toEqual([]);
    const messages = bus.drain();
    expect(messages.map((m) => m.name)).toEqual(['tsnomad.task.catalog.sync-products']);
    for (const event of messages) await tasks({ event, container, pluginOptions: {} });

    expect(record.tasks).toEqual(['r9']);
    expect(record.boots).toBe(1);
  });

  test('boots a process from its first task event, as a worker that has run nothing else would', async () => {
    const { container } = medusa;
    const event = { name: 'tsnomad.task.catalog.sync-products', data: { payload: { cursor: 'r10' } } };

    await app().tasks({ event, container, pluginOptions: {} });

    expect(record.boots).toBe(1);
    expect(record.tasks).toEqual(['r10']);
  });

  test("logs a failing task handler through Medusa's logger and rejects the task subscriber with its error", async () => {
    expectedErrorLines = 1;
    const { container, logger } = medusa;
    const event = { name: 'tsnomad.task.catalog.sync-products', data: { payload: { cursor: BROKEN_SYNC } } };

    const error = await rejection(app().tasks({ event, container, pluginOptions: {} }));

    expect((error as Error).message).toBe('sync broke');
    const [method, text, exception] = logger.calls.find(([m]) => m === 'error') as [string, string, unknown];
    expect(method).toBe('error');
    expect(text.startsWith("[error] Task 'catalog.sync-products' failed - sync broke")).toBe(true);
    expect(exception).toBe(error);
  });

  test('refuses a task when the application has no task subscriber file, failing the listener that dispatched it', async () => {
    expectedErrorLines = 1;
    const { container, bus, logger } = medusa;
    const { bootstrap } = app(false);

    const error = await rejection(
      bootstrap.subscriber()({ event: { name: 'review.created', data: { id: 'r11' } }, container, pluginOptions: {} }),
    );

    const broadcast = (error as AggregateError).errors[0] as AggregateError;
    expect(broadcast.errors[0]).toBeInstanceOf(TaskDispatchFailedException);
    expect(((broadcast.errors[0] as Error).cause as Error).message).toContain('tsnomad.task.catalog.sync-products');
    expect(bus.emitted).toEqual([]);
    expect(record.tasks).toEqual([]);
    const [, text] = logger.calls.find(([m]) => m === 'error') as [string, string];
    expect(text).toContain('catalog.sync-products');
  });

  test("logs a listener's failure through Medusa's logger and rejects the subscriber with it", async () => {
    expectedErrorLines = 1;
    const { container, logger } = medusa;

    const error = await rejection(
      app().bootstrap.subscriber()({ event: { name: 'review.created', data: { id: BROKEN_REVIEW } }, container, pluginOptions: {} }),
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as Error).message).toContain("binding(s) failed for action 'review.created'");
    const broadcast = (error as AggregateError).errors[0] as AggregateError;
    expect(broadcast.errors.map((e: Error) => e.message)).toEqual(['queue sync broke']);
    const [method, text, exception] = logger.calls.find(([m]) => m === 'error') as [string, string, unknown];
    expect(method).toBe('error');
    expect(text.startsWith("[error] Action 'review.created' failed for event 'reviews.posted'")).toBe(true);
    expect(exception).toBe((error as AggregateError).errors[0]);
  });

  test("serves a route through the real lifecycle, booted from the request's scope, and writes the response to Medusa's", async () => {
    const { scope } = medusa;
    const res = new FakeResponse();

    await app().bootstrap.route()(fakeRequest({ method: 'GET', path: '/admin/reviews/rev_7', scope: scope() }), res);

    expect(res.calls).toEqual([
      ['status', 200],
      ['setHeader', 'content-type', 'application/json'],
      ['send', '{"id":"rev_7"}'],
    ]);
    expect(record.boots).toBe(1);
  });

  test("gives route middleware the actor from Medusa's auth_context, through the real lifecycle", async () => {
    const { scope } = medusa;
    const route = app().bootstrap.route();
    const signedIn = new FakeResponse();
    const anonymous = new FakeResponse();

    await route(
      fakeRequest({ path: '/admin/my-reviews', auth_context: { actor_id: 'user_1', actor_type: 'user', auth_identity_id: 'authid_1' }, scope: scope() }),
      signedIn,
    );
    await route(fakeRequest({ path: '/admin/my-reviews', query: { actorId: 'user_1' }, scope: scope() }), anonymous);

    expect(signedIn.calls).toContainEqual(['status', 200]);
    expect(signedIn.calls).toContainEqual(['send', '{"actor":"user_1"}']);
    expect(anonymous.calls).toContainEqual(['status', 401]);
  });

  test("logs through Medusa's logger, and shares one container across subscriber, job and route", async () => {
    const { container, logger, scope } = medusa;
    const { bootstrap } = app();

    await bootstrap.subscriber()({ event: { name: 'review.created', data: { id: 'r1' } }, container, pluginOptions: {} });
    await bootstrap.job(async (booted) => {
      const log = await booted.get(LoggerStrategy);
      expect(log).toBeInstanceOf(MedusaLoggerStrategy);
      log.info('Job ran', { reviews: record.events.length });
      expect(await booted.get(EventStrategy)).toBe(await (await bootstrap.boot(container)).get(EventStrategy));
    })(container);
    await bootstrap.route()(fakeRequest({ path: '/admin/reviews/r1', scope: scope() }), new FakeResponse());

    expect(record.boots).toBe(1);
    expect(logger.calls).toContainEqual(['info', '[info] Job ran {"reviews":1}']);
  });
});
