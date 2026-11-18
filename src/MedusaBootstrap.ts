/**
 * MedusaBootstrap
 *
 * Builds one TS Nomad container per process from Medusa's app container,
 * the first time a subscriber, scheduled job or API route needs it, and
 * hands the same container to every later caller.
 *
 * Medusa module loaders cannot reach other modules or Query, while every
 * subscriber, job and route receives a container that can. So the boot
 * waits for the first of them. Create one `MedusaBootstrap` per
 * application, in one module that every subscriber, job and route file
 * imports, so the process shares it:
 *
 * ```ts
 * // src/tsnomad.ts
 * export const app = new MedusaBootstrap({ initializers: () => [new ReviewsInitializer()] });
 *
 * // src/subscribers/order-placed.ts
 * export default app.subscriber();
 * export const config = { event: 'order.placed' };
 *
 * // src/jobs/send-digest.ts
 * export default app.job(async (container) => (await container.get(DigestService)).send());
 * export const config = { name: 'send-digest', schedule: '0 * * * *' };
 *
 * // src/api/admin/reviews/[id]/route.ts
 * export const GET = app.route();
 *
 * // src/subscribers/tsnomad-tasks.ts, needed when an initializer has task handlers
 * export default app.tasks();
 * export const config = { event: app.taskEvents() };
 * ```
 *
 * `MedusaContainer` holds whichever Medusa container booted the process,
 * which is a request's scope when a route runs first. Resolve only
 * application-wide registrations from it, such as modules, `query` and
 * `logger`, never a registration scoped to one request.
 *
 * Where this differs from PHPNomad: a WordPress plugin boots from its main
 * file on every request. Medusa has no such moment that can reach Query,
 * so the boot is lazy, once per process.
 */

import { Container } from '@tsnomad/di-container';
import { Bootstrapper, hasTaskHandlers } from '@tsnomad/loader';
import type { Initializer } from '@tsnomad/loader';
import { LoggerStrategy } from '@tsnomad/logger';
import { MedusaActionBindingStrategy } from './MedusaActionBindingStrategy.js';
import { MedusaInitializer } from './MedusaInitializer.js';
import { MedusaRestStrategy } from './MedusaRestStrategy.js';
import { MedusaTaskStrategy, taskEventName } from './MedusaTaskStrategy.js';
import { MedusaContainer, MedusaEventBus, MedusaLogger, MedusaTaskEvents } from './medusa.js';
import type { MedusaJobHandler, MedusaRouteHandler, MedusaSubscriberHandler } from './medusa.js';

export interface MedusaBootstrapOptions {
  /**
   * Builds the application's initializers, loaded after
   * `MedusaInitializer`, in the order given. It is called once per boot
   * attempt, so a retry after a failed boot gets fresh instances.
   */
  initializers?: () => readonly Initializer[];
}

export class MedusaBootstrap {
  private readonly initializers: () => readonly Initializer[];
  private booted: Container | undefined;
  private pending: Promise<Container> | undefined;
  /** Every name `taskEvents()` has returned. */
  private readonly returnedTaskEvents = new Set<string>();
  /** Whether `tasks()` has been built, so a task subscriber file exists. */
  private tasksBuilt = false;
  /** What the boot binds to `MedusaTaskEvents`. */
  private readonly served: MedusaTaskEvents = {
    has: (name) => this.tasksBuilt && this.returnedTaskEvents.has(name),
  };

  constructor(options: MedusaBootstrapOptions = {}) {
    this.initializers = options.initializers ?? (() => []);
  }

  /**
   * Returns the booted container. The first call boots:
   *
   * 1. It creates a new `Container`.
   * 2. It binds `MedusaContainer` to `medusa`, and `MedusaLogger` and
   *    `MedusaEventBus` to factories that resolve `logger` and
   *    `event_bus` from `medusa` when first asked for. It binds
   *    `MedusaTaskEvents` to this bootstrap's served task events, see
   *    `taskEvents()`.
   * 3. It awaits `new Bootstrapper(container, new MedusaInitializer(),
   *    ...initializers()).load()`.
   *
   * Every call made while a boot runs waits for that boot and gets the
   * same container, so concurrent first calls boot once. After a boot
   * succeeds, every call returns that container at once, whatever
   * container it passes. Medusa hands subscribers and jobs the app
   * container and routes a request scope of it, and the first one to
   * arrive is the one kept.
   *
   * When the boot fails, the failure is logged once for that attempt,
   * with `medusa.resolve('logger').error('TS Nomad boot failed: <message>',
   * error)` so Medusa prints its stack, and every call waiting on it
   * rejects with the failure unchanged, such as the loader's
   * `LoaderException`. When resolving or calling that logger throws, one
   * `console.error('TS Nomad boot failed, and the Medusa logger threw while
   * reporting it', { error, loggerError })` line is written instead. Nothing
   * is kept, so the next call starts a new boot with a new container and
   * new initializers.
   *
   * @throws TypeError, through the returned promise and before anything
   *   is built, when `medusa` has no `resolve` function
   */
  async boot(medusa: MedusaContainer): Promise<Container> {
    if (medusa === null || typeof medusa !== 'object' || typeof (medusa as { resolve?: unknown }).resolve !== 'function') {
      throw new TypeError('MedusaBootstrap.boot needs a Medusa container with a resolve function');
    }
    if (this.booted) return this.booted;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const container = new Container();
      container.bindFactory(MedusaContainer, () => medusa);
      container.bindFactory(MedusaLogger, () => medusa.resolve('logger'));
      container.bindFactory(MedusaEventBus, () => medusa.resolve('event_bus'));
      container.bindFactory(MedusaTaskEvents, () => this.served);
      try {
        await new Bootstrapper(container, new MedusaInitializer(), ...this.initializers()).load();
      } catch (error) {
        try {
          medusa.resolve<MedusaLogger>('logger').error(`TS Nomad boot failed: ${error instanceof Error ? error.message : String(error)}`, error as Error);
        } catch (loggerError) {
          console.error('TS Nomad boot failed, and the Medusa logger threw while reporting it', { error, loggerError });
        }
        throw error;
      }
      return container;
    })();
    try {
      this.booted = await this.pending;
      return this.booted;
    } finally {
      this.pending = undefined;
    }
  }

  /**
   * A Medusa subscriber function. For each event it awaits
   * `this.boot(container)` with the subscriber's container, resolves
   * `MedusaActionBindingStrategy` from the booted container, and awaits
   * `runAction(event.name, event.data, event)` on it. A failure from the
   * boot or the bindings rejects unchanged, so Medusa's event bus logs it.
   */
  subscriber(): MedusaSubscriberHandler {
    return async ({ event, container }) => {
      const app = await this.boot(container);
      await (await app.get(MedusaActionBindingStrategy)).runAction(event.name, event.data, event);
    };
  }

  /**
   * A Medusa scheduled job function. Each run awaits `this.boot(container)`
   * with the job's container, then awaits `run` with the booted container.
   * When `run` throws, the failure is logged with `logException(error,
   * 'Scheduled job failed', {}, 'error')` through the booted container's
   * `LoggerStrategy`, since Medusa's job loader logs only the message, and
   * the job rejects with the failure unchanged. When that logger call
   * throws, it writes `console.error('Scheduled job failed, and the
   * logger threw while reporting it', { error, loggerError })` instead. A
   * failed boot rejects unchanged, logged by `boot`.
   */
  job(run: (container: Container) => void | Promise<void>): MedusaJobHandler {
    return async (container) => {
      const app = await this.boot(container);
      try {
        await run(app);
      } catch (error) {
        try {
          (await app.get(LoggerStrategy)).logException(error, 'Scheduled job failed', {}, 'error');
        } catch (loggerError) {
          console.error('Scheduled job failed, and the logger threw while reporting it', { error, loggerError });
        }
        throw error;
      }
    };
  }

  /**
   * A Medusa API route function. Each request awaits
   * `this.boot(req.scope)`, resolves `MedusaRestStrategy` from the booted
   * container, and awaits `handle(req, res)` on it. A
   * failure rejects unchanged, so Medusa's error handler responds to it.
   */
  route(): MedusaRouteHandler {
    return async (req, res) => {
      const app = await this.boot(req.scope);
      await (await app.get(MedusaRestStrategy)).handle(req, res);
    };
  }

  /**
   * A Medusa subscriber function for task events. For each event it awaits
   * `this.boot(container)` with the subscriber's container, resolves
   * `MedusaTaskStrategy` from the booted container, and awaits
   * `deliver(event)` on it. A failure from the boot or the delivery
   * rejects unchanged, so Medusa's event bus logs it.
   */
  tasks(): MedusaSubscriberHandler {
    this.tasksBuilt = true;
    return async ({ event, container }) => {
      const app = await this.boot(container);
      await (await app.get(MedusaTaskStrategy)).deliver(event);
    };
  }

  /**
   * The bus event names of every task class the application's initializers
   * hand the loader, for the `config.event` of the file that exports
   * `tasks()`. It builds the initializers with the `initializers` option,
   * reads `getTaskHandlers()` from each initializer that has it, and
   * returns `taskEventName` of each task class, in order, each name once.
   * It boots nothing and needs no container, so `getTaskHandlers()` must
   * not either.
   *
   * The bootstrap remembers every name it has returned. Once `tasks()`
   * has also been built, the `MedusaTaskEvents` it binds has those names,
   * which is how `MedusaTaskStrategy` knows a subscriber file serves a
   * task before it emits one. A file whose `config.event` is written by
   * hand leaves them out, and its tasks are refused at dispatch.
   *
   * @throws TypeError when a task class has no usable static id
   */
  taskEvents(): string[] {
    const names: string[] = [];
    for (const initializer of this.initializers()) {
      if (!hasTaskHandlers(initializer)) continue;
      for (const [taskClass] of initializer.getTaskHandlers()) {
        const name = taskEventName(taskClass as never);
        if (!names.includes(name)) names.push(name);
      }
    }
    for (const name of names) this.returnedTaskEvents.add(name);
    return names;
  }
}
