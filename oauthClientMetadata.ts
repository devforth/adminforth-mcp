import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { logger } from 'adminforth';
import { OAuthError } from './oauthError.js';
import type { McpOAuthClient } from './types.js';

const MAX_DOCUMENT_BYTES = 5 * 1024;
const FETCH_TIMEOUT_MS = 5000;
// client_name is shown on the consent page and stored as the connection name.
const MAX_CLIENT_NAME_LENGTH = 100;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const specialPurposeAddresses = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([network, prefix]) => specialPurposeAddresses.addSubnet(network as string, prefix as number, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
].forEach(([network, prefix]) => specialPurposeAddresses.addSubnet(network as string, prefix as number, 'ipv6'));

/** BlockList matches IPv4-mapped IPv6 addresses (::ffff:10.0.0.5) against the IPv4 ranges by itself. */
export function isSpecialPurposeAddress(address: string, family: number): boolean {
  return specialPurposeAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * client_id is an attacker-chosen URL, so the fetch refuses hosts resolving to private, loopback and other
 * special-purpose addresses. Checking in the socket lookup, not before the request, closes DNS rebinding.
 */
const lookupPublicAddress: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    const specialAddress = addresses.find(({ address, family }) => isSpecialPurposeAddress(address, family));
    if (specialAddress) {
      callback(new Error(`${hostname} resolves to special-purpose address ${specialAddress.address}`), []);
      return;
    }
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  });
};

function isClientIdUrl(clientId: string): boolean {
  const url = URL.parse(clientId);
  return url?.protocol === 'https:'
    && url.href === clientId
    && !url.username
    && !url.password
    && url.pathname !== '/'
    && !url.hash
    && !net.isIP(url.hostname)
    && !url.hostname.startsWith('[');
}

function isLoopbackUrl(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** Native clients listen on a random loopback port, so RFC 8252 lets the port differ from the registered one. */
export function redirectUriMatches(requested: string, registered: string): boolean {
  const requestedUrl = new URL(requested);
  const registeredUrl = new URL(registered);
  if (!isLoopbackUrl(registeredUrl)) return requested === registered;
  requestedUrl.port = '';
  registeredUrl.port = '';
  return requestedUrl.href === registeredUrl.href;
}

export function isAllowedRedirectUri(redirectUri: string): boolean {
  const url = new URL(redirectUri);
  return url.protocol === 'https:' || isLoopbackUrl(url);
}

export function isLoopbackRedirectUri(redirectUri: string): boolean {
  return isLoopbackUrl(new URL(redirectUri));
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      lookup: lookupPublicAddress,
      headers: { Accept: 'application/json' },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`responded with HTTP ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_DOCUMENT_BYTES) {
          request.destroy(new Error(`document is larger than ${MAX_DOCUMENT_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    // The `timeout` option of https.get fires only after a silent period, so a server sending a byte every few
    // seconds would hold the request for hours. The deadline caps the whole request instead.
    const deadline = setTimeout(
      () => request.destroy(new Error(`timed out after ${FETCH_TIMEOUT_MS} ms`)),
      FETCH_TIMEOUT_MS,
    );
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
  });
}

/** Resolves an MCP client by its Client ID Metadata Document, the client_id being the document URL. */
export async function fetchClientMetadata(clientId: string): Promise<McpOAuthClient> {
  if (!isClientIdUrl(clientId)) {
    throw new OAuthError('invalid_client', 'client_id must be the https URL of a client metadata document');
  }

  let document: any;
  try {
    document = await fetchJson(clientId);
  } catch (error) {
    // The reason stays in the log: resolved addresses, HTTP statuses and parse errors quoting the response
    // would tell whoever chose the client_id what this server can reach.
    logger.warn(`AdminForthMcpPlugin: failed to fetch client metadata document ${clientId}: ${(error as Error).message}`);
    throw new OAuthError('invalid_client', 'Could not fetch the client metadata document');
  }

  if (
    typeof document?.client_name !== 'string'
    || !Array.isArray(document.redirect_uris)
    || !document.redirect_uris.length
    || !document.redirect_uris.every((uri: unknown) => typeof uri === 'string' && URL.canParse(uri))
    || document.token_endpoint_auth_method !== 'none'
  ) {
    throw new OAuthError(
      'invalid_client',
      'Client metadata document must have client_name, redirect_uris and token_endpoint_auth_method "none"',
    );
  }
  if (document.client_id !== clientId) {
    throw new OAuthError('invalid_client', 'client_id in the client metadata document does not match its URL');
  }

  return { clientId, clientName: document.client_name.slice(0, MAX_CLIENT_NAME_LENGTH), redirectUris: document.redirect_uris };
}
