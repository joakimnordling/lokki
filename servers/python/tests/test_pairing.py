import segno

from lokki_server.pairing import pairing_qr, pairing_text

# The same example is in the app's tests (tests/unit/pairing.test.js), so both write one format
URL = "https://sync1.example.com"
TOKEN = "lk_abc-DEF_123"
TEXT = "lokki:sync?url=https%3A%2F%2Fsync1.example.com&token=lk_abc-DEF_123"


def test_pairing_text() -> None:
    assert pairing_text(URL, TOKEN) == TEXT


def read_blocks(printed: str) -> list[list[int]]:
    """The modules (1 dark) of a QR code printed in half blocks, which draw the light ones."""
    halves = {" ": (1, 1), "▀": (0, 1), "▄": (1, 0), "█": (0, 0)}
    rows: list[list[int]] = []
    for line in printed.splitlines():
        pairs = [halves[c] for c in line]
        rows += [[top for top, _ in pairs], [bottom for _, bottom in pairs]]
    return rows


def test_pairing_qr_holds_the_text() -> None:
    expected = segno.make(TEXT, error="m")
    border = 4
    size = len(expected.matrix) + 2 * border
    modules = read_blocks(pairing_qr(URL, TOKEN))[:size]  # the last line's lower half is padding
    assert [row[border:-border] for row in modules[border:-border]] == [
        list(row) for row in expected.matrix
    ]
    # a light quiet zone all round
    assert all(m == 0 for row in modules[:border] + modules[-border:] for m in row)
