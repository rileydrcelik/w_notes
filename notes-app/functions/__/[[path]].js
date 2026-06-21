// Cloudflare Pages Function: proxies Firebase Auth's reserved `/__/*` endpoints
// (the auth handler + helper iframe, init.json, etc.) to the project's
// firebaseapp.com origin, so the auth helper runs SAME-ORIGIN with the app.
//
// Why: the app page is cross-origin isolated (COOP `same-origin` + COEP, required
// for wa-sqlite's SharedArrayBuffer). Firebase's redirect flow loads a helper
// iframe from `authDomain`; a cross-origin (…firebaseapp.com) iframe is
// credentialless + storage-partitioned on an isolated page and never returns the
// result, hanging sign-in. `firebase.web.ts` sets `authDomain` to the app host so
// the SDK requests these `/__/auth/*` paths here, and we forward them to Firebase.
//
// Routing: file lives at functions/__/[[path]].js → matches `/__/*`. Wrangler
// compiles ./functions (relative to the deploy cwd) into the Pages deployment.
// Pages Functions take precedence over the static SPA fallback for these paths.

const FIREBASE_HOST = 'w-notes-7b47c.firebaseapp.com';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = `https://${FIREBASE_HOST}${url.pathname}${url.search}`;

  // Forward the request, but DON'T auto-follow redirects: the auth handler 302s
  // out to Google, and that navigation must reach the browser, not be chased here.
  const headers = new Headers(request.headers);
  headers.delete('host');
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  });

  // Strip cross-origin isolation from the proxied responses — the handler/iframe
  // don't need SAB, and COOP `same-origin` would sever the redirect handshake.
  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete('Cross-Origin-Opener-Policy');
  outHeaders.delete('Cross-Origin-Embedder-Policy');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}
