/** JSON Schemas for the HTTP surface. Limit lists are validated further in the domain layer. */
export class Schemas {
  static name = { type: 'string', pattern: '^[a-z0-9]+([.\\-_][a-z0-9]+)*$', maxLength: 80 };
  static subject = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$' };
  static description = { type: 'string', maxLength: 500 };
  static limits = { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['window', 'limit'], properties: { window: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 0 } } } };
  static cost = { type: 'integer', minimum: 0 };
  static limit = { type: 'string', pattern: '^([1-9]|[1-9][0-9]|[1-9][0-9][0-9]|1000)$' };

  /**
   * @param {string[]} required
   * @param {Record<string, object>} properties
   */
  static body(required, properties) {
    return { type: 'object', additionalProperties: false, required, properties };
  }

  static check = Schemas.body(['policy', 'subject'], { policy: Schemas.name, subject: Schemas.subject, cost: Schemas.cost, peek: { type: 'boolean' } });
  static checkBatch = Schemas.body(['checks'], { checks: { type: 'array', minItems: 1, maxItems: 100, items: Schemas.body(['policy', 'subject'], { policy: Schemas.name, subject: Schemas.subject, cost: Schemas.cost }) }, peek: { type: 'boolean' } });
  static release = Schemas.body(['policy', 'subject'], { policy: Schemas.name, subject: Schemas.subject, cost: { type: 'integer', minimum: 1 }, consumedAt: { type: 'string', maxLength: 40 } });
  static createPolicy = Schemas.body(['name', 'limits'], { name: Schemas.name, description: Schemas.description, limits: Schemas.limits });
  static patchPolicy = { type: 'object', additionalProperties: false, minProperties: 1, properties: { description: Schemas.description, limits: Schemas.limits } };
  static override = Schemas.body(['limits'], { limits: Schemas.limits, note: Schemas.description, expiresAt: { type: ['string', 'null'], maxLength: 40 } });

  static nameParams = { type: 'object', properties: { name: Schemas.name }, required: ['name'] };
  static subjectParams = { type: 'object', properties: { name: Schemas.name, subject: Schemas.subject }, required: ['name', 'subject'] };
  static listQuery = { type: 'object', additionalProperties: false, properties: { limit: Schemas.limit, cursor: Schemas.subject } };
  static topQuery = { type: 'object', additionalProperties: false, properties: { window: { type: 'string', pattern: '^[1-9][0-9]{0,7}$' }, limit: Schemas.limit } };
  static statsQuery = { type: 'object', additionalProperties: false, properties: { hours: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|[1-6][0-9][0-9]|7[0-1][0-9]|720)$' } } };
}
