// Type-only augmentation for the request decorators set in api-key-auth.js. No runtime code.
import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: import('./types.js').ApiKey;
  }
  interface FastifyContextConfig {
    /** Opt in to Idempotency-Key replay (core Idempotency); never on routes answering with secrets. */
    idempotent?: boolean;
    audit?: import('@atc-web/atc-service-core/audit').AuditRouteConfig;
  }
}
