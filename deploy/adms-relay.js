// Cloudflare Worker that lets attendance devices reach the API on Vercel.
//
// The devices speak ADMS over plain HTTP only, and Vercel answers plain HTTP with a redirect to HTTPS that the devices
// do not follow. This Worker takes their HTTP requests on a subdomain (e.g. att.example.com) and passes them to
// Vercel over HTTPS, unchanged.
//
// Setup: add the subdomain to Cloudflare (proxied), turn OFF "Always Use HTTPS" for it, deploy this Worker on the route
// att.example.com/iclock/*, and set the variables:
//   ORIGIN       https://your-app.vercel.app
//   ALLOWED_IPS  (optional) the office's public IP addresses, comma separated. The device is known only by its serial
//                number, sent in the clear, so this keeps anyone else from posting punches.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/iclock/')) return new Response('Not found', { status: 404 });
    const allowed = (env.ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(request.headers.get('cf-connecting-ip') ?? '')) return new Response('Forbidden', { status: 403 });
    const origin = new URL(env.ORIGIN);
    url.protocol = origin.protocol;
    url.host = origin.host;
    return fetch(new Request(url, request), { redirect: 'manual' });
  },
};
