// src/extension/registry.js
// AWARE extension registry — holds the registered extensions and delivers
// events to them.
//
// The registry is deliberately dumb: it validates, it stores, it delivers. It
// contains no policy about what an extension is allowed to DO, and no
// knowledge of where extensions come from commercially.
//
// DELIVERY ISOLATION
// ------------------
// An extension that throws must not take down the caller. A broken
// extension is the extension's problem, not the engine's. Every call is
// therefore wrapped, and a failure is recorded and reported rather than
// propagated.
//
// But a failure is never SILENT: an extension that throws on every event
// looks exactly like an extension that is not registered, which is the
// failure mode this registry exists to prevent.

'use strict';

const {
  AWARE_EXTENSION_CONTRACT_VERSION,
  KNOWN_METHODS,
  validateExtension,
} = require('./contract');

class ExtensionRegistry {
  constructor() {
    /** @type {Array<{name: string, extension: object, failures: number}>} */
    this._extensions = [];
    /** @type {Array<{extension: string, method: string, error: string}>} */
    this._failures = [];
  }

  /**
   * Register an extension.
   *
   * @param {object} extension  must satisfy the contract
   * @param {string} [name]     display name; defaults to extension.name
   * @returns {{ok: boolean, name: string|null, problems: string[]}}
   */
  register(extension, name) {
    const { valid, problems } = validateExtension(extension);
    if (!valid) {
      return { ok: false, name: null, problems };
    }

    const resolvedName = name || extension.name || `extension-${this._extensions.length + 1}`;
    this._extensions.push({ name: resolvedName, extension, failures: 0 });
    return { ok: true, name: resolvedName, problems: [] };
  }

  /**
   * Remove an extension by name.
   *
   * @returns {boolean} true if one was removed
   */
  unregister(name) {
    const before = this._extensions.length;
    this._extensions = this._extensions.filter((e) => e.name !== name);
    return this._extensions.length !== before;
  }

  /** @returns {string[]} the names of the registered extensions */
  names() {
    return this._extensions.map((e) => e.name);
  }

  /** @returns {number} how many extensions are registered */
  get size() {
    return this._extensions.length;
  }

  /**
   * Deliver an event to every registered extension that implements the method.
   *
   * Failures are recorded, not thrown.
   *
   * @param {string} method  one of KNOWN_METHODS
   * @param {...any} args    the arguments to pass
   * @returns {Promise<{delivered: number, failed: number}>}
   */
  async dispatch(method, ...args) {
    if (!KNOWN_METHODS.includes(method)) {
      throw new Error(
        `unknown extension method "${method}"; known methods are ${KNOWN_METHODS.join(', ')}`
      );
    }

    let delivered = 0;
    let failed = 0;

    for (const entry of this._extensions) {
      const fn = entry.extension[method];
      if (typeof fn !== 'function') {
        // Optional methods are allowed to be absent. Nothing to do.
        continue;
      }
      try {
        await fn.call(entry.extension, ...args);
        delivered += 1;
      } catch (err) {
        failed += 1;
        entry.failures += 1;
        this._failures.push({
          extension: entry.name,
          method,
          error: err && err.message ? err.message : String(err),
        });
        // Deliberately not rethrown. A broken extension must not break the
        // engine. But it is recorded, and getFailures() exposes it.
      }
    }

    return { delivered, failed };
  }

  /**
   * The failures recorded so far.
   *
   * Exposed so an operator can see that an extension is misbehaving rather
   * than wondering why it receives nothing.
   *
   * @returns {Array<{extension: string, method: string, error: string}>}
   */
  getFailures() {
    return this._failures.slice();
  }

  /**
   * Per-extension failure counts.
   *
   * @returns {Array<{name: string, failures: number}>}
   */
  getFailureCounts() {
    return this._extensions.map((e) => ({ name: e.name, failures: e.failures }));
  }

  /** Clear the recorded failures. */
  clearFailures() {
    this._failures = [];
  }

  /** The contract version this registry implements. */
  get contractVersion() {
    return AWARE_EXTENSION_CONTRACT_VERSION;
  }
}

module.exports = { ExtensionRegistry };
