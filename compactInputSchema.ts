// Endpoint request schemas are written for OpenAPI docs. MCP clients keep tool schemas in the model context,
// so annotations that do not help to build a call and definitions the tool never references are dropped.
const DOCUMENTATION_ONLY_KEYWORDS = new Set(['title', 'examples']);
// Keywords whose value maps names to subschemas: their keys are names, not keywords.
const SUBSCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs']);
// Keywords whose value is data, not a schema.
const DATA_KEYWORDS = new Set(['enum', 'const', 'default']);
const DEFS_REF_PREFIX = '#/$defs/';

type JsonSchema = Record<string, unknown>;

function isObject(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripDocumentationKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripDocumentationKeywords);
  if (!isObject(node)) return node;

  return Object.fromEntries(
    Object.entries(node)
      .filter(([keyword]) => !DOCUMENTATION_ONLY_KEYWORDS.has(keyword))
      .map(([keyword, value]) => {
        if (DATA_KEYWORDS.has(keyword)) return [keyword, value];
        if (SUBSCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
          return [keyword, Object.fromEntries(
            Object.entries(value).map(([name, subschema]) => [name, stripDocumentationKeywords(subschema)]),
          )];
        }
        return [keyword, stripDocumentationKeywords(value)];
      }),
  );
}

function collectDefRefs(node: unknown, refs: Set<string>): void {
  if (Array.isArray(node)) {
    node.forEach((item) => collectDefRefs(item, refs));
    return;
  }
  if (!isObject(node)) return;

  for (const [keyword, value] of Object.entries(node)) {
    if (keyword === '$ref' && typeof value === 'string' && value.startsWith(DEFS_REF_PREFIX)) {
      refs.add(value.slice(DEFS_REF_PREFIX.length));
    } else if (!DATA_KEYWORDS.has(keyword)) {
      collectDefRefs(value, refs);
    }
  }
}

// Shared $defs are attached to every endpoint schema, even to endpoints that use only some of them.
function pruneUnusedDefs(schema: JsonSchema): JsonSchema {
  const { $defs, ...rest } = schema;
  if (!isObject($defs)) return schema;

  const used = new Set<string>();
  const pending = new Set<string>();
  collectDefRefs(rest, pending);
  for (const name of pending) {
    if (used.has(name)) continue;
    used.add(name);
    collectDefRefs($defs[name], pending);
  }

  const usedDefs = Object.fromEntries(Object.entries($defs).filter(([name]) => used.has(name)));
  return Object.keys(usedDefs).length > 0 ? { ...rest, $defs: usedDefs } : rest;
}

export function compactInputSchema(schema: JsonSchema): JsonSchema {
  return pruneUnusedDefs(stripDocumentationKeywords(schema) as JsonSchema);
}
