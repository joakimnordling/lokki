"""
The text in a pairing QR code: the URL and token a device needs to sync, read by the app's
Scan QR Code button (packages/sync/pairing.js reads and writes the same format).

    lokki:sync?url=https%3A%2F%2Fsync.example.com&token=lk_...

It starts with the app's name, ``lokki`` unless the vault is for another app on the same
protocol, and each app takes only codes for its own name.

Its own scheme rather than a web address: a phone's camera app offers no link to open, so the
token doesn't end up in a browser's history or a web server's logs.
"""

import io
import re
from urllib.parse import urlencode

import segno

DEFAULT_APP = "lokki"
_APP_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")


def is_app_name(app: str) -> bool:
    """Lowercase letters, digits and dashes, at most 32, as the app's keys use it."""
    return _APP_NAME.fullmatch(app) is not None


def pairing_text(url: str, token: str, app: str = DEFAULT_APP) -> str:
    if not is_app_name(app):
        raise ValueError(f"not an app name: {app!r}")
    return f"{app}:sync?" + urlencode({"url": url, "token": token})


def pairing_qr(url: str, token: str, app: str = DEFAULT_APP) -> str:
    """
    The pairing text as a QR code for a terminal, two rows of modules per line in half blocks.

    The blocks draw the light modules, so a terminal with a dark background shows dark on light;
    one with a light background shows the code inverted, which the app reads as well.
    """
    out = io.StringIO()
    segno.make(
        pairing_text(url, token, app),
        error="m",
    ).terminal(
        out,
        compact=True,
    )
    return out.getvalue()
