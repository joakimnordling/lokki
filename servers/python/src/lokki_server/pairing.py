"""
The text in a pairing QR code: the URL and token a device needs to sync, read by the app's
Scan QR Code button (src/sync/pairing.js reads and writes the same format).

    lokki:sync?url=https%3A%2F%2Fsync.example.com&token=lk_...

Its own scheme rather than a web address: a phone's camera app offers no link to open, so the
token doesn't end up in a browser's history or a web server's logs.
"""

import io
from urllib.parse import urlencode

import segno

PREFIX = "lokki:sync?"


def pairing_text(url: str, token: str) -> str:
    return PREFIX + urlencode({"url": url, "token": token})


def pairing_qr(url: str, token: str) -> str:
    """
    The pairing text as a QR code for a terminal, two rows of modules per line in half blocks.

    The blocks draw the light modules, so a terminal with a dark background shows dark on light;
    one with a light background shows the code inverted, which the app reads as well.
    """
    out = io.StringIO()
    segno.make(
        pairing_text(url, token),
        error="m",
    ).terminal(
        out,
        compact=True,
    )
    return out.getvalue()
