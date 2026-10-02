export const httpMethods = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
// allowedOrigins entries are scheme + loopback host + port only. A path such
// as http://127.0.0.1:8000/api is an endpoint URL, not an origin.
export function localUrl(value: string, originOnly = false): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash ||
    (originOnly && (url.pathname !== "/" || url.search))
  )
    throw new Error("Only explicit HTTP(S) loopback origins are allowed");
  return url;
}
