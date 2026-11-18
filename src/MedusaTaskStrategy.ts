/**
 * MedusaTaskStrategy
 *
 * The `TaskStrategy` for Medusa, the counterpart to `WordPressTaskStrategy`
 * in PHPNomad's WordPress integration. WordPress queues a task on Action
 * Scheduler and runs it from a hook. This strategy emits it on Medusa's
 * event bus, and a subscriber file built with `MedusaBootstrap.tasks()`
 * hands each delivered event back to `deliver`. Medusa loads that file
 * in every process when it starts, so a worker that has not booted yet
 * still takes the event, boots, and runs the task. Handlers live in the
 * container and Medusa's files own every bus subscription, so a failed
 * boot leaves nothing behind.
 *
 * With Medusa's default local event bus the task runs in the same
 * process, soon after the code that dispatched it. With the Redis event
 * bus it runs in whichever process takes the event.
 *
 * Retries. Neither bus retries a failed task by default. The local bus
 * logs the failure and never runs the event again. The Redis bus runs it
 * again only when the application sets more than one attempt in the Redis
 * module's `jobOptions`, which applies to every Medusa event, not only
 * tasks. After the last attempt the event is gone, with no record beyond
 * the error lines, and each attempt writes the same line. A retried run
 * starts from the first handler, so every handler must be safe to run
 * more than once, as the loader already requires. The strategy passes no
 * options to `emit`, so it never sets a retry policy of its own.
 *
 * This is not a durable queue. Neither bus promises to keep an event
 * through a crash or a restart, and a task that fails its last attempt is
 * dropped. Treat a task as a nudge to do work whose state lives in the
 * application's own tables, and let the domain that owns those tables
 * settle work a lost or failed task left undone.
 *
 * Each task class has one bus event, named `TASK_EVENT_PREFIX` plus the
 * task id, such as `tsnomad.task.catalog.sync-products`. `taskEventName`
 * returns it.
 *
 * `dispatch(task)` checks everything before it emits, so a task that
 * cannot travel fails where it was dispatched:
 *
 * 1. The task must be an object whose class has a static id, read with
 *    `taskIdOf`, and a `toPayload` method.
 * 2. At least one handler must be attached for that id in this process.
 * 3. `MedusaTaskEvents` must have the task's event name, so a task
 *    subscriber file serves it. Medusa drops an event no subscriber
 *    listens to without a word, so a missing or hand-written task file
 *    would lose every task of that class.
 * 4. The payload must be a plain object. It goes through `JSON.stringify`
 *    and `JSON.parse`, and the class's `fromPayload` must rebuild a task
 *    from the result.
 *
 * Then it awaits `emit({ name: <event name>, data: { payload } })` with
 * the parsed payload and no second argument, and resolves when the bus
 * has accepted the event. Any failed check, and an emit that rejects,
 * rejects with `TaskDispatchFailedException` naming the task id where
 * there is one, with the underlying error as `cause`. For checks 2 and 3
 * the cause is a TypeError naming the event. A failed check emits
 * nothing.
 *
 * When the logger throws while it reports a delivery failure, the
 * strategy writes one `console.error` line instead, given with each method
 * below, so neither error is lost, and goes on as if the logger had
 * returned.
 *
 * Where this differs from PHPNomad:
 *
 * - The application hands the strategy its `IdempotencyStore` with
 *   `useIdempotencyStore`, after the container is built, where PHPNomad's
 *   strategies take theirs in the constructor. Medusa has no store of its
 *   own that can take a lock only when it is free, since its cache module
 *   has only get, set and invalidate, so the application builds one over
 *   its own database and the strategy works without one until then.
 *   Without a store a task dispatched twice runs twice, keyed or not.
 * - There is no payload signature. WordPress signs the payload because
 *   Action Scheduler keeps it in a table other plugins can write to.
 *   Medusa's bus is the application's own process or its own Redis.
 * - Handlers live in the strategy, not in a separate registry.
 * - `dispatch` refuses a task with no handler in this process and checks
 *   the payload's trip through JSON, as TS Nomad's in-process strategy
 *   does.
 * - Failures are logged at the error level. `logException`'s default is
 *   critical.
 * - A delivered event that is not a task, or has no handler here, is
 *   logged at error level. WordPress's `handleTask` returns without a
 *   word.
 * - `deliver` logs and drops a payload that `fromPayload` cannot rebuild
 *   whatever it throws. WordPress catches only `TaskCreateFailedException`
 *   and lets anything else fail the run. A rebuild that failed once fails
 *   on every attempt, so a retry would only repeat it.
 *
 * Task event names are shared by the whole Medusa application, so one
 * bootstrap serves it, plugins included. Two bootstraps that both handle
 * a task id would each receive the other's tasks.
 */

import { LoggerStrategy } from '@tsnomad/logger';
import { TaskDispatchFailedException, taskIdOf } from '@tsnomad/tasks';
import type { IdempotencyStore, IsIdempotent, Task, TaskClass, TaskPayload, TaskStrategy } from '@tsnomad/tasks';
import { MedusaEventBus, MedusaTaskEvents } from './medusa.js';
import type { MedusaEventMessage } from './medusa.js';

/** The start of the event bus name that carries a task. */
export const TASK_EVENT_PREFIX = 'tsnomad.task.';

/**
 * The event bus name that carries tasks of this class:
 * `TASK_EVENT_PREFIX` plus the class's id.
 *
 * @throws TypeError when the class has no usable static id, see `taskIdOf`
 */
export function taskEventName(taskClass: TaskClass): string {
  return TASK_EVENT_PREFIX + taskIdOf(taskClass);
}

/** A handler as the strategy keeps it, for any task of its class. */
type Handler = (task: Task) => void | Promise<void>;

/** The handlers attached for one task id, with the class that rebuilds its tasks. */
interface HandlerEntry {
  readonly taskClass: TaskClass;
  readonly list: Handler[];
}

export class MedusaTaskStrategy implements TaskStrategy {
  static readonly inject = [MedusaEventBus, LoggerStrategy, MedusaTaskEvents] as const;

  /** How long a run holds a task's idempotency lock, longer than the longest run. PHPNomad's Redis worker also uses 600. */
  static readonly LOCK_TTL_SECONDS = 600;

  private readonly handlers = new Map<string, HandlerEntry>();

  /** The store `useIdempotencyStore` set, or null. */
  protected idempotency: IdempotencyStore | null = null;

  constructor(
    private readonly bus: MedusaEventBus,
    private readonly logger: LoggerStrategy,
    private readonly served: MedusaTaskEvents,
  ) {}

  /**
   * Adds a handler for the class's id, after any already attached. The
   * same handler attached twice runs twice.
   *
   * @throws TypeError when the class has no usable static id, see
   *   `taskIdOf`, or the handler is not a function. Nothing is attached
   *   from a refused call.
   */
  attach<T extends Task>(taskClass: TaskClass<T>, handler: (task: T) => void | Promise<void>): void {
    const id = taskIdOf(taskClass);
    if (typeof handler !== 'function') throw new TypeError(`attach '${id}': the handler is not a function`);
    const entry = this.handlers.get(id);
    if (entry) entry.list.push(handler as Handler);
    else this.handlers.set(id, { taskClass, list: [handler as Handler] });
  }

  /**
   * Sets the store that `deliver` runs keyed tasks through, from the next
   * delivery on, or removes it with null. See `deliver`.
   */
  useIdempotencyStore(store: IdempotencyStore | null): void {
    this.idempotency = store;
  }

  /**
   * @throws TaskDispatchFailedException, through the returned promise,
   *   when a check above fails or the bus refuses the event
   */
  async dispatch(task: Task): Promise<void> {
    let id: string | undefined;
    let payload: TaskPayload;
    try {
      id = taskIdOf(task);
      if (typeof task.toPayload !== 'function') throw new TypeError(`task '${id}' has no toPayload method`);
      const entry = this.handlers.get(id);
      if (!entry) throw new TypeError(`no handler is attached for task '${id}', event '${TASK_EVENT_PREFIX + id}'`);
      if (!this.served.has(TASK_EVENT_PREFIX + id)) throw new TypeError(`no task subscriber file serves task '${id}', event '${TASK_EVENT_PREFIX + id}'`);
      const raw = task.toPayload();
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new TypeError(`the payload of task '${id}' is not a plain object`);
      payload = JSON.parse(JSON.stringify(raw));
      entry.taskClass.fromPayload(payload);
    } catch (error) {
      throw new TaskDispatchFailedException(id ? `Task '${id}' could not be dispatched: ${(error as Error).message}` : `The value could not be dispatched: ${(error as Error).message}`, { cause: error });
    }
    try {
      await this.bus.emit({ name: TASK_EVENT_PREFIX + id, data: { payload: payload! } });
    } catch (error) {
      throw new TaskDispatchFailedException(`Task '${id}' could not be dispatched: the event bus refused it`, { cause: error });
    }
  }

  /**
   * Runs one delivered task event. It rebuilds the task with
   * `fromPayload(data.payload)` and runs the id's handlers one at a time,
   * in attach order, each awaited, all with that one rebuilt task.
   *
   * - When the event's name does not start with `TASK_EVENT_PREFIX`, or no
   *   handler is attached for its task id in this process, it logs
   *   `error("'<name>' is not a task event", { event: <name> })` or
   *   `error("No handler is attached for task '<id>' in this process", {
   *   event: <name>, payload: <data.payload> })`, runs nothing, and
   *   resolves. Both are wiring mistakes that would fail the same way on
   *   every attempt. When that logger call throws, it writes
   *   `console.error(<the same message> + ', and the logger threw while
   *   reporting it', { ...<the same context>, loggerError })` instead and
   *   still resolves.
   * - When `fromPayload` throws anything, no handler runs, the error is
   *   logged with `logException(error, "Task '<id>' could not be rebuilt",
   *   { task: <id>, payload: <data.payload> }, 'error')`, and the delivery
   *   resolves, since running it again would fail the same way. When that
   *   logger call throws, it writes `console.error("Task '<id>' could not
   *   be rebuilt, and the logger threw while reporting it", { task: <id>,
   *   payload: <data.payload>, error, loggerError })` and still resolves.
   * - When a handler throws, later handlers do not run, the error is
   *   logged with `logException(error, "Task '<id>' failed", context,
   *   'error')`, and the delivery rejects with that error unchanged, so
   *   the bus counts the run as failed. The context is `{ task: <id>,
   *   payload: <data.payload> }`, plus `idempotencyKey` when the rebuilt
   *   task implements `IsIdempotent`. When that logger call throws, it
   *   writes `console.error("Task '<id>' failed, and the logger threw
   *   while reporting it", { task: <id>, payload: <data.payload>, error,
   *   loggerError })` and still rejects with the handler's error.
   *   The key is read only while a failure is reported. When the task's
   *   `idempotencyKey()` throws there, the same `console.error` line is
   *   written, with the key's error as `loggerError`, and the delivery
   *   still rejects with the handler's error.
   *
   * A handler that meets a failure no later run could fix, such as a
   * record that no longer exists, may log it and return. A failure that a
   * later run could fix, such as a network error, must be thrown.
   *
   * With an `IdempotencyStore` set and a rebuilt task that implements
   * `IsIdempotent`, the run follows the store's order (see
   * `IdempotencyStore`), with `<id>` the task id and `ctx` the context
   * `{ task: <id>, idempotencyKey: <its key> }`:
   *
   * 1. `isDone(task)`. True: `debug("Task '<id>' was skipped: its
   *    idempotency key is already done", ctx)`, and the delivery
   *    resolves with no handler run.
   * 2. `acquire(task, LOCK_TTL_SECONDS)`. Null: `debug("Task '<id>' was
   *    skipped: another run holds its idempotency key", ctx)`, and it
   *    resolves with no handler run. A lock left by a run that crashed
   *    holds the key until it lapses, and a delivery skipped meanwhile is
   *    gone, as any event the bus drops is (see Retries). A consumer that
   *    must not lose such a task keeps it durably and sends it again.
   * 3. `isDone(task)` again. True: `release(task, token)`, the step 1
   *    line, and it resolves with no handler run. A release that rejects
   *    there logs `logException(releaseError, "Task '<id>' failed, and
   *    its idempotency lock could not be released", ctx, 'error')`, and
   *    the delivery still resolves, since the key is done.
   * 4. The handlers, as above.
   * 5. Every handler succeeded: `markDone(task, token,
   *    task.idempotencyTtlSeconds())`. When that rejects it logs
   *    `logException(error, "Task '<id>' ran, but its idempotency key
   *    could not be marked done", ctx, 'error')` and still resolves, so
   *    the bus does not deliver it again. The lock holds the key until
   *    it lapses after `LOCK_TTL_SECONDS`, and a delivery of the same key
   *    after that runs the handlers again.
   * 6. A handler threw: after the failure line above, `release(task,
   *    token)`. When that rejects it logs `logException(releaseError,
   *    "Task '<id>' failed, and its idempotency lock could not be
   *    released", ctx, 'error')`. Either way the delivery rejects with
   *    the handler's error.
   *
   * When `isDone` or `acquire` rejects in steps 1 to 3, no handler runs,
   * it logs `logException(error, "Task '<id>' could not check its
   * idempotency key", ctx, 'error')`, and the delivery rejects with that
   * error, so a bus that retries runs the task again. When the second
   * `isDone` rejects, the lock is held, so after that line it also calls
   * `release(task, token)`, so the retry finds the key free. A release
   * that rejects there logs the step 6 line, and the delivery still
   * rejects with `isDone`'s error. A task that does
   * not implement `IsIdempotent`, and every task while no store is set,
   * runs as described above without touching a store. A task whose
   * `idempotencyKey()` throws is treated as a handler failure in step 1:
   * it is reported, nothing runs, and the delivery rejects.
   */
  async deliver(message: MedusaEventMessage): Promise<void> {
    const name: unknown = message.name;
    if (typeof name !== 'string' || !name.startsWith(TASK_EVENT_PREFIX)) {
      this.line(`'${String(name)}' is not a task event`, { event: name });
      return;
    }
    const id = name.slice(TASK_EVENT_PREFIX.length);
    const payload = (message.data as { payload?: unknown } | null | undefined)?.payload;
    const entry = this.handlers.get(id);
    if (!entry) {
      this.line(`No handler is attached for task '${id}' in this process`, { event: name, payload });
      return;
    }

    let task: Task;
    try {
      task = entry.taskClass.fromPayload(payload as TaskPayload);
    } catch (error) {
      this.report(error, `Task '${id}' could not be rebuilt`, { task: id, payload });
      return;
    }

    // Read once, so a store set while this task runs applies from the next delivery.
    const store = this.idempotency;
    if (store === null || !isKeyed(task)) {
      await this.runHandlers(id, entry, task, payload);
      return;
    }
    await this.runOnce(store, id, entry, task, payload);
  }

  /**
   * Runs the handlers one at a time, in attach order. A handler that
   * throws stops the rest, is reported, and its error is rethrown.
   */
  private async runHandlers(id: string, entry: HandlerEntry, task: Task, payload: unknown): Promise<void> {
    // A copy, so a handler attached while the task runs waits for the next task.
    for (const handler of [...entry.list]) {
      try {
        await handler(task);
      } catch (error) {
        this.report(error, `Task '${id}' failed`, { task: id, payload }, task);
        throw error;
      }
    }
  }

  /**
   * Runs a keyed task through the store, in the order `deliver` gives:
   * check, lock, check again, run, then mark done or release.
   */
  private async runOnce(store: IdempotencyStore, id: string, entry: HandlerEntry, task: Task & IsIdempotent, payload: unknown): Promise<void> {
    let key: string;
    try {
      key = task.idempotencyKey();
    } catch (error) {
      // A key that cannot be read fails like a handler, before anything runs.
      this.report(error, `Task '${id}' failed`, { task: id, payload }, task);
      throw error;
    }
    const ctx = { task: id, idempotencyKey: key };
    const doneLine = `Task '${id}' was skipped: its idempotency key is already done`;
    const checkLine = `Task '${id}' could not check its idempotency key`;

    let token: string | null;
    try {
      if (await store.isDone(task)) {
        this.skip(doneLine, ctx);
        return;
      }
      token = await store.acquire(task, MedusaTaskStrategy.LOCK_TTL_SECONDS);
    } catch (error) {
      this.storeFailure(error, checkLine, ctx);
      throw error;
    }
    if (token === null) {
      this.skip(`Task '${id}' was skipped: another run holds its idempotency key`, ctx);
      return;
    }

    let doneMeanwhile: boolean;
    try {
      doneMeanwhile = await store.isDone(task);
    } catch (error) {
      // The lock is held, so free it before the retry the rejection asks for.
      this.storeFailure(error, checkLine, ctx);
      await this.release(store, id, task, token, ctx);
      throw error;
    }
    if (doneMeanwhile) {
      await this.release(store, id, task, token, ctx);
      this.skip(doneLine, ctx);
      return;
    }

    try {
      await this.runHandlers(id, entry, task, payload);
    } catch (error) {
      await this.release(store, id, task, token, ctx);
      throw error;
    }

    try {
      await store.markDone(task, token, task.idempotencyTtlSeconds());
    } catch (error) {
      this.storeFailure(error, `Task '${id}' ran, but its idempotency key could not be marked done`, ctx);
    }
  }

  /** Releases the run's lock, logging a release that rejects. Never rejects. */
  private async release(store: IdempotencyStore, id: string, task: Task & IsIdempotent, token: string, ctx: Record<string, unknown>): Promise<void> {
    try {
      await store.release(task, token);
    } catch (releaseError) {
      this.storeFailure(releaseError, `Task '${id}' failed, and its idempotency lock could not be released`, ctx);
    }
  }

  /**
   * Logs a store failure with its error at error level. When the logger
   * throws, writes the line, its context and both errors with
   * `console.error`.
   */
  private storeFailure(error: unknown, message: string, context: Record<string, unknown>): void {
    try {
      this.logger.logException(error, message, context, 'error');
    } catch (loggerError) {
      console.error(`${message}, and the logger threw while reporting it`, { ...context, error, loggerError });
    }
  }

  /**
   * Logs an expected skip at debug level. When the logger throws, writes
   * the line, its context and the logger's error with `console.error`.
   */
  private skip(message: string, context: Record<string, unknown>): void {
    try {
      this.logger.debug(message, context);
    } catch (loggerError) {
      console.error(`${message}, and the logger threw while reporting it`, { ...context, loggerError });
    }
  }

  /**
   * Logs a failure with its error at error level, adding the idempotency
   * key of `task` when it implements `IsIdempotent`. When the logger
   * throws, writes the line, the task's id and payload and both errors
   * with `console.error`, so neither error is lost. A task whose own
   * `idempotencyKey()` throws lands there too, with that error as
   * `loggerError`, as in TS Nomad's in-process strategy.
   */
  private report(error: unknown, message: string, context: Record<string, unknown>, task?: Task): void {
    try {
      const keyed = task as Partial<IsIdempotent> | undefined;
      const logged = typeof keyed?.idempotencyKey === 'function' ? { ...context, idempotencyKey: keyed.idempotencyKey() } : context;
      this.logger.logException(error, message, logged, 'error');
    } catch (loggerError) {
      console.error(`${message}, and the logger threw while reporting it`, { task: context.task, payload: context.payload, error, loggerError });
    }
  }

  /**
   * Logs a wiring mistake at error level. When the logger throws, writes
   * the line, its context and the logger's error with `console.error`.
   */
  private line(message: string, context: Record<string, unknown>): void {
    try {
      this.logger.error(message, context);
    } catch (loggerError) {
      console.error(`${message}, and the logger threw while reporting it`, { ...context, loggerError });
    }
  }
}

/** True when the task implements `IsIdempotent`: it has both of its methods. */
function isKeyed(task: Task): task is Task & IsIdempotent {
  const keyed = task as Partial<IsIdempotent> | null | undefined;
  return typeof keyed?.idempotencyKey === 'function' && typeof keyed.idempotencyTtlSeconds === 'function';
}
