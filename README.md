# Lokki

A personal life-logging app: log values (a swim, your weight, anything you count) and see them as totals and
averages per day, week or month, with rankings, distributions, correlations and day-of-week patterns.

Lokki is a web app that keeps its data on your device (IndexedDB) and can sync it between devices. It is the
successor to _Loggr – Graph Your Life_, an iOS app that is no longer available, and it can import that app's CSV
exports.

## Status

Lokki runs at <https://lokki.jocke.fi>, where it keeps everything on your device (use Preferences → Back Up now and
then). Syncing between devices works when it runs as an artifact on claude.ai; a sync service of its own is planned.

On an iPhone, open the site in Safari and choose Share → Add to Home Screen. It works offline once opened.

## Layout

```
index.html          the page; loads src/app.js as an ES module (no build step needed)
public/             static files: styles, the Jost font, icons, web app manifest
src/core/           pure functions: formatting, periods, statistics, ids, CSV, zip, backup format
src/data/           this device's copy: state, IndexedDB, local changes, backups
src/sync/           merging remote changes; the claude.ai database adapter
src/ui/             rendering, sheets, chart, entry list, preferences, files
scripts/            dev server, the site build (with its service worker) and the claude.ai artifact build
tests/unit/         node:test unit tests
tests/e2e/          Playwright tests: several simulated devices syncing through a fake database
```

## Development

Requirements: Node.js 22+ and [pre-commit](https://pre-commit.com).

```sh
npm ci
pre-commit install --install-hooks   # checks on every commit, unit tests before every push
npm run serve                        # http://localhost:8080
npm test                             # unit tests
npx playwright install chromium      # once, for the end-to-end tests
npm run test:e2e                     # builds the artifact, then runs the end-to-end tests
npm run build:site                   # dist/site, the site deployed to GitHub Pages
npm run build:artifact               # dist/lokki-artifact.html, the single page published on claude.ai
```

Every push to `main` deploys the site to GitHub Pages (`.github/workflows/pages.yml`).

The end-to-end tests run against both the built artifact and the unbundled modules, with generated data only.

## License

[MIT](LICENSE). Third-party material is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
