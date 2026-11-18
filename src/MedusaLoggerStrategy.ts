/**
 * MedusaLoggerStrategy
 *
 * The `LoggerStrategy` for Medusa. It writes through the logger Medusa
 * registers as `logger`, so TS Nomad's lines land wherever the
 * application sends Medusa's own. It extends `BaseLoggerStrategy` for
 * `logException`.
 *
 * Each call writes exactly one line, through one Medusa method:
 *
 * | Levels | Medusa method |
 * |---|---|
 * | emergency, alert, critical, error | `error` |
 * | warning | `warn` |
 * | notice, info | `info` |
 * | debug | `debug` |
 *
 * Medusa's logger has fewer levels and takes no context, so:
 *
 * - The text is `[<level>] <message>`, keeping the TS Nomad level.
 * - When the context has any key, the text continues with one space and
 *   the context as JSON. An Error anywhere in the context is written as
 *   `{ "name": ..., "message": ... }`, plus `"cause"` when it has one and
 *   `"errors"` for an AggregateError, each encoded the same way, so a
 *   wrapped failure keeps its reason. The stack is left out, since error
 *   levels pass the exception to Medusa, which prints it. A BigInt is
 *   written as its decimal string, an
 *   object met again inside itself as `"[Circular]"`, and values JSON
 *   drops, such as functions and undefined, are left out. When the
 *   context still cannot be encoded, such as a getter that throws, the
 *   text continues with `[context could not be encoded: <message>]`
 *   instead, where `<message>` is the encoding error's message. A context
 *   never makes the strategy throw.
 * - For the four levels that write through `error`, when the context's
 *   `exception` key holds an Error, it is passed as Medusa's second
 *   argument, `error(text, exception)`, so Medusa prints its stack.
 *   Otherwise `error(text)` gets one argument.
 *
 * It never calls Medusa's `panic`, which ends the process. When Medusa's
 * logger throws, the error passes through to the caller.
 */

import { BaseLoggerStrategy } from '@tsnomad/logger';
import type { LogContext, LoggerLevel } from '@tsnomad/logger';
import { MedusaLogger } from './medusa.js';

/** The Medusa logger method a level writes through. */
type MedusaMethod = 'error' | 'warn' | 'info' | 'debug';

export class MedusaLoggerStrategy extends BaseLoggerStrategy {
  static readonly inject = [MedusaLogger] as const;

  constructor(private readonly logger: MedusaLogger) {
    super();
  }

  emergency(message: string, context?: LogContext): void {
    this.write('emergency', 'error', message, context);
  }

  alert(message: string, context?: LogContext): void {
    this.write('alert', 'error', message, context);
  }

  critical(message: string, context?: LogContext): void {
    this.write('critical', 'error', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write('error', 'error', message, context);
  }

  warning(message: string, context?: LogContext): void {
    this.write('warning', 'warn', message, context);
  }

  notice(message: string, context?: LogContext): void {
    this.write('notice', 'info', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write('info', 'info', message, context);
  }

  debug(message: string, context?: LogContext): void {
    this.write('debug', 'debug', message, context);
  }

  /** Writes one line through `method`, passing an Error under `exception` on for the error method. */
  private write(level: LoggerLevel, method: MedusaMethod, message: string, context?: LogContext): void {
    let text = `[${level}] ${message}`;
    if (context && Object.keys(context).length > 0) text += ` ${encodeContext(context)}`;
    if (method === 'error') {
      const exception = context?.exception;
      if (exception instanceof Error) this.logger.error(text, exception);
      else this.logger.error(text);
    } else {
      this.logger[method](text);
    }
  }
}

/**
 * Encodes a context as JSON. An Error becomes its name and message, plus
 * its cause and an AggregateError's errors, a BigInt its decimal string,
 * and an object met again inside itself "[Circular]". Each Error maps to
 * one plain object per call, so an Error that is its own cause is a cycle
 * too. Anything that still cannot be encoded answers a marker naming the
 * reason, so encoding never throws.
 */
function encodeContext(context: LogContext): string {
  const ancestors: object[] = [];
  const plains = new Map<Error, Record<string, unknown>>();
  try {
    return JSON.stringify(context, function (this: unknown, key: string, raw: unknown): unknown {
      let value = raw;
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) {
        const plain: Record<string, unknown> = plains.get(value) ?? { name: value.name, message: value.message };
        if (value.cause !== undefined) plain.cause = value.cause;
        if (value instanceof AggregateError) plain.errors = value.errors;
        plains.set(value, plain);
        value = plain;
      }
      if (value === null || typeof value !== 'object') return value;
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(value as object)) return '[Circular]';
      ancestors.push(value as object);
      return value;
    });
  } catch (error) {
    return `[context could not be encoded: ${error instanceof Error ? error.message : String(error)}]`;
  }
}
