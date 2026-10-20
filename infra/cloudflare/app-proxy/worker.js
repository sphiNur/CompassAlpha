/**
 * Stable HTTPS entry point for a server that only exposes HTTP.
 *
 * The deployment has a fixed IP but no owned domain. A workers.dev
 * hostname gives Telegram and browsers a stable HTTPS origin without
 * opening 443 on the origin or buying DNS. The Worker is intentionally
 * a transparent reverse proxy; authentication and tenant isolation
 * remain in the Compass API.
 */
export default {
  async fetch(request, env) {
    const origin = new URL(env.ORIGIN_URL);
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, origin);

    const headers = new Headers(request.headers);
    headers.set('x-forwarded-host', incoming.host);
    headers.set('x-forwarded-proto', 'https');
    // Avoid forwarding the Workers hostname as the origin Host header.
    headers.set('host', origin.host);

    const init = {
      method: request.method,
      headers,
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    const response = await fetch(target, init);
    const responseHeaders = new Headers(response.headers);

    // Nginx may answer /health with a trailing-slash redirect. Keep
    // every redirect on the public HTTPS hostname instead of leaking
    // the private HTTP origin to the browser.
    const location = responseHeaders.get('location');
    if (location) {
      try {
        const resolved = new URL(location, origin);
        if (resolved.host === origin.host) {
          resolved.protocol = 'https:';
          resolved.host = incoming.host;
          responseHeaders.set('location', resolved.toString());
        }
      } catch {
        // Leave an opaque Location header untouched.
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
