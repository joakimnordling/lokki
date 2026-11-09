"""What vault names and token labels may be: only the server knows them, not the protocol."""

import re

# Vault names: letters, digits and . _ + - @, starting with a letter or digit (so a name never looks
# like a command-line option), at most 64 characters. Case-sensitive: "jocke" and "Jocke" differ.
VAULT_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+@-]{0,63}")
VAULT_NAME_RULE = (
    "Use 1 to 64 letters, digits and . _ + - @, starting with a letter or digit, e.g. jocke."
)

# Token labels: any text, e.g. a device's name, without control characters, at most 100 characters
LABEL_MAX = 100
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def check_vault_name(name: str) -> str:
    """The name if it's allowed; ValueError otherwise."""
    if not VAULT_NAME.fullmatch(name):
        raise ValueError(f"{name!r} can't be a vault's name. {VAULT_NAME_RULE}")
    return name


def check_label(label: str) -> str:
    """The label without surrounding spaces, if it's allowed; ValueError otherwise."""
    label = label.strip()
    if not label or len(label) > LABEL_MAX or _CONTROL.search(label):
        raise ValueError(
            f"A token's label needs 1 to {LABEL_MAX} characters, without control characters."
        )
    return label
