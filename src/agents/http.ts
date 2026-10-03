import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { httpMethods, localUrl } from "../config/http.ts";
import type { TeamConfig } from "../config/schema.ts";
const requestSchema = z
  .object({
    method: z.enum(httpMethods).default("GET"),
    url: z.string(),
    headers: z.record(z.string()).default({}),
    body: z.string().optional(),
    json: z.unknown().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export function localHttpTool(config: TeamConfig): ToolDefinition {
  return {
    name: "team_local_http",
    label: "Approved local HTTP test",
    description:
      "Bounded HTTP request to explicitly approved loopback origins. No redirects, proxies, environment credentials or unsafe framing headers. body and json are mutually exclusive. GET/HEAD have no payload.",
    parameters: Type.Object({
      url: Type.String(),
      method: Type.Optional(
        Type.Union(httpMethods.map((m) => Type.Literal(m))),
      ),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.String()),
      json: Type.Optional(Type.Unknown()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, raw, signal) {
      const input = requestSchema.parse(raw),
        policy = config.pentest.localHttp;
      const url = localUrl(input.url);
      const origins = [
        ...policy.allowedOrigins,
        ...config.pentest.localUrls,
      ].map((v) => localUrl(v).origin);
      if (!origins.includes(url.origin))
        throw new Error("Endpoint origin not authorized");
      if (!policy.allowedMethods.includes(input.method))
        throw new Error("HTTP method not approved");
      const hasJson = Object.prototype.hasOwnProperty.call(raw, "json");
      if (input.body !== undefined && hasJson)
        throw new Error("body and json are mutually exclusive");
      if (
        ["GET", "HEAD"].includes(input.method) &&
        (input.body !== undefined || hasJson)
      )
        throw new Error("GET/HEAD bodies are not supported");
      const body =
        input.body ?? (hasJson ? JSON.stringify(input.json) : undefined);
      if (hasJson && body === undefined)
        throw new Error("json must be serializable");
      if (Buffer.byteLength(body ?? "") > policy.maxRequestBodyBytes)
        throw new Error("Request body exceeds configured byte limit");
      const headers: Record<string, string> = {};
      if (Object.keys(input.headers).length > 32)
        throw new Error("Too many request headers");
      let bytes = 0;
      for (const [key, value] of Object.entries(input.headers)) {
        const lower = key.toLowerCase();
        if (
          !/^[!#$%&'*+.^_`|~\w-]+$/.test(key) ||
          /[\r\n\0]/.test(value) ||
          [
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "upgrade",
            "expect",
            "trailer",
            "te",
            "proxy-authorization",
            "proxy-connection",
            "proxy-authenticate",
            "forwarded",
            "x-forwarded-host",
          ].includes(lower) ||
          lower in headers
        )
          throw new Error("Unsafe or duplicate request header");
        bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
        headers[lower] = value;
      }
      if (bytes > 8192) throw new Error("Request headers exceed byte limit");
      if (hasJson && !headers["content-type"])
        headers["content-type"] = "application/json";
      if (body !== undefined)
        headers["content-length"] = String(Buffer.byteLength(body));
      const timeout = input.timeoutMs ?? policy.timeoutMs;
      if (timeout > policy.timeoutMs)
        throw new Error("Request timeout exceeds configured limit");
      if (signal?.aborted) throw new Error("HTTP request aborted");
      const started = performance.now();
      const result = await new Promise<{
        status: number;
        statusText: string;
        headers: Record<string, string>;
        body: string;
        truncated: boolean;
        durationMs: number;
      }>((resolve, reject) => {
        // Node's direct transport ignores HTTP_PROXY. DNS is checked and pinned to the
        // returned loopback address for this connection; no second resolving request.
        const request = (
          url.protocol === "https:" ? httpsRequest : httpRequest
        )(url, {
          method: input.method,
          headers,
          agent: false,
          maxHeaderSize: 16384,
          lookup(host, options, callback) {
            if (host !== "localhost") {
              callback(new Error("Unexpected DNS hostname"), "", 4);
              return;
            }
            lookup(
              host,
              { family: options.family ?? 0, all: true },
              (error, addresses) => {
                if (error) {
                  callback(error, "", 4);
                  return;
                }
                if (
                  !addresses.length ||
                  addresses.some(
                    (a) => !["127.0.0.1", "::1"].includes(a.address),
                  )
                ) {
                  callback(
                    new Error("Localhost resolved outside loopback"),
                    "",
                    4,
                  );
                  return;
                }
                if (options.all) (callback as any)(null, addresses);
                else callback(null, addresses[0].address, addresses[0].family);
              },
            );
          },
        });
        let settled = false;
        const finish = (error?: Error, value?: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(value);
        };
        const abort = () => request.destroy(new Error("HTTP request aborted"));
        const timer = setTimeout(
          () => request.destroy(new Error("HTTP request timeout")),
          timeout,
        );
        signal?.addEventListener("abort", abort, { once: true });
        request.on("error", (error) => finish(error));
        request.on("response", (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            response.destroy();
            request.destroy();
            finish(new Error("Redirect responses are disabled"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          const complete = (truncated: boolean) => {
            const decoder = new StringDecoder("utf8");
            const body = chunks.map((chunk) => decoder.write(chunk)).join("");
            const responseHeaders = Object.fromEntries(
              Object.entries(response.headers).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(", ") : (value ?? ""),
              ]),
            );
            finish(undefined, {
              status: response.statusCode ?? 0,
              statusText: response.statusMessage ?? "",
              headers: responseHeaders,
              // At the byte cap, discard an incomplete trailing code point.
              body: truncated ? body : body + decoder.end(),
              truncated,
              durationMs: Math.round(performance.now() - started),
            });
          };
          response.on("data", (chunk: Buffer) => {
            const remaining = policy.maxResponseBodyBytes - size;
            chunks.push(chunk.subarray(0, remaining));
            size += Math.min(chunk.length, remaining);
            if (chunk.length > remaining) {
              complete(true);
              response.destroy();
              request.destroy();
            }
          });
          response.on("end", () => complete(false));
          response.on("error", (error) => finish(error));
          response.on("aborted", () =>
            finish(new Error("HTTP response aborted")),
          );
        });
        request.end(body);
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
