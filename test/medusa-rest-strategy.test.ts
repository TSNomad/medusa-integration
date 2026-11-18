/**
 * Acceptance tests for MedusaRestStrategy and medusaActorOf.
 *
 * The lifecycle here is a stand-in that calls the controller and answers
 * its response, so these tests hold the strategy's own work: the route
 * table, the request a controller sees, and what reaches Medusa's
 * response. The integration test runs the real RestLifecycle.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Method } from '@tsnomad/http';
import type { Request, Response } from '@tsnomad/http';
import { LoggerStrategy } from '@tsnomad/logger';
import { RestLifecycle } from '@tsnomad/rest';
import type { Controller } from '@tsnomad/rest';
import { MedusaRestStrategy, medusaActorOf } from '@tsnomad/medusa-integration';
import type { RequestRunner } from '@tsnomad/medusa-integration';
import { FakeResponse, PlainResponse, RecordingLogger, ThrowingLogger, fakeRequest, rejection } from './fakes.js';

/** A controller that records each request it answers. */
class Echo implements Controller {
  readonly requests: Request[] = [];
  constructor(
    private readonly endpoint: string,
    private readonly method: Method = Method.Get,
    private readonly name: string = 'echo',
  ) {}
  getEndpoint(): string {
    return this.endpoint;
  }
  getMethod(): Method {
    return this.method;
  }
  async getResponse(request: Request): Promise<Response> {
    this.requests.push(request);
    return new PlainResponse().setStatus(201).setHeader('X-Handled-By', this.name).setJson({ handledBy: this.name });
  }
}

class Runner implements RequestRunner {
  readonly runs: [Controller, Request][] = [];
  failure: unknown = undefined;
  async handle(controller: Controller, request: Request): Promise<Response> {
    this.runs.push([controller, request]);
    if (this.failure !== undefined) throw this.failure;
    return controller.getResponse(request);
  }
}

let runner: Runner;
let logger: RecordingLogger;
let strategy: MedusaRestStrategy;

beforeEach(() => {
  runner = new Runner();
  logger = new RecordingLogger();
  strategy = new MedusaRestStrategy(runner, logger);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function register(controller: Controller): Promise<Controller> {
  await strategy.registerRoute(async () => controller);
  return controller;
}

describe('MedusaRestStrategy.handle', () => {
  test("runs the matching controller through the lifecycle and writes its status, headers and body, once each, in order", async () => {
    const echo = await register(new Echo('/admin/reviews'));
    const res = new FakeResponse();

    await strategy.handle(fakeRequest({ method: 'GET', path: '/admin/reviews' }), res);

    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0][0]).toBe(echo);
    expect(res.calls).toEqual([
      ['status', 201],
      ['setHeader', 'x-handled-by', 'echo'],
      ['setHeader', 'content-type', 'application/json'],
      ['send', '{"handledBy":"echo"}'],
    ]);
    expect(logger.calls).toEqual([]);
  });

  test('routes by method, so one endpoint can have a controller per method', async () => {
    await register(new Echo('/admin/reviews', Method.Get, 'list'));
    await register(new Echo('/admin/reviews', Method.Post, 'create'));
    const res = new FakeResponse();

    await strategy.handle(fakeRequest({ method: 'post', path: '/admin/reviews' }), res);

    expect(res.calls.at(-1)).toEqual(['send', '{"handledBy":"create"}']);
  });

  test('serves a HEAD request with the GET controller, as Express hands HEAD to a GET export', async () => {
    const list = await register(new Echo('/admin/reviews', Method.Get, 'list'));
    await register(new Echo('/admin/notes', Method.Post, 'create'));
    const res = new FakeResponse();

    await strategy.handle(fakeRequest({ method: 'HEAD', path: '/admin/reviews' }), res);

    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0][0]).toBe(list);
    expect(res.calls[0]).toEqual(['status', 201]);
    expect(logger.calls).toEqual([]);

    const missing = new FakeResponse();
    await strategy.handle(fakeRequest({ method: 'HEAD', path: '/admin/notes' }), missing);

    expect(runner.runs).toHaveLength(1);
    expect(missing.calls[0]).toEqual(['status', 404]);
  });

  test('matches fixed segments in any case, as Express does, keeps a parameter as sent, and refuses a route differing only in case', async () => {
    const echo = (await register(new Echo('/admin/Reviews/{id}'))) as Echo;
    const res = new FakeResponse();

    await strategy.handle(fakeRequest({ method: 'GET', path: '/ADMIN/reviews/AbC' }), res);

    expect(res.calls[0]).toEqual(['status', 201]);
    expect(echo.requests[0].getParam('id')).toBe('AbC');
    expect(logger.calls).toEqual([]);
    expect(await rejection(strategy.registerRoute(async () => new Echo('/admin/reviews/{reviewId}', Method.Get, 'second')))).toBeInstanceOf(Error);
  });

  test('gives the controller decoded path parameters, which a query or body of the same name cannot replace', async () => {
    const echo = (await register(new Echo('/admin/reviews/{id}/notes/{noteId}', Method.Post))) as Echo;

    await strategy.handle(
      fakeRequest({
        method: 'POST',
        path: '/admin/reviews/rev%2F1/notes/n_2',
        query: { id: 'from-query', page: '2', shared: 'query' },
        body: { id: 'from-body', noteId: 'from-body', text: 'hello', shared: 'body' },
      }),
      new FakeResponse(),
    );

    const request = echo.requests[0];
    expect(request.getParam('id')).toBe('rev/1');
    expect(request.getParam('noteId')).toBe('n_2');
    expect(request.getParam('page')).toBe('2');
    expect(request.getParam('text')).toBe('hello');
    expect(request.getParam('shared')).toBe('body');
    expect(request.hasParam('missing')).toBe(false);
    expect(request.getParams()).toEqual({ id: 'rev/1', noteId: 'n_2', page: '2', text: 'hello', shared: 'body' });
  });

  test('drops a query or body key named __proto__, so a merged copy of the parameters carries no prototype', async () => {
    const echo = (await register(new Echo('/hooks', Method.Post))) as Echo;
    const body = JSON.parse('{"__proto__":{"isAdmin":true},"a":1}') as Record<string, unknown>;
    const query = JSON.parse('{"__proto__":{"isOwner":true},"q":"x"}') as Record<string, unknown>;

    await strategy.handle(fakeRequest({ method: 'POST', path: '/hooks', query, body }), new FakeResponse());

    const request = echo.requests[0];
    expect(request.hasParam('__proto__')).toBe(false);
    expect(request.getParams()).toEqual({ q: 'x', a: 1 });
    const merged = Object.assign({}, request.getParams()) as Record<string, unknown>;
    expect(merged.isAdmin).toBeUndefined();
    expect(merged.isOwner).toBeUndefined();
  });

  test('keeps a parameter a controller sets as __proto__ as an ordinary key, and a header it sets in lower case', async () => {
    const echo = (await register(new Echo('/hooks', Method.Post))) as Echo;
    await strategy.handle(fakeRequest({ method: 'POST', path: '/hooks' }), new FakeResponse());
    const request = echo.requests[0];
    const value = { isAdmin: true };

    request.setParam('__proto__', value);
    request.setHeader('X-Trace', 't-1');

    expect(request.hasParam('__proto__')).toBe(true);
    expect(request.getParam('__proto__')).toBe(value);
    expect(request.hasParam('isAdmin')).toBe(false);
    expect(request.getHeaders()).toEqual({ 'x-trace': 't-1' });
  });

  test('ignores the keys of a body that is not a plain object', async () => {
    const echo = (await register(new Echo('/hooks', Method.Post))) as Echo;

    await strategy.handle(fakeRequest({ method: 'POST', path: '/hooks', query: { a: '1' }, body: ['x', 'y'] }), new FakeResponse());

    expect(echo.requests[0].getParams()).toEqual({ a: '1' });
  });

  test('finds a header in any case and reads a header held as a list as its values joined', async () => {
    const echo = (await register(new Echo('/hooks', Method.Post))) as Echo;

    await strategy.handle(
      fakeRequest({ method: 'POST', path: '/hooks', headers: { 'x-signature': 'sig-1', 'x-forwarded-for': ['10.0.0.1', '10.0.0.2'] } }),
      new FakeResponse(),
    );

    const request = echo.requests[0];
    expect(request.getHeader('X-Signature')).toBe('sig-1');
    expect(request.getHeader('X-FORWARDED-FOR')).toBe('10.0.0.1, 10.0.0.2');
    expect(request.getHeader('x-absent')).toBeNull();
  });

  test('returns the raw body Medusa kept, from a Buffer or a string, and never re-encodes the parsed body', async () => {
    const echo = (await register(new Echo('/hooks', Method.Post))) as Echo;
    const raw = '{"b":1,  "a":2}';

    await strategy.handle(fakeRequest({ method: 'POST', path: '/hooks', body: { b: 1, a: 2 }, rawBody: Buffer.from(raw, 'utf8') }), new FakeResponse());
    await strategy.handle(fakeRequest({ method: 'POST', path: '/hooks', body: { b: 1, a: 2 }, rawBody: raw }), new FakeResponse());
    await strategy.handle(fakeRequest({ method: 'POST', path: '/hooks', body: { b: 1, a: 2 } }), new FakeResponse());

    expect(echo.requests.map((r) => r.getBody())).toEqual([raw, raw, '']);
  });

  test('prefers a fixed segment to a parameter, comparing from the left, whatever the registration order', async () => {
    await register(new Echo('/admin/reviews/{id}', Method.Get, 'one'));
    await register(new Echo('/admin/reviews/stats', Method.Get, 'stats'));
    await register(new Echo('/admin/{section}/stats', Method.Get, 'section'));

    const stats = new FakeResponse();
    const one = new FakeResponse();
    await strategy.handle(fakeRequest({ path: '/admin/reviews/stats' }), stats);
    await strategy.handle(fakeRequest({ path: '/admin/reviews/rev_9' }), one);

    expect(stats.calls.at(-1)).toEqual(['send', '{"handledBy":"stats"}']);
    expect(one.calls.at(-1)).toEqual(['send', '{"handledBy":"one"}']);
  });

  test('ranks by the leftmost segment where one route is fixed and the other a parameter, in either registration order', async () => {
    for (const order of [
      ['/admin/reviews/{id}', '/admin/{section}/stats'],
      ['/admin/{section}/stats', '/admin/reviews/{id}'],
    ]) {
      strategy = new MedusaRestStrategy(runner, logger);
      for (const endpoint of order) await register(new Echo(endpoint, Method.Get, endpoint));
      const res = new FakeResponse();

      await strategy.handle(fakeRequest({ method: 'GET', path: '/admin/reviews/stats' }), res);

      expect(res.calls.at(-1)).toEqual(['send', '{"handledBy":"/admin/reviews/{id}"}']);
    }
  });

  test('joins the base URL and the path, and ignores one trailing slash', async () => {
    await register(new Echo('/store/visits/{code}'));
    const res = new FakeResponse();

    await strategy.handle(fakeRequest({ baseUrl: '/store', path: '/visits/abc/' }), res);

    expect(res.calls.at(-1)).toEqual(['send', '{"handledBy":"echo"}']);
  });

  test('responds 404 with a JSON error and logs the method and path, without the query, when no route matches', async () => {
    await register(new Echo('/admin/reviews/{id}'));
    const res = new FakeResponse();

    await strategy.handle(fakeRequest({ method: 'GET', path: '/admin/reviews', query: { token: 'secret' } }), res);

    expect(runner.runs).toEqual([]);
    expect(res.calls).toEqual([
      ['status', 404],
      ['setHeader', 'content-type', 'application/json'],
      ['send', '{"error":{"message":"No route matches GET /admin/reviews"}}'],
    ]);
    expect(logger.calls).toEqual([['error', 'No TS Nomad route matches the request', { method: 'GET', path: '/admin/reviews' }]]);
    expect(JSON.stringify(logger.calls)).not.toContain('secret');
  });

  test('matches nothing for an empty segment, an extra segment or a segment that does not decode', async () => {
    await register(new Echo('/admin/reviews/{id}'));

    for (const path of ['/admin/reviews//', '/admin/reviews/a/b', '/admin/reviews/%E0%A4%A']) {
      const res = new FakeResponse();
      await strategy.handle(fakeRequest({ path }), res);
      expect(res.calls[0]).toEqual(['status', 404]);
    }
    expect(runner.runs).toEqual([]);
  });

  test('lets a lifecycle failure reach Medusa unchanged, writing nothing', async () => {
    await register(new Echo('/hooks'));
    const failure = new Error('factory broke');
    runner.failure = failure;
    const res = new FakeResponse();

    const error = await rejection(strategy.handle(fakeRequest({ path: '/hooks' }), res));

    expect(error).toBe(failure);
    expect(res.calls).toEqual([]);
  });
});

describe('MedusaRestStrategy.handle when the logger throws', () => {
  test('still responds 404 to a request with no route, and writes the line to console.error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const local = new MedusaRestStrategy(runner, new ThrowingLogger());
    const res = new FakeResponse();

    await local.handle(fakeRequest({ method: 'GET', path: '/admin/nothing' }), res);

    expect(res.calls[0]).toEqual(['status', 404]);
    expect(consoleError.mock.calls).toEqual([
      ['No TS Nomad route matches the request, and the logger threw while reporting it', { method: 'GET', path: '/admin/nothing', loggerError: ThrowingLogger.failure }],
    ]);
  });
});

describe('medusaActorOf', () => {
  const authContext = { actor_id: 'user_1', actor_type: 'user', auth_identity_id: 'authid_1' };

  test("returns the actor from Medusa's auth_context, frozen, to the controller's request", async () => {
    const echo = (await register(new Echo('/admin/reviews/{id}'))) as Echo;

    await strategy.handle(fakeRequest({ path: '/admin/reviews/rev_1', auth_context: authContext }), new FakeResponse());

    const actor = medusaActorOf(echo.requests[0]);
    expect(actor).toEqual({ actorId: 'user_1', actorType: 'user', authIdentityId: 'authid_1' });
    expect(Object.isFrozen(actor)).toBe(true);
  });

  test('ignores any actor a body, query, header or later parameter names', async () => {
    const echo = (await register(new Echo('/admin/reviews/{id}', Method.Post))) as Echo;

    await strategy.handle(
      fakeRequest({
        method: 'POST',
        path: '/admin/reviews/rev_1',
        auth_context: authContext,
        body: { actor_id: 'user_evil', actorId: 'user_evil' },
        query: { actor_id: 'user_evil' },
        headers: { 'x-actor-id': 'user_evil' },
      }),
      new FakeResponse(),
    );
    const request = echo.requests[0];
    request.setParam('actorId', 'user_evil');
    request.setParam('actor_id', 'user_evil');

    expect(medusaActorOf(request)).toEqual({ actorId: 'user_1', actorType: 'user', authIdentityId: 'authid_1' });
  });

  test('returns null for an identity with no actor yet, whose actor_id Medusa leaves empty', async () => {
    const echo = (await register(new Echo('/store/reviews'))) as Echo;

    await strategy.handle(
      fakeRequest({ path: '/store/reviews', auth_context: { actor_id: '', actor_type: 'customer', auth_identity_id: 'authid_2' } }),
      new FakeResponse(),
    );

    expect(medusaActorOf(echo.requests[0])).toBeNull();
  });

  test("returns a secret API key's actor with its type, so a controller can tell it from a user", async () => {
    const echo = (await register(new Echo('/admin/reviews'))) as Echo;

    await strategy.handle(
      fakeRequest({ path: '/admin/reviews', auth_context: { actor_id: 'apk_1', actor_type: 'api-key', auth_identity_id: '' } }),
      new FakeResponse(),
    );

    expect(medusaActorOf(echo.requests[0])).toEqual({ actorId: 'apk_1', actorType: 'api-key', authIdentityId: '' });
  });

  test('returns null with no auth_context, and for a request the strategy did not build', async () => {
    const echo = (await register(new Echo('/store/reviews'))) as Echo;

    await strategy.handle(fakeRequest({ path: '/store/reviews', query: { actorId: 'user_evil', actor_id: 'user_evil' } }), new FakeResponse());

    expect(medusaActorOf(echo.requests[0])).toBeNull();
    const elsewhere = { getParam: () => 'user_1', getParams: () => ({ actorId: 'user_1' }) } as unknown as Request;
    expect(medusaActorOf(elsewhere)).toBeNull();
  });
});

describe('MedusaRestStrategy.registerRoute', () => {
  test('resolves the controller once and serves every request with that one instance', async () => {
    let gets = 0;
    const echo = new Echo('/hooks');
    await strategy.registerRoute(async () => {
      gets++;
      return echo;
    });

    await strategy.handle(fakeRequest({ path: '/hooks' }), new FakeResponse());
    await strategy.handle(fakeRequest({ path: '/hooks' }), new FakeResponse());

    expect(gets).toBe(1);
    expect(runner.runs.map(([controller]) => controller)).toEqual([echo, echo]);
  });

  test('refuses a route whose method and endpoint shape are already held, and keeps the first', async () => {
    await register(new Echo('/admin/reviews/{id}', Method.Get, 'first'));

    const error = await rejection(strategy.registerRoute(async () => new Echo('/admin/reviews/{reviewId}', Method.Get, 'second')));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('GET');
    expect((error as Error).message).toContain('/admin/reviews/{reviewId}');
    const res = new FakeResponse();
    await strategy.handle(fakeRequest({ path: '/admin/reviews/r1' }), res);
    expect(res.calls.at(-1)).toEqual(['send', '{"handledBy":"first"}']);
  });

  test('refuses a method that is not an http Method and an endpoint without a leading slash, naming the controller class', async () => {
    class BadMethod extends Echo {}
    class NoSlash extends Echo {}

    const method = await rejection(strategy.registerRoute(async () => new BadMethod('/x', 'FETCH' as Method)));
    const slash = await rejection(strategy.registerRoute(async () => new NoSlash('x')));

    expect(method).toBeInstanceOf(TypeError);
    expect((method as Error).message).toContain('BadMethod');
    expect(slash).toBeInstanceOf(TypeError);
    expect((slash as Error).message).toContain('NoSlash');
    for (const req of [fakeRequest({ method: 'FETCH', path: '/x' }), fakeRequest({ path: 'x' }), fakeRequest({ path: '/x' })]) {
      const res = new FakeResponse();
      await strategy.handle(req, res);
      expect(res.calls[0]).toEqual(['status', 404]);
    }
  });

  test('lets a getter failure reach the caller unchanged', async () => {
    const failure = new Error('cannot build');

    await expect(
      strategy.registerRoute(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});

test('declares the lifecycle and the logger for autowiring', () => {
  expect(MedusaRestStrategy.inject).toEqual([RestLifecycle, LoggerStrategy]);
});
