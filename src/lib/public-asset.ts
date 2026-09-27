/** A file from `public/`. Under a path base (the GitHub Pages demo lives at
 * `/prism/`) it gets that prefix; the desktop build's base is relative, and
 * its files stay at the root as they always were. */
export function publicAsset(name: string): string {
  const base = import.meta.env.BASE_URL;
  return base.startsWith("/") ? `${base}${name}` : `/${name}`;
}

/** The router's basename: `/prism` for the Pages demo, none otherwise. */
export function routerBasename(): string | undefined {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return base.startsWith("/") && base !== "" ? base : undefined;
}
