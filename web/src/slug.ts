/** O QR aponta para /e/<slug>. Qualquer outro caminho não tem slug. */
export function slugFromPath(pathname: string): string | null {
  const match = /^\/e\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
