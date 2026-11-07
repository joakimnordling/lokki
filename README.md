# Lokki

A personal life-logging app: log values (a swim, your weight, anything you count) and see them as totals and
averages per day, week or month, with rankings, distributions, correlations and day-of-week patterns.

Lokki is a web app that keeps its data on your device (IndexedDB) and can sync it between devices. It is the
successor to _Loggr – Graph Your Life_, an iOS app that is no longer available, and it can import that
app's CSV exports.

## Status

Early days: the app currently runs as a private artifact on claude.ai and is being moved to this repository and to
its own hosting. See the issues and pull requests for progress.

## Development

Requirements: Node.js 22+ and [pre-commit](https://pre-commit.com).

```sh
pre-commit install --install-hooks              # checks run on every commit
pre-commit install --hook-type pre-push         # tests run before every push
```

## License

[MIT](LICENSE). Third-party material is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
