/**
 * Compile-only checks, run by `npm run typecheck`. Each @ts-expect-error
 * line must stay an error. Nothing here runs.
 *
 * The first group holds the package's Medusa shapes against Medusa's own
 * types from @medusajs/types 2.22, so a Medusa subscriber, job and route
 * accept what the bootstrap answers, and Medusa's container, logger, event
 * bus, request and response fit what the strategies take.
 */

import type {
  AuthenticatedMedusaRequest,
  Event as MedusaEvent,
  IEventBusModuleService,
  Logger,
  MedusaContainer as RealMedusaContainer,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/types';
import type { ActionBindingStrategy } from '@tsnomad/event';
import type { Request as HttpRequest } from '@tsnomad/http';
import type { Initializer } from '@tsnomad/loader';
import type { LoggerStrategy } from '@tsnomad/logger';
import type { RestStrategy } from '@tsnomad/rest';
import type { TaskStrategy } from '@tsnomad/tasks';
import {
  MedusaActionBindingStrategy,
  MedusaBootstrap,
  MedusaInitializer,
  MedusaLoggerStrategy,
  MedusaRestStrategy,
  MedusaTaskStrategy,
  medusaActorOf,
} from '@tsnomad/medusa-integration';
import type {
  MedusaActor,
  MedusaContainer,
  MedusaEventBus,
  MedusaHttpRequest,
  MedusaHttpResponse,
  MedusaLogger,
  RequestRunner,
} from '@tsnomad/medusa-integration';
import type { EventStrategy } from '@tsnomad/event';

/** Medusa's SubscriberArgs and ScheduledJobHandler, as @medusajs/framework 2.22 declares them. */
type RealSubscriberArgs<T> = { event: MedusaEvent<T>; container: RealMedusaContainer; pluginOptions: Record<string, unknown> };
type RealSubscriber = (args: RealSubscriberArgs<{ id: string }>) => Promise<void>;
type RealJob = (container: RealMedusaContainer, context?: { scheduledFor: Date }) => Promise<unknown>;
type RealRoute = (req: MedusaRequest, res: MedusaResponse) => Promise<void>;

declare const realContainer: RealMedusaContainer;
declare const realLogger: Logger;
declare const realBus: IEventBusModuleService;
declare const realRequest: MedusaRequest;
declare const realAuthedRequest: AuthenticatedMedusaRequest;
declare const realResponse: MedusaResponse;
declare const events: EventStrategy;
declare const logger: LoggerStrategy;
declare const runner: RequestRunner;
declare const controllerRequest: HttpRequest;
declare const unresolved: Partial<MedusaContainer>;

const container: MedusaContainer = realContainer;
const medusaLogger: MedusaLogger = realLogger;
const bus: MedusaEventBus = realBus;
const request: MedusaHttpRequest = realRequest;
const authedRequest: MedusaHttpRequest = realAuthedRequest;
const response: MedusaHttpResponse = realResponse;

const bootstrap = new MedusaBootstrap();
const subscriber: RealSubscriber = bootstrap.subscriber();
const job: RealJob = bootstrap.job(async () => {});
const route: RealRoute = bootstrap.route();
const authedRoute: (req: AuthenticatedMedusaRequest, res: MedusaResponse) => Promise<void> = bootstrap.route();
const taskSubscriber: RealSubscriber = bootstrap.tasks();

const actions: ActionBindingStrategy = new MedusaActionBindingStrategy(events, logger);
const rest: RestStrategy = new MedusaRestStrategy(runner, logger);
const tasks: TaskStrategy = new MedusaTaskStrategy(bus, logger, new Set<string>());
const actor: MedusaActor | null = medusaActorOf(controllerRequest);
const log: LoggerStrategy = new MedusaLoggerStrategy(realLogger);
const initializer: Initializer = new MedusaInitializer();

// @ts-expect-error a Medusa container must resolve by key
const noResolve: MedusaContainer = unresolved;

// @ts-expect-error the logger strategy takes Medusa's logger, not the container
new MedusaLoggerStrategy(realContainer);

// @ts-expect-error the task strategy takes Medusa's event bus, not the container
new MedusaTaskStrategy(realContainer, logger, new Set<string>());

// @ts-expect-error the task strategy needs the task events a subscriber file serves
new MedusaTaskStrategy(bus, logger);

// @ts-expect-error the action binding strategy needs the event strategy and a logger
new MedusaActionBindingStrategy(events);

// @ts-expect-error a route runner must answer a Response
const badRunner: RequestRunner = { handle: async () => undefined };

// @ts-expect-error the application's initializers come from a function, so a retry gets fresh ones
new MedusaBootstrap({ initializers: [] });
