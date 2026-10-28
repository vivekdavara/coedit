/**
 * Reads a port number written in decimal digits, 0 to 65535, with no sign, spaces or leading zeros (so "08110"
 * can't be mistaken for 8110 by one reader and refused by another). Returns undefined for anything else.
 */
export function parsePort(text: string): number | undefined {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(text)) return undefined;
  const port = Number(text);
  return port <= 65535 ? port : undefined;
}
