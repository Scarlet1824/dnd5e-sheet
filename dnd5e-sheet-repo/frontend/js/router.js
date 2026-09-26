const routes = [];
let notFoundHandler = () => {};

export function route(pattern, handler) {
  // pattern like "#/characters/:id"
  const keys = [];
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/:[a-zA-Z]+/g, (m) => {
          keys.push(m.slice(1));
          return "([^/]+)";
        })
        .replace(/\//g, "\\/") +
      "$"
  );
  routes.push({ regex, keys, handler });
}

export function notFound(handler) {
  notFoundHandler = handler;
}

function resolve() {
  const hash = location.hash || "#/";
  for (const r of routes) {
    const m = hash.match(r.regex);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      r.handler(params);
      return;
    }
  }
  notFoundHandler();
}

export function navigate(hash) {
  if (location.hash === hash) resolve();
  else location.hash = hash;
}

export function startRouter() {
  window.addEventListener("hashchange", resolve);
  resolve();
}
