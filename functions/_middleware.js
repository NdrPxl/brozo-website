// Host routing for the Thane domains (owner, 2026-11-25). brozo.co and everything else pass straight through.
//   thanetcg.com            -> the game in /thane/ served at the root (thanetcg.com/ = /thane/, /layers/... = /thane/layers/...)
//   www.thanetcg.com        -> 301 to thanetcg.com
//   playthane.com (+ www)   -> 301 to thanetcg.com, same path
// /api/* stays shared, so the AI opponent (functions/api/thane-ai.js) works on every domain.
const MAIN = 'thanetcg.com';

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  const host = url.hostname.toLowerCase();
  const to = (path) => Response.redirect(`https://${MAIN}${path}${url.search}`, 301);
  if (host === 'playthane.com' || host === 'www.playthane.com') return to(url.pathname);
  if (host === `www.${MAIN}`) return to(url.pathname);
  if (host !== MAIN || url.pathname.startsWith('/api/')) return ctx.next();
  // the old brozo.co address of the game inside this domain, e.g. thanetcg.com/thane/ -> thanetcg.com/
  if (url.pathname === '/thane' || url.pathname.startsWith('/thane/')) return to(url.pathname.slice(6) || '/');
  url.pathname = url.pathname === '/' || url.pathname === '/index.html' ? '/thane/' : `/thane${url.pathname}`;
  return ctx.env.ASSETS.fetch(new Request(url.toString(), ctx.request));
}
