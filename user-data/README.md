# User data

The owner's own screener data. Everything here is public: it is committed to this public repository and published with the site

| Path | Content |
| --- | --- |
| `presets/<id>.json` | Own screener presets, the same schema as the base presets in `src/core/screener/presets/` (`schemaVersion` 1) |
| `peers.json` | Peer groups: `{"schemaVersion": 1, "groups": {"<name>": ["TICKER", ...]}}`, U.S.-listed tickers only (foreign companies through their ADRs) |
| `notes/<TICKER>.md` | Thesis and research notes |
| `tam/<TICKER>.json` | TAM scenarios |
| `promises/<TICKER>.json` | Management promises tracker |

## How data gets here

1. Edit presets, peers, notes, TAM and promises in the app: they are saved in the browser
2. Export them from the app: the exported file names already match the paths above
3. Copy the files into this folder and commit them like any other change (a pull request)
4. After the next deploy the site reads them as the starting state; when the browser holds a newer copy, the browser copy wins and is marked as not exported

The app never writes to the repository: no token, no GitHub API calls from the browser
