import test from 'node:test';
import assert from 'node:assert/strict';
import { clientMetadataDocumentSchema } from '../dist/schemas/oAuth.js';

const DOCUMENT = {
  client_id: 'https://client.example/metadata.json',
  client_name: 'Claude Code',
  redirect_uris: ['http://127.0.0.1/callback'],
  token_endpoint_auth_method: 'none',
  logo_uri: 'https://client.example/logo.png',
};

test('accepts the client metadata document of a public client', () => {
  assert.equal(clientMetadataDocumentSchema.safeParse(DOCUMENT).success, true);
});

test('rejects client metadata documents a public MCP client cannot have', () => {
  const invalid = {
    'without client_id': { ...DOCUMENT, client_id: undefined },
    'without client_name': { ...DOCUMENT, client_name: undefined },
    'without redirect URIs': { ...DOCUMENT, redirect_uris: [] },
    'with a redirect URI that is not a URL': { ...DOCUMENT, redirect_uris: ['not a url'] },
    'with a redirect URI that is not a string': { ...DOCUMENT, redirect_uris: [42] },
    'of a confidential client': { ...DOCUMENT, token_endpoint_auth_method: 'client_secret_basic' },
    'that is not an object': null,
  };
  for (const [name, document] of Object.entries(invalid)) {
    assert.equal(clientMetadataDocumentSchema.safeParse(document).success, false, name);
  }
});
