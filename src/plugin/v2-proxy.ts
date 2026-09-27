import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export type LegacyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AntigravityProxy {
  url: string;
  token: string;
  close: () => Promise<void>;
}

const TARGET_HEADER = "x-opencode-antigravity-target";
const TOKEN_HEADER = "x-opencode-antigravity-token";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export async function startAntigravityProxy(getFetch: () => Promise<LegacyFetch>): Promise<AntigravityProxy> {
  const token = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    void handleRequest(request, response, token, getFetch).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Antigravity proxy request failed" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Could not determine Antigravity proxy address");
  }

  server.unref();

  return {
    url: `http://127.0.0.1:${address.port}/generate`,
    token,
    close: () => closeServer(server),
  };
}

async function handleRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  expectedToken: string,
  getFetch: () => Promise<LegacyFetch>,
): Promise<void> {
  const token = incoming.headers[TOKEN_HEADER];
  const target = incoming.headers[TARGET_HEADER];
  if (
    token !== expectedToken ||
    typeof target !== "string" ||
    incoming.url !== "/generate"
  ) {
    outgoing.writeHead(404);
    outgoing.end();
    return;
  }

  let targetURL: URL;
  try {
    targetURL = new URL(target);
  } catch {
    outgoing.writeHead(400);
    outgoing.end("Invalid target URL");
    return;
  }
  if (targetURL.protocol !== "https:" || targetURL.hostname !== "generativelanguage.googleapis.com") {
    outgoing.writeHead(403);
    outgoing.end("Target is not an allowed Google Generative Language endpoint");
    return;
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (HOP_BY_HOP_HEADERS.has(name) || name === TARGET_HEADER || name === TOKEN_HEADER || value === undefined) {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  const controller = new AbortController();
  incoming.once("aborted", () => controller.abort(new Error("OpenCode request was aborted")));
  const method = incoming.method ?? "POST";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    signal: controller.signal,
  };
  if (hasBody) {
    init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }

  const request = new Request(targetURL, init);
  const response = await (await getFetch())(request);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  outgoing.writeHead(response.status, responseHeaders);

  if (!response.body) {
    outgoing.end();
    return;
  }

  const stream = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
  stream.once("error", (error: Error) => outgoing.destroy(error));
  stream.pipe(outgoing);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
