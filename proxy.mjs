/**
 * Minimal CORS proxy for Jira, so the browser app can reach the Jira REST API.
 *
 * Browsers refuse authenticated cross-origin requests to Jira Cloud, so the
 * page cannot call 4flow.atlassian.net directly. This forwards the request from
 * Node, where the same-origin policy does not apply, and adds the CORS headers
 * the browser wants to see.
 *
 * Run:   node proxy.mjs
 * Then:  Jira settings → Proxy URL → http://localhost:8080/
 *
 * It binds to 127.0.0.1 and only forwards to hosts in ALLOWED_HOSTS, so it is
 * not an open relay. Your Jira token is passed straight through and is never
 * written to disk or logged.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8080);
const ALLOWED_HOSTS = (process.env.JIRA_HOSTS || "4flow.atlassian.net").split(",").map((h) => h.trim());

const readBody = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // The app appends the full target URL after the leading slash.
  const target = req.url.slice(1);
  let url;
  try {
    url = new URL(target);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Expected a full target URL after the slash." }));
    return;
  }

  if (!ALLOWED_HOSTS.includes(url.host)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: `This proxy only forwards to ${ALLOWED_HOSTS.join(", ")}.`,
        hint: "Set JIRA_HOSTS to change that, e.g. JIRA_HOSTS=your-site.atlassian.net node proxy.mjs",
      })
    );
    return;
  }

  const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : undefined;

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        Accept: req.headers.accept || "application/json",
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        ...(req.headers["content-type"] ? { "Content-Type": req.headers["content-type"] } : {}),
      },
      body: body && body.length ? body : undefined,
    });

    const text = await upstream.text();
    console.log(`${req.method} ${url.pathname} → ${upstream.status}`);
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
    });
    res.end(text);
  } catch (error) {
    console.error(`${req.method} ${url.pathname} → failed:`, error.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Could not reach ${url.host}: ${error.message}` }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Jira proxy on http://localhost:${PORT}/`);
  console.log(`Forwarding to: ${ALLOWED_HOSTS.join(", ")}`);
  console.log(`Put http://localhost:${PORT}/ in the app's Jira settings → Proxy URL.`);
});
