const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackUrl(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** Native clients listen on a random loopback port, so RFC 8252 lets the port differ from the registered one. */
export function redirectUriMatches(requested: URL, registered: string): boolean {
  const registeredUrl = new URL(registered);
  if (!isLoopbackUrl(registeredUrl)) return requested.href === registeredUrl.href;
  return requested.protocol === registeredUrl.protocol
    && requested.hostname === registeredUrl.hostname
    && requested.pathname === registeredUrl.pathname
    && requested.search === registeredUrl.search
    && requested.hash === registeredUrl.hash;
}

export function isAllowedRedirectUri(redirectUri: URL): boolean {
  return redirectUri.protocol === 'https:' || isLoopbackUrl(redirectUri);
}
