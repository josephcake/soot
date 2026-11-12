/*
 * Test guard preloaded with `node --import` (tests/dashboard.test.ts). It makes the optional
 * dashboard package unloadable, as if it were not installed, and records every attempt to load
 * it and every server `listen` call to $SOOT_TEST_GUARD_LOG. Headless commands must run
 * unchanged under it and leave no `listen` entry.
 */
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import net from 'node:net';

const log = process.env.SOOT_TEST_GUARD_LOG;
const note = (line) => {
  if (log) appendFileSync(log, `${line}\n`);
};
const blocked = (s) =>
  s === '@soot/dashboard' || s.startsWith('@soot/dashboard/') || s.includes('/apps/dashboard/');
const refuse = (what) => {
  note(`blocked-import ${what}`);
  const error = new Error(`Cannot find package '${what}' (blocked by the no-dashboard test guard)`);
  error.code = 'ERR_MODULE_NOT_FOUND';
  throw error;
};

registerHooks({
  resolve(specifier, context, next) {
    if (blocked(specifier)) refuse(specifier);
    const result = next(specifier, context);
    if (blocked(result.url)) refuse(result.url);
    return result;
  },
});

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  note(`listen ${JSON.stringify(args[0] ?? null)}`);
  return listen.apply(this, args);
};
