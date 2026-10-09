import test from 'node:test';
import assert from 'node:assert/strict';
import { compactInputSchema } from '../dist/compactInputSchema.js';

test('drops title and examples at any depth and keeps description', () => {
  assert.deepEqual(compactInputSchema({
    type: 'object',
    title: 'Request',
    properties: {
      limit: { type: 'number', title: 'Limit', examples: [10], description: 'Rows per page.' },
      filters: { type: 'array', items: { anyOf: [{ type: 'string', title: 'Raw' }] } },
    },
  }), {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Rows per page.' },
      filters: { type: 'array', items: { anyOf: [{ type: 'string' }] } },
    },
  });
});

test('keeps fields named title or examples', () => {
  assert.deepEqual(compactInputSchema({
    type: 'object',
    properties: {
      title: { type: 'string', title: 'Title' },
      examples: { type: 'array', items: { type: 'string', title: 'Example' } },
      nested: { type: 'object', properties: { title: { type: 'string', title: 'Nested title' } } },
    },
    patternProperties: { '^title$': { type: 'string', title: 'Pattern' } },
  }), {
    type: 'object',
    properties: {
      title: { type: 'string' },
      examples: { type: 'array', items: { type: 'string' } },
      nested: { type: 'object', properties: { title: { type: 'string' } } },
    },
    patternProperties: { '^title$': { type: 'string' } },
  });
});

test('keeps enum, const and default values untouched', () => {
  const schema = {
    type: 'object',
    properties: {
      kind: { enum: ['title', 'examples'] },
      marker: { const: { title: 'a' } },
      settings: { type: 'object', default: { title: 'Untitled', examples: [] } },
    },
  };

  assert.deepEqual(compactInputSchema(schema), schema);
});

test('keeps $defs referenced directly, transitively and recursively', () => {
  assert.deepEqual(compactInputSchema({
    type: 'object',
    properties: {
      filters: { type: 'array', items: { $ref: '#/$defs/Filter' } },
      value: { $ref: '#/$defs/A' },
    },
    $defs: {
      Filter: { type: 'object', properties: { or: { type: 'array', items: { $ref: '#/$defs/Filter' } } } },
      A: { $ref: '#/$defs/B' },
      B: { $ref: '#/$defs/C' },
      C: { type: 'string' },
      UsesC: { $ref: '#/$defs/C' },
      Unused: { type: 'number' },
    },
  }), {
    type: 'object',
    properties: {
      filters: { type: 'array', items: { $ref: '#/$defs/Filter' } },
      value: { $ref: '#/$defs/A' },
    },
    $defs: {
      Filter: { type: 'object', properties: { or: { type: 'array', items: { $ref: '#/$defs/Filter' } } } },
      A: { $ref: '#/$defs/B' },
      B: { $ref: '#/$defs/C' },
      C: { type: 'string' },
    },
  });
});

test('drops $defs when nothing references them', () => {
  assert.deepEqual(compactInputSchema({
    type: 'object',
    properties: {
      external: { $ref: 'https://example.com/schema.json' },
      // a $ref inside enum is a value, not a reference
      kind: { enum: [{ $ref: '#/$defs/Kind' }] },
    },
    $defs: { Kind: { type: 'string' } },
  }), {
    type: 'object',
    properties: {
      external: { $ref: 'https://example.com/schema.json' },
      kind: { enum: [{ $ref: '#/$defs/Kind' }] },
    },
  });
});

test('does not mutate the endpoint schema', () => {
  const schema = {
    type: 'object',
    title: 'Request',
    properties: { id: { type: 'string', title: 'ID' } },
    $defs: { Unused: { type: 'string' } },
  };
  const original = structuredClone(schema);

  compactInputSchema(schema);

  assert.deepEqual(schema, original);
});
