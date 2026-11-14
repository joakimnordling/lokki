import json
from typing import Any

import pytest

from lokki_protocol.crypto import (
    DamagedKeyringError,
    DamagedRowError,
    FormatError,
    WrongPassphraseError,
    b64url,
    change_passphrase,
    decrypt_row,
    derive_keys,
    encrypt_row,
    keyring_mac,
    new_keyring,
    pad,
    unb64url,
    unlock,
)
from vectors.generate import OUT, generate

VECTORS: dict[str, Any] = json.loads(OUT.read_text())
APP = "lokki"
READ = {"app": APP, "kinds": ("entry", "metric")}
KEYS = derive_keys(bytes.fromhex(VECTORS["data_key"]), APP)
SMALL = {"name": "argon2id", "m": 64, "t": 1, "p": 1}


def test_the_file_matches_the_generator() -> None:
    assert json.loads(json.dumps(generate(), ensure_ascii=False)) == VECTORS, (
        "run: uv run python vectors/generate.py"
    )


@pytest.mark.parametrize(
    "row", VECTORS["rows"], ids=lambda r: f"{r['record']['kind']}-{r['padded_length']}"
)
def test_rows_decrypt_to_their_records(row: dict[str, Any]) -> None:
    assert decrypt_row(KEYS, row["key"], row["data"], **READ) == row["record"]


def test_padding() -> None:
    assert len(pad("x")) == 192
    assert len(pad("x" * 192)) == 192
    assert len(pad("x" * 193)) == 256
    assert len(pad("ä" * 100)) == 256  # bytes, not characters
    assert pad("{}").rstrip(b" ") == b"{}"


def test_a_new_nonce_every_time() -> None:
    record = VECTORS["rows"][0]["record"]
    assert encrypt_row(KEYS, record, app=APP)[1] != encrypt_row(KEYS, record, app=APP)[1]


def test_unknown_formats_and_damage() -> None:
    row = VECTORS["rows"][0]
    other = VECTORS["rows"][2]
    with pytest.raises(FormatError):
        decrypt_row(KEYS, row["key"], "v2." + row["data"][3:], **READ)
    with pytest.raises(FormatError):
        decrypt_row(KEYS, row["key"], "garbage", **READ)
    with pytest.raises(DamagedRowError):
        decrypt_row(KEYS, row["key"], row["data"][:-4] + "AAAA", **READ)
    with pytest.raises(DamagedRowError):
        decrypt_row(KEYS, other["key"], row["data"], **READ)  # contents moved to another row
    with pytest.raises(DamagedRowError):
        decrypt_row(KEYS, row["key"], "v1.AAAA", **READ)
    with pytest.raises(DamagedRowError):
        decrypt_row(KEYS, row["key"], "v1.not*base64", **READ)


def test_a_record_must_belong_to_its_key() -> None:
    record = {**VECTORS["rows"][0]["record"], "id": "someone-else"}
    key, data = encrypt_row(KEYS, record, app=APP)
    stolen_key = VECTORS["rows"][0]["key"]
    # Re-encrypting under another key's additional data is impossible without the keys, but even
    # with them, a record whose kind and id don't give the row's key is refused.
    assert decrypt_row(KEYS, key, data, **READ)["id"] == "someone-else"
    with pytest.raises(DamagedRowError):
        decrypt_row(KEYS, stolen_key, data, **READ)


def test_keyring_unlocks_with_the_passphrase() -> None:
    keyring = VECTORS["keyring"]["keyring"]
    assert unlock(keyring, VECTORS["keyring"]["passphrase"], app=APP) == bytes.fromhex(
        VECTORS["data_key"]
    )
    with pytest.raises(WrongPassphraseError):
        unlock(keyring, "wrong", app=APP)


def test_a_changed_keyring_is_noticed() -> None:
    keyring = {**VECTORS["keyring"]["keyring"], "u": VECTORS["keyring"]["keyring"]["u"] + 1}
    with pytest.raises(DamagedKeyringError):
        unlock(keyring, VECTORS["keyring"]["passphrase"], app=APP)


def test_changing_the_passphrase_keeps_the_data_key() -> None:
    keyring, data_key = new_keyring("first passphrase", app=APP, now=1000, kdf=SMALL)
    changed = change_passphrase(keyring, data_key, "second passphrase", app=APP, now=500, kdf=SMALL)

    assert changed["u"] == 1001  # newer even though the clock says otherwise
    assert changed["vault"] == keyring["vault"]
    assert unlock(changed, "second passphrase", app=APP) == data_key
    with pytest.raises(WrongPassphraseError):
        unlock(changed, "first passphrase", app=APP)
    assert changed["mac"] == keyring_mac(derive_keys(data_key, APP), changed)


def test_other_kinds_of_entries_are_skipped_and_kept() -> None:
    keyring, data_key = new_keyring("phrase", app=APP, now=1, kdf=SMALL)
    future: dict[str, Any] = {
        "id": "r1",
        "type": "recovery",
        "created": 1,
        "kdf": {},
        "wrapped": "x",
    }
    keyring = change_passphrase(
        {**keyring, "keys": [future, *keyring["keys"]]},
        data_key,
        "phrase",
        app=APP,
        now=2,
        kdf=SMALL,
    )

    assert [e["type"] for e in keyring["keys"]] == ["passphrase", "recovery"]
    assert unlock(keyring, "phrase", app=APP) == data_key


def test_another_apps_vectors() -> None:
    other = VECTORS["other_app"]
    app, read = other["app"], {"app": other["app"], "kinds": tuple(other["kinds"])}
    keys = derive_keys(bytes.fromhex(VECTORS["data_key"]), app)
    assert keys.row_names.hex() == other["derived_keys"]["row_names"]
    assert keys != KEYS
    row = other["row"]
    assert encrypt_row(keys, row["record"], app=app, nonce=bytes.fromhex(row["nonce"])) == (
        row["key"],
        row["data"],
    )
    assert decrypt_row(keys, row["key"], row["data"], **read) == row["record"]
    assert unlock(other["keyring"], VECTORS["keyring"]["passphrase"], app=app) == bytes.fromhex(
        VECTORS["data_key"]
    )


def test_an_apps_keys_open_only_its_own() -> None:
    other = VECTORS["other_app"]
    row = other["row"]
    # Lokki's keys, or the other app's keys with Lokki's additional data, don't decrypt its row
    with pytest.raises(DamagedRowError):
        decrypt_row(KEYS, row["key"], row["data"], app=other["app"], kinds=("note",))
    keys = derive_keys(bytes.fromhex(VECTORS["data_key"]), other["app"])
    with pytest.raises(DamagedRowError):
        decrypt_row(keys, row["key"], row["data"], app=APP, kinds=("note",))
    with pytest.raises(DamagedRowError):  # a kind this app doesn't have
        decrypt_row(keys, row["key"], row["data"], **READ | {"app": other["app"]})
    with pytest.raises(WrongPassphraseError):
        unlock(other["keyring"], VECTORS["keyring"]["passphrase"], app=APP)
    with pytest.raises(ValueError, match="app name"):
        derive_keys(b"x" * 32, "Lokki")


def test_base64url() -> None:
    assert b64url(b"\xfb\xff") == "-_8"
    assert unb64url("-_8") == b"\xfb\xff"
    assert unb64url("-_8=") == b"\xfb\xff"
    with pytest.raises(ValueError, match="base64url"):
        unb64url("+/8")
