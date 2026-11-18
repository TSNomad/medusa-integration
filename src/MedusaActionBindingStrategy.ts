/**
 * MedusaActionBindingStrategy
 *
 * The `ActionBindingStrategy` for Medusa, the counterpart to the
 * `ActionBindingStrategy` in PHPNomad's WordPress integration. A Medusa
 * action is an event bus event name, such as `order.placed`.
 *
 * WordPress registers a callback with `add_action`, and WordPress calls it
 * when the hook fires. Medusa loads its subscribers from files when the
 * application starts, before TS Nomad boots, so this strategy cannot add a
 * subscriber of its own. It keeps the bindings instead, and a subscriber
 * file hands each event to `runAction`, usually through
 * `MedusaBootstrap.subscriber()`. The subscriber file names the events it
 * listens to, and the bindings say what each one raises.
 *
 * Medusa awaits a subscriber, so `runAction` returns every failure to it,
 * as the `ActionBindingStrategy` contract asks of a platform that waits.
 * It also logs each failure through `LoggerStrategy` first, with the
 * action and event id, since Medusa's event bus logs only the rejection's
 * message. The Redis event bus runs a failed subscriber again when the
 * application configures more than one attempt, and that run starts from
 * the first binding, so a listener must be safe to run more than once.
 * This strategy retries nothing itself.
 */

import { EventStrategy, eventIdOf } from '@tsnomad/event';
import type { ActionBindingStrategy, ActionTransformer, Event, EventClass } from '@tsnomad/event';
import { LoggerStrategy } from '@tsnomad/logger';

/** One recorded binding: the bound id, the class when bound by class, and the transformer. */
interface Binding {
  readonly eventId: string;
  readonly eventClass?: EventClass;
  readonly transformer?: ActionTransformer;
}

export class MedusaActionBindingStrategy implements ActionBindingStrategy {
  static readonly inject = [EventStrategy, LoggerStrategy] as const;

  /** The bindings of each action, in bind order. */
  private readonly bindings = new Map<string, Binding[]>();

  constructor(
    private readonly events: EventStrategy,
    private readonly logger: LoggerStrategy,
  ) {}

  /**
   * Records one binding of `action` to an event. Nothing is raised until
   * `runAction(action, ...)` runs. Binding the same event and action again
   * adds a second binding, which runs as well, as a second `add_action`
   * does in WordPress.
   *
   * @param event - An event class, read through `eventIdOf`, or an event
   *   id string, which needs a transformer
   * @param action - The Medusa event name, such as 'order.placed'
   * @param transformer - Builds the event from the action's arguments.
   *   Without one, `runAction` builds the event class with `new`.
   * @throws TypeError naming the action when the action is not a non-empty
   *   string, the event class has no static id, the id string is empty,
   *   an id string comes with no transformer, or the transformer is given
   *   and is not a function. Nothing is recorded from a refused call.
   */
  bindAction<E extends Event>(eventClass: EventClass<E>, action: string, transformer?: ActionTransformer<E>): void;
  bindAction<E extends Event = Event>(eventId: string, action: string, transformer: ActionTransformer<E>): void;
  bindAction(event: EventClass | string, action: string, transformer?: ActionTransformer): void {
    if (typeof action !== 'string' || action === '') throw new TypeError(`bindAction: the action must be a non-empty string, not ${String(action)}`);
    if (transformer !== undefined && typeof transformer !== 'function') throw new TypeError(`bindAction '${action}': the transformer is not a function`);
    let eventId: string;
    let eventClass: EventClass | undefined;
    if (typeof event === 'string') {
      if (event === '') throw new TypeError(`bindAction '${action}': the event id is empty`);
      if (transformer === undefined) throw new TypeError(`bindAction '${action}': an event id needs a transformer`);
      eventId = event;
    } else {
      try {
        eventId = eventIdOf(event);
      } catch (error) {
        throw new TypeError(`bindAction '${action}': ${(error as Error).message}`, { cause: error });
      }
      eventClass = event;
    }
    const list = this.bindings.get(action) ?? [];
    list.push({ eventId, eventClass, transformer });
    this.bindings.set(action, list);
  }

  /**
   * Runs every binding of `action`, one at a time, in the order they were
   * bound, each awaited before the next starts. For each binding it:
   *
   * 1. Builds the event: awaits `transformer(...args)`, or calls
   *    `new eventClass(...args)` when the binding has no transformer.
   * 2. Raises nothing for a result of null.
   * 3. Refuses any result that is not an object, `undefined` included,
   *    with a TypeError naming the action, and refuses an object whose id,
   *    read through `eventIdOf`, is not the bound id, with a TypeError
   *    naming the action and both ids.
   * 4. Awaits `EventStrategy.broadcast(event)`.
   *
   * An action with no bindings logs `error("No TS Nomad binding for
   * action '<action>'", { action })` and resolves, since a subscriber file
   * that names an unbound event is a wiring mistake that every retry would
   * repeat. The REST strategy logs a request with no route at the same
   * level. When that logger call throws, it writes `console.error("No TS
   * Nomad binding for action '<action>', and the logger threw while
   * reporting it", { action, loggerError })` instead and still resolves.
   *
   * A failure at any step ends that binding, is logged at once with
   * `logException(error, "Action '<action>' failed for event '<id>'", {
   * action, eventId: <id> }, 'error')`, and the next binding still runs.
   * When that logger call throws, it writes `console.error("Action
   * '<action>' failed for event '<id>', and the logger threw while
   * reporting it", { action, eventId: <id>, error, loggerError })` instead
   * and goes on. When every binding succeeded it resolves. Otherwise it
   * rejects once, after the last binding, with an `AggregateError` whose
   * `errors` hold each binding failure unchanged, in run order, and whose
   * message is `<n> binding(s) failed for action '<action>': ` followed by
   * each failure's message, joined by ` | `.
   *
   * @param action - The Medusa event name the subscriber received
   * @param args - What the transformer receives. `MedusaBootstrap.subscriber()`
   *   passes the event's `data` and then the whole event message.
   */
  async runAction(action: string, ...args: unknown[]): Promise<void> {
    const bindings = this.bindings.get(action) ?? [];
    if (bindings.length === 0) {
      const message = `No TS Nomad binding for action '${action}'`;
      try {
        this.logger.error(message, { action });
      } catch (loggerError) {
        console.error(`${message}, and the logger threw while reporting it`, { action, loggerError });
      }
      return;
    }
    const errors: unknown[] = [];
    for (const binding of [...bindings]) {
      try {
        const answer: unknown = binding.transformer ? await binding.transformer(...args) : new (binding.eventClass as any)(...args);
        if (answer === null) continue;
        if (typeof answer !== 'object') throw new TypeError(`Action '${action}': the transformer answered ${String(answer)}, not an event or null`);
        const id = eventIdOf(answer as Event);
        if (id !== binding.eventId) throw new TypeError(`Action '${action}': the event's id is '${id}', but the binding is for '${binding.eventId}'`);
        await this.events.broadcast(answer as never);
      } catch (error) {
        const message = `Action '${action}' failed for event '${binding.eventId}'`;
        try {
          this.logger.logException(error, message, { action, eventId: binding.eventId }, 'error');
        } catch (loggerError) {
          console.error(`${message}, and the logger threw while reporting it`, { action, eventId: binding.eventId, error, loggerError });
        }
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      const messages = errors.map((error) => (error instanceof Error ? error.message : String(error))).join(' | ');
      throw new AggregateError(errors, `${errors.length} binding(s) failed for action '${action}': ${messages}`);
    }
  }
}
