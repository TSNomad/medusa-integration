/**
 * MedusaRestStrategy
 *
 * The `RestStrategy` for Medusa, the counterpart to the `RestStrategy` in
 * PHPNomad's WordPress integration. WordPress adds a route at run time
 * with `register_rest_route`. Medusa builds its routes from files in
 * `src/api` when the application starts, so this strategy keeps a route
 * table instead, and a route file hands each request to `handle`, usually
 * through `MedusaBootstrap.route()`. The file decides which paths and
 * methods reach TS Nomad, and the table decides which controller serves
 * each request.
 *
 * Route matching. An endpoint uses `{name}` for a path parameter, as every
 * TS Nomad controller does, such as `/admin/reviews/{id}`. A `{name}`
 * segment matches one non-empty path segment, and any other segment
 * matches only itself, in any case, as Express routes the request to the
 * route file whatever its case. The request's path is
 * `req.baseUrl` (empty when absent) followed by `req.path`, with one
 * trailing slash ignored. A parameter's value is the segment decoded with
 * `decodeURIComponent`, and a segment that does not decode matches
 * nothing. When several endpoints match, the one with a fixed segment
 * where the others have a parameter wins, comparing from the left, as
 * Medusa ranks its own route files. A HEAD request finds the GET route,
 * since Express hands HEAD to a route file's `GET` export and drops the
 * body it sends.
 *
 * The request a controller receives:
 *
 * - `getHeader` finds a header in any case. A header Node holds as a list
 *   reads as its values joined by `, `.
 * - Parameters merge the query, then the body's keys when the body is a
 *   plain object, then the endpoint's path parameters, each later source
 *   replacing an earlier one with the same name, so a body or query can
 *   never replace a path parameter. A query or body key named
 *   `__proto__` is dropped, so a controller that merges `getParams()`
 *   into an object cannot hand it a prototype the sender chose. Nested
 *   values reach the controller as Medusa parsed them. A body that is not
 *   a plain object, such as a JSON list, adds no parameters, and reaches
 *   the controller only through `getBody()`, so a route that takes one
 *   keeps the raw body.
 * - A parameter name is one key, read as written. PHPNomad's WordPress
 *   request also reads a dotted name, such as `address.city`, as a path
 *   into nested values.
 * - `getBody()` returns the raw body when Medusa kept one in `rawBody`,
 *   as a string or a Buffer read as UTF-8, and an empty string otherwise.
 *   It never encodes the parsed body again, because a signature checked
 *   over re-encoded JSON is not the signature the sender made.
 *
 * The signed-in actor. TS Nomad's `Request` has no user yet, so
 * `medusaActorOf(request)` returns the actor Medusa's `authenticate`
 * middleware put in `req.auth_context`, and only from there. No header,
 * query or body value can stand in for it. Put `authenticate` on the
 * route, and check in the controller or its middleware that the actor
 * has the type the route expects, such as `user` or `customer`, and may
 * touch the record the path names. Medusa also sets `auth_context` for a
 * secret API key on admin routes, with the type `api-key` and the key's
 * id, so a check of the id alone is not enough.
 *
 * Where this differs from PHPNomad:
 *
 * - WordPress gives body and query parameters precedence over the path's.
 *   Here the path wins, so a body cannot name a different record than the
 *   path the route checked.
 * - There is no `HasRestNamespace` prefix. The route file's folder is the
 *   path.
 * - A request a route file hands over with no matching controller gets a
 *   404 and an error log line, since it can only come from a wiring
 *   mistake.
 * - A `{name}` segment matches any non-empty segment, decoded, as
 *   Medusa's own `[name]` folders do. WordPress allows only letters,
 *   digits, `_` and `-` there.
 * - When several routes match, the one with a fixed segment furthest to
 *   the left wins, as Medusa ranks its route files. WordPress takes the
 *   first route registered.
 * - `registerRoute` refuses an endpoint without a leading `/`, and a
 *   second route of one method whose endpoint differs only in parameter
 *   names or case, where `register_rest_route` accepts both.
 * - The controller is resolved once, when the route is registered at
 *   boot, and serves every request. WordPress resolves it when
 *   `rest_api_init` runs, once per request.
 */

import { RestLifecycle } from '@tsnomad/rest';
import type { Controller, RestStrategy } from '@tsnomad/rest';
import { LoggerStrategy } from '@tsnomad/logger';
import { Method } from '@tsnomad/http';
import type { Request } from '@tsnomad/http';
import type { MedusaActor, MedusaHttpRequest, MedusaHttpResponse } from './medusa.js';

/** One endpoint segment: a fixed literal, or a `{name}` parameter. */
type Segment = { readonly literal: string } | { readonly param: string };

/** One row of the route table. */
interface Route {
  readonly method: string;
  readonly endpoint: string;
  readonly segments: readonly Segment[];
  /** The endpoint in lower case with every parameter name blanked, which two routes of one method may not share. */
  readonly shape: string;
  readonly controller: Controller;
}

/** The actor of each request `handle` built, kept where no parameter, header or body can reach it. */
const actors = new WeakMap<Request, MedusaActor>();

/** What `MedusaRestStrategy` needs from `RestLifecycle`. */
export type RequestRunner = Pick<RestLifecycle, 'handle'>;

/**
 * The signed-in actor of a request `MedusaRestStrategy.handle` built,
 * read from that Medusa request's `auth_context` when the request was
 * built: `{ actorId, actorType, authIdentityId }` from `actor_id`,
 * `actor_type` and `auth_identity_id`. It returns null when the Medusa
 * request had no `auth_context`, and for any request the strategy did not
 * build. It also returns null when `actor_id` is empty, which is how
 * Medusa marks an identity that has authenticated but has no actor yet
 * (`authenticate` with `allowUnregistered`). Parameters, headers and the
 * body never change what it returns, and what it returns is a frozen
 * copy.
 */
export function medusaActorOf(request: Request): MedusaActor | null {
  return actors.get(request) ?? null;
}

export class MedusaRestStrategy implements RestStrategy {
  static readonly inject = [RestLifecycle, LoggerStrategy] as const;

  /** The route table, in registration order. */
  private readonly routes: Route[] = [];

  constructor(
    private readonly lifecycle: RequestRunner,
    private readonly logger: LoggerStrategy,
  ) {}

  /**
   * Resolves the controller once, through the getter, and adds it to the
   * route table under its method and endpoint. The same controller then
   * serves every matching request, as the container's shared instance
   * would.
   *
   * @throws TypeError, through the returned promise, naming the controller
   *   class, when its method is not one of the http package's `Method`
   *   values or its endpoint does not start with `/`
   * @throws Error, through the returned promise, naming the method and
   *   endpoint, when the table already holds a route for that method whose
   *   endpoint differs only in its parameter names or the case of its
   *   fixed segments. Nothing is added from
   *   a refused call.
   * @throws whatever the getter throws, unchanged
   */
  async registerRoute(getController: () => Promise<Controller>): Promise<void> {
    const controller = await getController();
    const name = controller?.constructor?.name || 'a controller';
    const method: string = controller.getMethod();
    const endpoint: string = controller.getEndpoint();
    if (!(Object.values(Method) as string[]).includes(method)) throw new TypeError(`${name}: '${String(method)}' is not an http Method`);
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) throw new TypeError(`${name}: the endpoint '${String(endpoint)}' must start with /`);
    const segments = parse(endpoint);
    const shape = segments.map((s) => ('param' in s ? '{}' : s.literal)).join('/');
    if (this.routes.some((r) => r.method === method && r.shape === shape)) throw new Error(`A route for ${method} ${endpoint} is already registered`);
    this.routes.push({ method, endpoint, segments, shape, controller });
  }

  /**
   * Serves one Medusa request:
   *
   * 1. Finds the route for the request's method and path, the GET route
   *    for a HEAD request.
   * 2. When none matches, logs `error('No TS Nomad route matches the
   *    request', { method, path })` and responds 404 with the JSON body
   *    `{ "error": { "message": "No route matches <METHOD> <path>" } }`
   *    and the header `content-type: application/json`.
   * 3. Otherwise builds the request described above and awaits
   *    `lifecycle.handle(controller, request)`.
   * 4. Writes the response: `res.status(status)`, then
   *    `res.setHeader(name, value)` for each of its headers, then
   *    `res.send(body)`, once each.
   *
   * The path in the log and the 404 body never includes the query string.
   * When the logger throws while it writes the 404 line, the strategy
   * writes `console.error('No TS Nomad route matches the request, and the
   * logger threw while reporting it', { method, path, loggerError })`
   * instead and still responds 404.
   *
   * @throws whatever `lifecycle.handle` or the response methods throw,
   *   unchanged, so Medusa's error handler responds to it
   */
  async handle(req: MedusaHttpRequest, res: MedusaHttpResponse): Promise<void> {
    const method = req.method.toUpperCase();
    const lookup = method === 'HEAD' ? Method.Get : method;
    let path = (req.baseUrl ?? '') + req.path;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const parts = path.split('/').slice(1);
    let best: { route: Route; params: Record<string, string> } | undefined;
    for (const route of this.routes) {
      if (route.method !== lookup || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length && ok; i++) {
        const seg = route.segments[i];
        if ('literal' in seg) ok = seg.literal === parts[i].toLowerCase();
        else if (parts[i] === '') ok = false;
        else {
          // A segment that does not decode is a malformed path, so it
          // matches nothing, and a request no route matches is logged below.
          try { params[seg.param] = decodeURIComponent(parts[i]); } catch { ok = false; }
        }
      }
      if (!ok) continue;
      if (!best || this.beats(route, best.route)) best = { route, params };
    }

    if (!best) {
      try {
        this.logger.error('No TS Nomad route matches the request', { method, path });
      } catch (loggerError) {
        console.error('No TS Nomad route matches the request, and the logger threw while reporting it', { method, path, loggerError });
      }
      res.status(404);
      res.setHeader('content-type', 'application/json');
      res.send(JSON.stringify({ error: { message: `No route matches ${method} ${path}` } }));
      return;
    }

    const headers = Object.create(null) as Record<string, string>;
    for (const [key, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers[key.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    }
    const body = req.body !== null && typeof req.body === 'object' && Object.getPrototypeOf(req.body) === Object.prototype ? (req.body as Record<string, unknown>) : {};
    // A query or body key named __proto__ is dropped, so no copy of the
    // parameters can hand a caller's object a prototype the sender chose.
    const params = Object.create(null) as Record<string, unknown>;
    for (const source of [req.query ?? {}, body]) {
      for (const [key, value] of Object.entries(source)) if (key !== '__proto__') params[key] = value;
    }
    Object.assign(params, best.params);
    const raw = typeof req.rawBody === 'string' ? req.rawBody : Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : '';
    const request = new MedusaRequest(headers, params, raw);
    const auth = req.auth_context;
    if (auth && auth.actor_id) actors.set(request, Object.freeze({ actorId: auth.actor_id, actorType: auth.actor_type, authIdentityId: auth.auth_identity_id }));

    const response = await this.lifecycle.handle(best.route.controller, request);
    res.status(response.getStatus());
    for (const [name, value] of Object.entries(response.getHeaders())) res.setHeader(name, value);
    res.send(response.getBody());
  }

  /**
   * Whether route `a` ranks above route `b` for one path both match: at
   * the leftmost segment where one is fixed and the other a parameter,
   * the fixed one wins.
   */
  private beats(a: Route, b: Route): boolean {
    for (let i = 0; i < a.segments.length; i++) {
      const aFixed = 'literal' in a.segments[i];
      const bFixed = 'literal' in b.segments[i];
      if (aFixed !== bFixed) return aFixed;
    }
    return false;
  }
}

/**
 * Splits an endpoint that starts with `/` into its segments, ignoring one
 * trailing slash, as `handle` does with a request's path. `{name}` is a
 * parameter, and anything else is fixed, kept in lower case.
 */
function parse(endpoint: string): Segment[] {
  const trimmed = endpoint.length > 1 && endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  return trimmed
    .split('/')
    .slice(1)
    .map((part) => {
      const match = /^\{([^{}]+)\}$/.exec(part);
      return match ? { param: match[1] } : { literal: part.toLowerCase() };
    });
}

/**
 * The request a controller receives, over one Medusa request. Headers are
 * keyed in lower case, and the parameters live on an object with no
 * prototype, so `setParam('__proto__', ...)` stores an ordinary key.
 */
class MedusaRequest implements Request {
  private readonly headers: Record<string, string>;
  private readonly params: Record<string, unknown>;

  constructor(
    headers: Record<string, string>,
    params: Record<string, unknown>,
    private readonly body: string,
  ) {
    this.headers = Object.assign(Object.create(null) as Record<string, string>, headers);
    this.params = Object.assign(Object.create(null) as Record<string, unknown>, params);
  }

  getHeader(name: string): string | null { return this.headers[name.toLowerCase()] ?? null; }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  getHeaders(): Record<string, string> {
    return { ...this.headers };
  }

  getParam(name: string): unknown {
    return this.hasParam(name) ? this.params[name] : null;
  }

  hasParam(name: string): boolean {
    return Object.hasOwn(this.params, name);
  }

  setParam(name: string, value: unknown): void {
    this.params[name] = value;
  }

  removeParam(name: string): void {
    delete this.params[name];
  }

  getBody(): string {
    return this.body;
  }

  getParams(): Record<string, unknown> {
    return { ...this.params };
  }
}
