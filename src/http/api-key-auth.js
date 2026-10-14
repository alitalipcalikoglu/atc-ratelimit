import { ApiKeyAuth as CoreApiKeyAuth } from '@atc-web/atc-service-core/auth';
import { RateLimitError } from '../domain/errors.js';

/** @typedef {import('../types.js').ApiKey} ApiKey */

/**
 * Bearer API-key authentication with check/read/write roles and optional policy scoping. Thin
 * wrapper over service-core's `ApiKeyAuth`: this service's decoration shape (`request.apiKey` as
 * the whole object), role names (including the `check` role unique to this service) and its
 * `RateLimitError` on a mismatch are unchanged from before the extraction.
 */
export class ApiKeyAuth {
  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.core = new CoreApiKeyAuth(apiKeys);
  }

  /** Fastify `onRequest` hook. */
  get hook() {
    return this.core.hook;
  }

  /**
   * Route-level guard on role.
   * @param {'check'|'read'|'write'} need
   */
  static require(need) {
    return CoreApiKeyAuth.require(need, {
      roleOf: (request) => /** @type {any} */ (request).apiKey?.role,
      makeError: (n) => new RateLimitError('FORBIDDEN', `this API key has no ${n} access`),
    });
  }

  /**
   * Policy guard: a key scoped to some policies may not touch others.
   * @param {ApiKey} key
   * @param {string} policy
   */
  static assertPolicy(key, policy) {
    CoreApiKeyAuth.assertScope(/** @type {any} */ ({ scopes: key.policies }), policy, (name) => new RateLimitError('FORBIDDEN', `this API key has no access to policy "${name}"`));
  }

  /**
   * @param {string} secret Presented secret.
   * @returns {ApiKey|undefined} Matching key.
   */
  identify(secret) {
    return /** @type {ApiKey|undefined} */ (/** @type {any} */ (this.core.identify(secret)));
  }
}
