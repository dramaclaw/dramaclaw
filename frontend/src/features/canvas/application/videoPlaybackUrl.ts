/** Request a browser-compatible copy only for project-local LibTV imports. */
export function browserPlaybackUrl(source: string | null, pageOrigin: string): string | null {
  if (!source) return null;
  try {
    const url = new URL(source, pageOrigin);
    if (url.origin !== pageOrigin) return source;
    if (!url.pathname.startsWith("/static/projects/")) return source;
    if (!/\/freezone\/liblib_import\/[^/]+\/media\/[^/]+\.mp4$/i.test(url.pathname)) {
      return source;
    }
    url.searchParams.set("st_video", "h264");
    return source.startsWith("/")
      ? `${url.pathname}${url.search}${url.hash}`
      : url.toString();
  } catch {
    return source;
  }
}
