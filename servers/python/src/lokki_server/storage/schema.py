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
    Column("name", String(32), primary_key=True),
    Column("value", String(200), nullable=False),
)

accounts = Table(
    "accounts",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("name", String(200), nullable=False),
    # the vault's counter: the last sequence number given to a row
    Column("head", BigInteger, nullable=False, default=0),
    # the keyring exactly as last written, its vault ID, and how many times it was written
    Column("keyring", Text, nullable=True),
    Column("vault", String(64), nullable=True),
    Column("keyring_version", Integer, nullable=False, default=0),
    Column("created", BigInteger, nullable=False),
    Column("changed", BigInteger, nullable=False),
)

tokens = Table(
    "tokens",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("account_id", Integer, ForeignKey("accounts.id"), nullable=False, index=True),
    # SHA-256 of the token, hex; the token itself is never stored
    Column("hash", String(64), nullable=False, unique=True),
    Column("scope", String(5), nullable=False),
    Column("created", BigInteger, nullable=False),
    Column("last_used", BigInteger, nullable=True),
)

rows = Table(
    "rows",
    metadata,
    Column("account_id", Integer, ForeignKey("accounts.id"), nullable=False),
    Column("key", String(22), nullable=False),
    Column("seq", BigInteger, nullable=False),
    Column("data", Text, nullable=False),
    PrimaryKeyConstraint("account_id", "key"),
    Index(None, "account_id", "seq", unique=True),
)
