import { createRequire, syncBuiltinESMExports } from "node:module";

const fixture = new URL(new URL(import.meta.url).searchParams.get("fixture"));
if (fixture.protocol !== "http:" || fixture.hostname !== "127.0.0.1") {
  throw new Error("Codex auth catalog fixture must use loopback");
}

// Catalog workers clear inherited execArgv. Carry only this transport fixture
// into their real owner; discovery, parsing, publication, and auth stay real.
const workers = createRequire(import.meta.url)("node:worker_threads");
const Worker = workers.Worker;
workers.Worker = class extends Worker {
  constructor(url, options) {
    super(url, {
      ...options,
      execArgv: [...(options?.execArgv ?? process.execArgv), "--import", import.meta.url],
    });
  }
};
syncBuiltinESMExports();

const endpoint = "https://chatgpt.com/backend-api/codex/models?client_version=0.154.0";
const originalFetch = globalThis.fetch;
let rejected = 0;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const authorization = headers.get("authorization") ?? "";
  const fixtureCredential =
    authorization === "Bearer test-oauth-access" || authorization.endsWith(".test-signature");
  const catalogRequest =
    url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex/models");
  if (!catalogRequest && !fixtureCredential) {
    return originalFetch(input, init);
  }
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (url.href !== endpoint || method !== "GET") {
    if (rejected++ < 16) {
      console.error('[qa-codex-catalog-transport] {"endpoint":"unexpected","status":"refused"}');
    }
    return Promise.reject(new Error("Unexpected Codex auth fixture catalog request"));
  }
  const target = new URL(`${url.pathname}${url.search}`, fixture);
  const fixtureInit = { ...init };
  delete fixtureInit.dispatcher;
  return originalFetch(input instanceof Request ? new Request(target, input) : target, fixtureInit);
};
// The existing hermetic fetch contract keeps guarded requests on this transport.
globalThis.fetch.mock = {};
