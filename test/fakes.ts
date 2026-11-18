/**
 * A fake Medusa for the tests: an app container, its logger and event bus,
 * and an API route's request and response. Plus a recording TS Nomad
 * logger, events, tasks and a plain http Response.
 */

import type { Event } from '@tsnomad/event';
import type { Response as HttpResponse } from '@tsnomad/http';
import type { LogContext, LoggerLevel, LoggerStrategy } from '@tsnomad/logger';
import { TaskCreateFailedException } from '@tsnomad/tasks';
import type { Task, TaskPayload } from '@tsnomad/tasks';
import type {
  MedusaContainer,
  MedusaEventBus,
  MedusaEventMessage,
  MedusaHttpRequest,
  MedusaHttpResponse,
  MedusaLogger,
} from '@tsnomad/medusa-integration';

/** Medusa's logger, recording each call with its method name. */
export class FakeMedusaLogger implements MedusaLogger {
  readonly calls: unknown[][] = [];
  error(messageOrError: string | Error, error?: Error): void {
    this.calls.push(arguments.length > 1 ? ['error', messageOrError, error] : ['error', messageOrError]);
  }
  warn(...args: unknown[]): void {
    this.calls.push(['warn', ...args]);
  }
  info(...args: unknown[]): void {
    this.calls.push(['info', ...args]);
  }
  debug(...args: unknown[]): void {
    this.calls.push(['debug', ...args]);
  }
  /** Medusa's panic ends the process. No strategy may call it. */
  panic(data: unknown): void {
    this.calls.push(['panic', data]);
  }
  verbose(message: string): void {
    this.calls.push(['verbose', message]);
  }
  log(...args: unknown[]): void {
    this.calls.push(['log', ...args]);
  }
}

/** Medusa's event bus. Emitted events wait until a test takes them. */
export class FakeEventBus implements MedusaEventBus {
  readonly emitted: MedusaEventMessage[] = [];
  /** The arguments of every emit call, as given. */
  readonly emitCalls: unknown[][] = [];
  /** When set, the next emit rejects with it. */
  failNextEmit: unknown = undefined;

  async emit(data: MedusaEventMessage | MedusaEventMessage[], ...rest: unknown[]): Promise<void> {
    this.emitCalls.push([data, ...rest]);
    if (this.failNextEmit !== undefined) {
      const error = this.failNextEmit;
      this.failNextEmit = undefined;
      throw error;
    }
    this.emitted.push(...(Array.isArray(data) ? data : [data]));
  }

  /**
   * Answers everything emitted so far, in order, each after a trip through
   * JSON as the Redis bus would carry it, and forgets it.
   */
  drain(): MedusaEventMessage[] {
    return this.emitted.splice(0).map((message) => JSON.parse(JSON.stringify(message)) as MedusaEventMessage);
  }
}

/**
 * Medusa's app container. It answers the registrations it was given and
 * throws for any other key, as Awilix does, and counts each resolve.
 */
export class FakeMedusaContainer implements MedusaContainer {
  readonly resolved: string[] = [];
  constructor(readonly registrations: Record<string, unknown> = {}) {}

  resolve<T = unknown>(key: string): T {
    this.resolved.push(key);
    if (!(key in this.registrations)) {
      throw new Error(`Could not resolve '${key}'`);
    }
    return this.registrations[key] as T;
  }
}

/**
 * A fake Medusa with a logger and an event bus registered under Medusa's
 * names. `scope()` answers a new container with the same registrations,
 * as Medusa hands a route a request scope of its app container.
 */
export function fakeMedusa(): { container: FakeMedusaContainer; logger: FakeMedusaLogger; bus: FakeEventBus; scope: () => FakeMedusaContainer } {
  const logger = new FakeMedusaLogger();
  const bus = new FakeEventBus();
  const registrations = { logger, event_bus: bus };
  return { container: new FakeMedusaContainer(registrations), logger, bus, scope: () => new FakeMedusaContainer(registrations) };
}

/** A TS Nomad logger that records every call, `logException` included. */
export class RecordingLogger implements LoggerStrategy {
  readonly calls: unknown[][] = [];
  emergency(message: string, context?: LogContext): void {
    this.calls.push(['emergency', message, context]);
  }
  alert(message: string, context?: LogContext): void {
    this.calls.push(['alert', message, context]);
  }
  critical(message: string, context?: LogContext): void {
    this.calls.push(['critical', message, context]);
  }
  error(message: string, context?: LogContext): void {
    this.calls.push(['error', message, context]);
  }
  warning(message: string, context?: LogContext): void {
    this.calls.push(['warning', message, context]);
  }
  notice(message: string, context?: LogContext): void {
    this.calls.push(['notice', message, context]);
  }
  info(message: string, context?: LogContext): void {
    this.calls.push(['info', message, context]);
  }
  debug(message: string, context?: LogContext): void {
    this.calls.push(['debug', message, context]);
  }
  logException(error: unknown, message?: string, context?: LogContext, level?: LoggerLevel): void {
    this.calls.push(['logException', error, message, context, level]);
  }
}

/** A TS Nomad logger whose `error` and `logException` throw `ThrowingLogger.failure` after recording the call. */
export class ThrowingLogger extends RecordingLogger {
  static readonly failure = new Error('logger broke');
  override error(message: string, context?: LogContext): void {
    super.error(message, context);
    throw ThrowingLogger.failure;
  }
  override logException(error: unknown, message?: string, context?: LogContext, level?: LoggerLevel): void {
    super.logException(error, message, context, level);
    throw ThrowingLogger.failure;
  }
}

/** Every task event the fake task classes use, as a task subscriber file would serve them. */
export function servedTaskEvents(): Set<string> {
  return new Set(
    ['catalog.sync-products', 'reports.send', 'orders.export', 'numbers.big', 'tasks.unbuildable', 'tasks.list-payload', 'tasks.broken-rebuild'].map(
      (id) => `tsnomad.task.${id}`,
    ),
  );
}

/** An event built from a Medusa event's data, `{ id }`. */
export class OrderPlaced implements Event {
  static getId(): string {
    return 'shop.order-placed';
  }
  readonly orderId: string;
  readonly extra: unknown[];
  constructor(data: { id: string }, ...extra: unknown[]) {
    this.orderId = data.id;
    this.extra = extra;
  }
}

export class OrderCompleted implements Event {
  static getId(): string {
    return 'shop.order-completed';
  }
  constructor(readonly orderId: string) {}
}

/** A class with no static id, so it is no event class. */
export class NotAnEvent {
  constructor(readonly value: string) {}
}

export class SyncProducts implements Task {
  static rebuilt = 0;
  static getId(): string {
    return 'catalog.sync-products';
  }
  static fromPayload(payload: TaskPayload): SyncProducts {
    if (typeof payload.cursor !== 'string') throw new TaskCreateFailedException('cursor must be a string');
    SyncProducts.rebuilt++;
    return new SyncProducts(payload.cursor, payload.at === undefined ? undefined : String(payload.at));
  }
  constructor(
    readonly cursor: string,
    readonly at?: unknown,
  ) {}
  toPayload(): TaskPayload {
    return this.at === undefined ? { cursor: this.cursor } : { cursor: this.cursor, at: this.at };
  }
}

export class SendReport implements Task {
  static getId(): string {
    return 'reports.send';
  }
  static fromPayload(payload: TaskPayload): SendReport {
    return new SendReport(String(payload.name));
  }
  constructor(readonly name: string) {}
  toPayload(): TaskPayload {
    return { name: this.name };
  }
}

/** A task that names its logical work. */
export class ExportOrder implements Task {
  static getId(): string {
    return 'orders.export';
  }
  static fromPayload(payload: TaskPayload): ExportOrder {
    return new ExportOrder(String(payload.order));
  }
  constructor(readonly order: string) {}
  toPayload(): TaskPayload {
    return { order: this.order };
  }
  idempotencyKey(): string {
    return `orders.export:${this.order}`;
  }
  idempotencyTtlSeconds(): number {
    return 60;
  }
}

/** A task whose payload JSON cannot carry. */
export class BigIntTask implements Task {
  static getId(): string {
    return 'numbers.big';
  }
  static fromPayload(payload: TaskPayload): BigIntTask {
    return new BigIntTask();
  }
  toPayload(): TaskPayload {
    return { value: 10n };
  }
}

/** A task whose class cannot rebuild it. */
export class Unbuildable implements Task {
  static readonly failure = new TaskCreateFailedException('cannot rebuild');
  static getId(): string {
    return 'tasks.unbuildable';
  }
  static fromPayload(payload: TaskPayload): Unbuildable {
    throw Unbuildable.failure;
  }
  toPayload(): TaskPayload {
    return {};
  }
}

/** A task whose class throws a plain Error, not a task exception, when it rebuilds. */
export class BrokenRebuild implements Task {
  static readonly failure = new RangeError('rebuild broke');
  static getId(): string {
    return 'tasks.broken-rebuild';
  }
  static fromPayload(payload: TaskPayload): BrokenRebuild {
    throw BrokenRebuild.failure;
  }
  toPayload(): TaskPayload {
    return {};
  }
}

/** A task whose payload is a list, not a plain object. */
export class ListPayload implements Task {
  static getId(): string {
    return 'tasks.list-payload';
  }
  static fromPayload(payload: TaskPayload): ListPayload {
    return new ListPayload();
  }
  toPayload(): TaskPayload {
    return ['a'] as unknown as TaskPayload;
  }
}

/** A plain http Response for controllers and fake lifecycles. */
export class PlainResponse implements HttpResponse {
  private status = 200;
  private headers: Record<string, string> = {};
  private body = '';
  private errorMessage: string | null = null;
  setStatus(code: number): this {
    this.status = code;
    return this;
  }
  getStatus(): number {
    return this.status;
  }
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  getHeader(name: string): string | null {
    return this.headers[name.toLowerCase()] ?? null;
  }
  getHeaders(): Record<string, string> {
    return { ...this.headers };
  }
  setBody(body: string): this {
    this.body = body;
    return this;
  }
  setJson(data: unknown): this {
    this.body = JSON.stringify(data);
    this.headers['content-type'] = 'application/json';
    return this;
  }
  getJson(): unknown {
    return JSON.parse(this.body);
  }
  getBody(): string {
    return this.body;
  }
  setError(message: string, code: number = 400): this {
    this.errorMessage = message;
    return this.setStatus(code).setJson({ error: message });
  }
  getErrorMessage(): string | null {
    return this.errorMessage;
  }
  getResponse(): unknown {
    return { status: this.status, headers: { ...this.headers }, body: this.body };
  }
}

/**
 * An Express request as Medusa hands it to a route. As in Express, `path`
 * is a getter on the prototype, so a copy made with spread has no path.
 */
export class FakeRequest implements MedusaHttpRequest {
  method = 'GET';
  baseUrl = '';
  headers: MedusaHttpRequest['headers'] = {};
  query: MedusaHttpRequest['query'] = {};
  params: MedusaHttpRequest['params'] = {};
  body: unknown = undefined;
  rawBody?: unknown;
  scope: MedusaContainer = new FakeMedusaContainer();
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }
  get path(): string {
    return this.#path;
  }
}

export function fakeRequest(overrides: Partial<MedusaHttpRequest> = {}): FakeRequest {
  const { path = '/', ...rest } = overrides;
  return Object.assign(new FakeRequest(path), rest);
}

/** An Express response that records each call in order. */
export class FakeResponse implements MedusaHttpResponse {
  readonly calls: unknown[][] = [];
  status(code: number): this {
    this.calls.push(['status', code]);
    return this;
  }
  setHeader(name: string, value: string): this {
    this.calls.push(['setHeader', name, value]);
    return this;
  }
  send(body: string): this {
    this.calls.push(['send', body]);
    return this;
  }
}

/** Lets pending promise callbacks and timers of zero run. */
export async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** A promise with its resolve and reject exposed. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Answers what the promise rejected with, and fails when it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}
