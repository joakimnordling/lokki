"""Tables of the SQL storage. Changes need an Alembic migration in ``lokki_server/migrations``."""

from sqlalchemy import (
    BigInteger,
    Column,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    String,
    Table,
    Text,
    UniqueConstraint,
)

# Named constraints, so migrations can refer to them on every database
metadata = MetaData(
    naming_convention={
        "ix": "ix_%(table_name)s_%(column_0_N_name)s",
        "uq": "uq_%(table_name)s_%(column_0_N_name)s",
        "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
        "pk": "pk_%(table_name)s",
    }
)

# Times are milliseconds since 1970 (UTC), like everywhere in the protocol.

server = Table(
    "server",
    metadata,
    Column(
        "name",
        String(32),
        primary_key=True,
    ),
    Column(
        "value",
        String(200),
        nullable=False,
    ),
)

vaults = Table(
    "vaults",
    metadata,
    # internal only: the command line refers to vaults by name
    Column(
        "id",
        Integer,
        primary_key=True,
        autoincrement=True,
    ),
    # unique and case-sensitive; the allowed characters are checked in lokki_server.names
    Column(
        "name",
        String(64),
        nullable=False,
        unique=True,
    ),
    # the vault's counter: the last sequence number given to a row
    Column(
        "head",
        BigInteger,
        nullable=False,
        default=0,
    ),
    # the keyring exactly as last written, the vault ID inside it (made by the devices, unrelated
    # to `id`), and how many times it was written
    Column(
        "keyring",
        Text,
        nullable=True,
    ),
    Column(
        "keyring_vault_id",
        String(64),
        nullable=True,
    ),
    Column(
        "keyring_version",
        Integer,
        nullable=False,
        default=0,
    ),
    Column(
        "created",
        BigInteger,
        nullable=False,
    ),
    Column(
        "changed",
        BigInteger,
        nullable=False,
    ),
)

tokens = Table(
    "tokens",
    metadata,
    Column(
        "id",
        Integer,
        primary_key=True,
        autoincrement=True,
    ),
    Column(
        "vault_id",
        Integer,
        ForeignKey("vaults.id"),
        nullable=False,
    ),
    # what the token is for, e.g. a device's name; unique within the vault
    Column(
        "label",
        String(100),
        nullable=False,
    ),
    # SHA-256 of the token, hex; the token itself is never stored
    Column(
        "hash",
        String(64),
        nullable=False,
        unique=True,
    ),
    Column(
        "scope",
        String(5),
        nullable=False,
    ),
    Column(
        "created",
        BigInteger,
        nullable=False,
    ),
    Column(
        "last_used",
        BigInteger,
        nullable=True,
    ),
    UniqueConstraint("vault_id", "label"),
)

rows = Table(
    "rows",
    metadata,
    Column(
        "vault_id",
        Integer,
        ForeignKey("vaults.id"),
        nullable=False,
    ),
    Column(
        "key",
        String(22),
        nullable=False,
    ),
    Column(
        "seq",
        BigInteger,
        nullable=False,
    ),
    Column(
        "data",
        Text,
        nullable=False,
    ),
    PrimaryKeyConstraint("vault_id", "key"),
    Index(
        None,
        "vault_id",
        "seq",
        unique=True,
    ),
)
