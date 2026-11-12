/// <reference lib="esnext" />
/**
 * The ETF brand feeds the screener reads directly (plan stage 0: no copies of the data). The brand list itself is not copied
 * either (owner answer N5): the ETFs hub publishes it as brands.json on its GitHub Pages site, the app fetches it at run time and
 * parseEtfBrands() checks every entry. Every brand publishes api/<slug>/index.json on its own GitHub Pages site, which sends
 * access-control-allow-origin: *, so the same URLs work on github.io and on localhost
 */
export type EtfBrand = { repo: string; slug: string; brand: string; issuerLabel: string; issuerUrl: string };

export const ETF_PAGES_ORIGIN = 'https://daggerok.github.io/';

/** The hub's brand list: an array of { repo, brand, slug, issuerLabel, issuerUrl } in the hub order */
export const ETF_BRANDS_URL = `${ETF_PAGES_ORIGIN}ETFs/brands.json`;

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Valid entries in the published order; an entry without a usable repo or slug, or a repeated repo or slug, is left out and
 * named in errors. A payload that is not an array gives no brands and one error
 */
export function parseEtfBrands(data: unknown): { brands: EtfBrand[]; errors: string[] } {
  if (!Array.isArray(data)) return { brands: [], errors: ['brands.json is not an array'] };
  const brands: EtfBrand[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  data.forEach((entry: unknown, i: number) => {
    const o: Record<string, unknown> = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const repo = text(o.repo);
    const slug = text(o.slug);
    if (!REPO_RE.test(repo) || !SLUG_RE.test(slug)) { errors.push(`entry ${i}: bad repo or slug`); return; }
    if (seen.has(`r:${repo}`) || seen.has(`s:${slug}`)) { errors.push(`entry ${i}: duplicate ${repo}`); return; }
    seen.add(`r:${repo}`);
    seen.add(`s:${slug}`);
    brands.push({ repo, slug, brand: text(o.brand) || repo, issuerLabel: text(o.issuerLabel), issuerUrl: text(o.issuerUrl) });
  });
  return { brands, errors };
}

export const etfFeedUrl = (brand: { repo: string; slug: string }, origin: string = ETF_PAGES_ORIGIN): string => `${origin}${encodeURIComponent(brand.repo)}/api/${brand.slug}/index.json`;
