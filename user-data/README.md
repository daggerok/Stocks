# User data

The owner's own screener data. Everything here is public: it is committed to this public repository and published with the site

| Path | Content |
| --- | --- |
| `presets/<id>.json` | Own screener presets, the same schema as the base presets in `src/core/screener/presets/` (`schemaVersion` 1), each listed in `presets/index.json` (the site has no directory listing; a test checks the list) |
| `peers.json` | Peer groups: `{"schemaVersion": 1, "groups": {"<name>": ["TICKER", ...]}}`, U.S.-listed tickers only (foreign companies through their ADRs) |
| `notes/<TICKER>.md` | Dated thesis, the nine-question checklist and other notes (Markdown with fixed headings), listed in `notes/index.json` |
| `tam/<TICKER>.json` | TAM: market, size in USD, growth, horizon and the low, mid and high market shares, listed in `tam/index.json` |
| `dcf/<TICKER>.json` | DCF inputs edited on the ticker page: EPS flow base (reported or operating), g1, g2, WACC, terminal growth, FCF, EPS, operating EPS, net debt, shares (null = empty), listed in `dcf/index.json` |
| `promises/<TICKER>.json` | Management promises: kind (guidance, buyback, capex, other), text, announced, deadline, amount in USD, status, listed in `promises/index.json` |

## How data gets here

1. Edit presets, peers, notes, TAM, promises and DCF inputs in the app: they are saved in the browser
2. Export them from the app: the exported file names already match the paths above
3. Copy the files into this folder (a preset, TAM, note, promises or DCF file also goes into the `index.json` of its folder) and commit them like any other change (a pull request)
4. After the next deploy the site reads them as the starting state; when the browser holds a newer copy, the browser copy wins and is marked as not exported

The app never writes to the repository: no token, no GitHub API calls from the browser
