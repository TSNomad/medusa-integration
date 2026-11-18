/**
 * The parts of Medusa this package uses
 *
 * Structural types for the Medusa objects the strategies touch: the app
 * container, its logger and event bus, a subscriber's arguments, a
 * scheduled job, and an API route's request and response. Medusa's own
 * types fit them, and a compile-only test holds that against
 * `@medusajs/types` 2.22. The package imports nothing from Medusa at run
 * time, so an application loads one copy of the framework, its own.
 *
 * The keys this package resolves from the app container are Medusa's
 * registration names: `logger` and `event_bus`.
 */

import { createToken } from '@tsnomad/di-container';

/**
 * Medusa's app container, or a request's scope of it. Medusa hands one to
 * every subscriber, scheduled job and API route.
 */
export interface MedusaContainer {
  resolve<T = unknown>(key: string): T;
}

/**
 * Token for the Medusa container a `MedusaBootstrap` booted from. Named
 * after the interface, as every TS Nomad token is.
 */
export const MedusaContainer = createToken<MedusaContainer>('MedusaContainer');

/** The part of Medusa's `Logger` that `MedusaLoggerStrategy` writes to. */
export interface MedusaLogger {
  error(messageOrError: string | Error, error?: Error): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

/** Token for the logger Medusa registers as `logger`. */
export const MedusaLogger = createToken<MedusaLogger>('MedusaLogger');

/** One event on Medusa's event bus, as emitted and as a subscriber receives it. */
export interface MedusaEventMessage<T = unknown> {
  name: string;
  data: T;
  metadata?: Record<string, unknown>;
}

/** The part of Medusa's event bus module that `MedusaTaskStrategy` uses. */
export interface MedusaEventBus {
  emit(data: MedusaEventMessage | MedusaEventMessage[], options?: Record<string, unknown>): Promise<void>;
}

/** Token for the event bus module Medusa registers as `event_bus`. */
export const MedusaEventBus = createToken<MedusaEventBus>('MedusaEventBus');

/**
 * The task events a task subscriber file serves in this application:
 * `has(name)` is true for a name `MedusaBootstrap.taskEvents()` returned,
 * once `MedusaBootstrap.tasks()` has been built. `MedusaTaskStrategy`
 * refuses to dispatch a task whose event nothing serves, since Medusa
 * drops an event with no subscriber without a word.
 */
export interface MedusaTaskEvents {
  has(eventName: string): boolean;
}

/** Token for the task events `MedusaBootstrap` binds. */
export const MedusaTaskEvents = createToken<MedusaTaskEvents>('MedusaTaskEvents');

/** What Medusa passes a subscriber function. */
export interface MedusaSubscriberArgs<T = unknown> {
  event: MedusaEventMessage<T>;
  container: MedusaContainer;
  pluginOptions?: Record<string, unknown>;
}

/** A subscriber function, the default export of a file in `src/subscribers`. */
export type MedusaSubscriberHandler = (args: MedusaSubscriberArgs) => Promise<void>;

/** A scheduled job function, the default export of a file in `src/jobs`. */
export type MedusaJobHandler = (container: MedusaContainer) => Promise<void>;

/**
 * An API route's request, the part of Medusa's `MedusaRequest` (an
 * Express request) that `MedusaRestStrategy` reads.
 */
export interface MedusaHttpRequest {
  method: string;
  path: string;
  baseUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: unknown;
  /** Set by Medusa when the route's middleware asks it to keep the raw body. */
  rawBody?: unknown;
  /** Set by Medusa's `authenticate` middleware for a signed-in actor. */
  auth_context?: { actor_id: string; actor_type: string; auth_identity_id: string };
  scope: MedusaContainer;
}

/**
 * The signed-in actor of a route request, read from Medusa's
 * `auth_context` by `medusaActorOf`.
 */
export interface MedusaActor {
  readonly actorId: string;
  readonly actorType: string;
  readonly authIdentityId: string;
}

/** An API route's response, the part of Medusa's `MedusaResponse` that `MedusaRestStrategy` writes. */
export interface MedusaHttpResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
}

/** A route function, a method export such as `POST` of a file in `src/api`. */
export type MedusaRouteHandler = (req: MedusaHttpRequest, res: MedusaHttpResponse) => Promise<void>;
