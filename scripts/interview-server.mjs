#!/usr/bin/env node
// Slice B's local server: serves the built site from dist/ and the interview
// API next to it, on this machine only. See specs/agents/spec.md §5.1 and §6.
//
//   npm run interview [-- --stub] [-- --port 8788]
//
// Needs the EPAM VPN for live DIAL calls. With --stub it needs nothing.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { handleInterview, LIMITS } from "../lib/interview.mjs";
import { loadDecks } from "../lib/deck.mjs";
import { dialMode } from "../lib/dial.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");

// Loopback only. Nothing else on the network, the office Wi-Fi included, can
// reach this server or spend the key through it.
export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 8788;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  let file = path.normalize(path.join(distDir, urlPath));
  if (file !== distDir && !file.startsWith(distDir + path.sep)) return send(res, 403, { error: "forbidden" });
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    send(res, 200, await readFile(file), TYPES[path.extname(file)] ?? "application/octet-stream");
  } catch {
    send(res, 404, "Not found. Run npm run build if dist/ is missing.", "text/plain; charset=utf-8");
  }
}

export function startServer({ port = DEFAULT_PORT, decks = loadDecks(), ask, log = console.log } = {}) {
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/api/interview") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
      return serveStatic(req, res);
    }

    if (req.method === "GET") return send(res, 200, { ok: true, mode: dialMode().mode });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

    let parsed;
    try {
      parsed = JSON.parse(await readBody(req, LIMITS.requestBytes));
    } catch (e) {
      if (e.status === 413) return send(res, 413, { error: `request is over ${LIMITS.requestBytes / 1024} KB` });
      return send(res, 400, { error: "request body is not valid JSON" });
    }

    const started = Date.now();
    const { status, body } = await handleInterview(parsed, { decks, ...(ask ? { ask } : {}) });
    // Never the transcript: it is the sensitive part (spec §7.1).
    log(`${parsed?.action ?? "?"} ${parsed?.sectionId ?? "?"} → ${status} in ${Date.now() - started} ms${body.error ? `: ${body.error}` : ""}`);
    send(res, status, body);
  });

  return new Promise((resolve) => server.listen(port, HOST, () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--stub")) process.env.DIAL_STUB = "1";
  const portArg = argv.indexOf("--port");
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : DEFAULT_PORT;

  const server = await startServer({ port });
  const { mode } = dialMode();
  console.log(`Mock interview server on http://${HOST}:${server.address().port}`);
  console.log(
    mode === "stub"
      ? "! stub mode: canned replies, no DIAL calls, nothing billed"
      : "live mode: calls DIAL, needs the EPAM VPN. Ctrl+C to stop."
  );
}
