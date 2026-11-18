/**
 * Acceptance tests for MedusaLoggerStrategy.
 *
 * They run against a fake Medusa logger that records each call.
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { MedusaLogger, MedusaLoggerStrategy } from '@tsnomad/medusa-integration';
import { FakeMedusaLogger } from './fakes.js';

let medusa: FakeMedusaLogger;
let logger: MedusaLoggerStrategy;

beforeEach(() => {
  medusa = new FakeMedusaLogger();
  logger = new MedusaLoggerStrategy(medusa);
});

const levels = [
  ['emergency', 'error'],
  ['alert', 'error'],
  ['critical', 'error'],
  ['error', 'error'],
  ['warning', 'warn'],
  ['notice', 'info'],
  ['info', 'info'],
  ['debug', 'debug'],
] as const;

describe('MedusaLoggerStrategy levels', () => {
  test.each(levels)('%s writes one line through Medusa\'s %s, prefixed with the level', (level, method) => {
    logger[level]('Order synced');

    expect(medusa.calls).toEqual([[method, `[${level}] Order synced`]]);
  });

  test.each(levels)('%s with an empty context writes no context', (level, method) => {
    logger[level]('Order synced', {});

    expect(medusa.calls).toEqual([[method, `[${level}] Order synced`]]);
  });

  test.each(levels)('%s appends the context as JSON after one space', (level, method) => {
    logger[level]('Order synced', { order: 'order_1', attempt: 2, nested: { ok: true } });

    expect(medusa.calls).toEqual([[method, `[${level}] Order synced {"order":"order_1","attempt":2,"nested":{"ok":true}}`]]);
  });
});

describe('MedusaLoggerStrategy context encoding', () => {
  test('writes an Error as its name and message, a BigInt as a string, and drops functions and undefined', () => {
    const failure = new RangeError('too far');
    logger.info('Encoded', { failure, big: 12345678901234567890n, fn: () => 1, missing: undefined, kept: null });

    expect(medusa.calls).toEqual([
      ['info', '[info] Encoded {"failure":{"name":"RangeError","message":"too far"},"big":"12345678901234567890","kept":null}'],
    ]);
  });

  test("writes an Error's cause and an AggregateError's errors the same way, so a wrapped failure keeps its reason", () => {
    const root = new TypeError('cursor missing');
    const wrapped = new Error('dispatch failed', { cause: root });
    const many = new AggregateError([new Error('first'), wrapped], 'two failed');
    logger.warning('Wrapped', { wrapped, many });

    expect(medusa.calls).toEqual([
      [
        'warn',
        '[warning] Wrapped {"wrapped":{"name":"Error","message":"dispatch failed","cause":{"name":"TypeError","message":"cursor missing"}},' +
          '"many":{"name":"AggregateError","message":"two failed","errors":[{"name":"Error","message":"first"},' +
          '{"name":"Error","message":"dispatch failed","cause":{"name":"TypeError","message":"cursor missing"}}]}}',
      ],
    ]);
  });

  test('writes an object met again inside itself as "[Circular]"', () => {
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.self = loop;
    logger.warning('Looped', { loop });

    expect(medusa.calls).toEqual([['warn', '[warning] Looped {"loop":{"name":"loop","self":"[Circular]"}}']]);
  });

  test('writes an Error that is its own cause as "[Circular]" at the cause', () => {
    const loop = new Error('loops');
    loop.cause = loop;
    logger.warning('Self caused', { loop });

    expect(medusa.calls).toEqual([['warn', '[warning] Self caused {"loop":{"name":"Error","message":"loops","cause":"[Circular]"}}']]);
  });

  test('writes an object shared by two keys in full both times, since it is not inside itself', () => {
    const shared = { id: 'shared' };
    logger.info('Shared', { first: shared, second: shared });

    expect(medusa.calls).toEqual([['info', '[info] Shared {"first":{"id":"shared"},"second":{"id":"shared"}}']]);
  });

  test('writes a marker with the reason instead of a context it cannot encode, and does not throw', () => {
    const hostile = {
      get boom(): string {
        throw new Error('getter broke');
      },
    };

    expect(() => logger.notice('Hostile', { hostile })).not.toThrow();
    expect(medusa.calls).toEqual([['info', '[notice] Hostile [context could not be encoded: getter broke]']]);
  });
});

describe('MedusaLoggerStrategy exceptions', () => {
  test.each(['emergency', 'alert', 'critical', 'error'] as const)(
    '%s passes an Error under the exception key as Medusa\'s second argument',
    (level) => {
      const exception = new Error('stack me');
      logger[level]('Failed', { exception });

      expect(medusa.calls).toHaveLength(1);
      const [method, text, second] = medusa.calls[0];
      expect(method).toBe('error');
      expect(text).toBe(`[${level}] Failed {"exception":{"name":"Error","message":"stack me"}}`);
      expect(second).toBe(exception);
    },
  );

  test('passes no second argument when the exception key holds something other than an Error', () => {
    logger.error('Failed', { exception: 'just text' });

    expect(medusa.calls).toEqual([['error', '[error] Failed {"exception":"just text"}']]);
  });

  test('passes no second argument to warn, info or debug, even with an Error under the exception key', () => {
    const exception = new Error('quiet');
    logger.warning('W', { exception });
    logger.info('I', { exception });
    logger.debug('D', { exception });

    expect(medusa.calls.map((call) => call.length)).toEqual([2, 2, 2]);
    expect(medusa.calls.map((call) => call[0])).toEqual(['warn', 'info', 'debug']);
  });

  test("lets an error from Medusa's logger reach the caller", () => {
    const broken = new Error('transport down');
    const failing = new MedusaLoggerStrategy({
      error() {
        throw broken;
      },
      warn() {},
      info() {},
      debug() {},
    });

    expect(() => failing.critical('Down')).toThrow(broken);
  });
});

test('declares the Medusa logger for autowiring', () => {
  expect(MedusaLoggerStrategy.inject).toEqual([MedusaLogger]);
});
