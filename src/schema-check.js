/**
 * Local guard for the two DSH registration traps:
 * - every object node must declare additionalProperties;
 * - type must be one string, never a union array.
 * The real registry validates again; this gives a useful error before install.
 */
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

export function validateSchemaNode(node, path = 'schema') {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${path} must be a schema object`);
  }
  if (Object.hasOwn(node, 'type')) {
    if (Array.isArray(node.type)) throw new Error(`${path}.type must be a single type string, not an array`);
    if (typeof node.type !== 'string' || !TYPES.has(node.type)) {
      throw new Error(`${path}.type is not a supported single type`);
    }
  }
  if (Object.hasOwn(node, 'oneOf')) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      throw new Error(`${path}.oneOf must contain at least two schemas`);
    }
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, key)) throw new Error(`${path}.${key} is not allowed beside oneOf`);
    }
    node.oneOf.forEach((child, index) => validateSchemaNode(child, `${path}.oneOf[${index}]`));
  }
  const looksObject = node.type === 'object' || Object.hasOwn(node, 'properties');
  if (looksObject) {
    if (typeof node.additionalProperties !== 'boolean') {
      throw new Error(`${path}.additionalProperties must be explicitly true or false`);
    }
    if (node.type !== 'object') throw new Error(`${path} declares properties but type is not object`);
  }
  if (Object.hasOwn(node, 'properties')) {
    if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      throw new Error(`${path}.properties must be an object`);
    }
    for (const [key, child] of Object.entries(node.properties)) {
      validateSchemaNode(child, `${path}.properties.${key}`);
    }
  }
  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
      throw new Error(`${path}.required must be an array of strings`);
    }
    for (const key of node.required) {
      if (!Object.hasOwn(node.properties ?? {}, key)) {
        throw new Error(`${path}.required names "${key}" which is not in properties`);
      }
    }
  }
  if (Object.hasOwn(node, 'items')) {
    if (node.type !== 'array') throw new Error(`${path}.items requires type array`);
    validateSchemaNode(node.items, `${path}.items`);
  }
  return true;
}

/** Validate the definition fields that reach the model, plus its output schema. */
export function assertToolSchema(definition) {
  if (typeof definition?.name !== 'string' || definition.name.length === 0) {
    throw new Error('tool definition needs a non-empty name');
  }
  if (typeof definition.description !== 'string' || definition.description.length === 0) {
    throw new Error(`tool "${definition.name}" needs a description`);
  }
  validateSchemaNode(definition.parameters, `${definition.name}.parameters`);
  if (definition.parameters?.type !== 'object') {
    throw new Error(`tool "${definition.name}" parameters must be an object`);
  }
  if (definition.output === undefined || typeof definition.output.render !== 'function') {
    throw new Error(`tool "${definition.name}" needs output.render`);
  }
  validateSchemaNode(definition.output.schema, `${definition.name}.output`);
  return true;
}
