/// <reference lib="esnext" />
/**
 * The 29 ETF brand feeds the screener reads directly (plan stage 0: no copies of the data). Repo folder and feed slug are the
 * BRANDS list of the ETFs hub (investments/ETFs/src/main.tsx, generated from the workspace etf-std/registry.json); the workspace
 * check stocks-std/check-brands.ts keeps this list equal to the hub's. Every brand publishes api/<slug>/index.json on its own
 * GitHub Pages site, which sends access-control-allow-origin: *, so the same URL works on github.io and on localhost
 */
export type EtfBrand = { repo: string; slug: string };

export const ETF_PAGES_ORIGIN = 'https://daggerok.github.io/';

export const ETF_BRANDS: readonly EtfBrand[] = [
  { repo: 'AAM', slug: 'aam' },
  { repo: 'aberdeen', slug: 'aberdeen' },
  { repo: 'Amplify', slug: 'amplify' },
  { repo: 'ARK', slug: 'ark' },
  { repo: 'Capital-Group', slug: 'capital-group' },
  { repo: 'Fidelity', slug: 'fidelity' },
  { repo: 'First-Trust', slug: 'firsttrust' },
  { repo: 'Franklin', slug: 'franklin' },
  { repo: 'Global-X', slug: 'globalx' },
  { repo: 'Goldman-Sachs', slug: 'goldmansachs' },
  { repo: 'Invesco', slug: 'invesco' },
  { repo: 'iShares', slug: 'ishares' },
  { repo: 'JPMorgan', slug: 'jpmorgan' },
  { repo: 'Neos', slug: 'neos' },
  { repo: 'Northern-Trust', slug: 'northerntrust' },
  { repo: 'Pacer', slug: 'pacer' },
  { repo: 'Parametric', slug: 'parametric' },
  { repo: 'ProShares', slug: 'proshares' },
  { repo: 'Schwab', slug: 'schwab' },
  { repo: 'SP-Funds', slug: 'spfunds' },
  { repo: 'SPDR', slug: 'spdr' },
  { repo: 'Sprott', slug: 'sprott' },
  { repo: 'Tema', slug: 'tema' },
  { repo: 'Themes', slug: 'themes' },
  { repo: 'VanEck', slug: 'vaneck' },
  { repo: 'Vanguard', slug: 'vanguard' },
  { repo: 'VictoryShares', slug: 'victoryshares' },
  { repo: 'WisdomTree', slug: 'wisdomtree' },
  { repo: 'Xtrackers', slug: 'xtrackers' },
];

export const etfFeedUrl = (brand: EtfBrand, origin: string = ETF_PAGES_ORIGIN): string => `${origin}${encodeURIComponent(brand.repo)}/api/${brand.slug}/index.json`;
