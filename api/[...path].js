import worker from "../worker.js";

// Vercel Edge Function adapter for the Cloudflare Module Worker entrypoint.
export const config = {
  runtime: "edge",
};

function workerRequest(request) {
  const url = new URL(request.url);

  // Vercel exposes this function under /api/*; the Worker expects /v1/* or
  // /healthz, so remove the function prefix before dispatching.
  if (url.pathname === "/api") {
    url.pathname = "/";
  } else if (url.pathname.startsWith("/api/")) {
    url.pathname = url.pathname.slice("/api".length) || "/";
  }

  return new Request(url, request);
}

export default function handler(request) {
  const env = {
    API_KEY: process.env.API_KEY || "",
    FREEBUFF_TOKEN: process.env.FREEBUFF_TOKEN || "",
    FREEBUFF_API_KEY: process.env.FREEBUFF_API_KEY || "",
    FREEBUFF_DEBUG: process.env.FREEBUFF_DEBUG || "",
    FREEBUFF_USER_ID: process.env.FREEBUFF_USER_ID || "",
  };

  return worker.fetch(workerRequest(request), env);
}
