export const httpMethods = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
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
