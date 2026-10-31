/**
 * Reads a port number written in decimal digits, 0 to 65535, with no sign, spaces or leading zeros (so "08110"
 * can't be mistaken for 8110 by one reader and refused by another). Returns undefined for anything else.
 */
export function parsePort(text: string): number | undefined {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(text)) return undefined;
  const port = Number(text);
  return port <= 65535 ? port : undefined;
}

/** `host:port`, with an IPv6 address in brackets as URLs need it (`[::1]:8110`). */
export function hostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * Reads COEDIT_ORIGINS: web origins separated by commas, each `http://` or `https://`, a host, an optional port, and
 * nothing after it (an origin has no path; a browser sends `http://localhost:5173`, never with a slash). Spaces
 * around the commas are allowed; an empty setting allows no browser page at all. Returns undefined for anything
 * else, rather than guess.
 */
export function parseOrigins(text: string): string[] | undefined {
  if (text.trim() === '') return [];
  const origins = text.split(',').map((part) => part.trim());
  const valid = origins.every((origin) =>
    /^https?:\/\/[A-Za-z0-9.-]+(:[1-9][0-9]{0,4})?$|^https?:\/\/\[[0-9A-Fa-f:.]+\](:[1-9][0-9]{0,4})?$/.test(
      origin,
    ),
  );
  return valid ? origins : undefined;
}
