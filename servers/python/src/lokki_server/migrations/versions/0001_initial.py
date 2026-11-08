"""
Initial tables: server, accounts, tokens and rows.

Revision ID: 0001
Revises:
Create Date: 2026-11-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "server",
        sa.Column("name", sa.String(32), nullable=False),
        sa.Column("value", sa.String(200), nullable=False),
        sa.PrimaryKeyConstraint("name", name="pk_server"),
    )
    op.create_table(
        "accounts",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("head", sa.BigInteger(), nullable=False),
        sa.Column("keyring", sa.Text(), nullable=True),
        sa.Column("vault", sa.String(64), nullable=True),
        sa.Column("keyring_version", sa.Integer(), nullable=False),
        sa.Column("created", sa.BigInteger(), nullable=False),
        sa.Column("changed", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_accounts"),
    )
    op.create_table(
        "tokens",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("hash", sa.String(64), nullable=False),
        sa.Column("scope", sa.String(5), nullable=False),
        sa.Column("created", sa.BigInteger(), nullable=False),
        sa.Column("last_used", sa.BigInteger(), nullable=True),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name="fk_tokens_account_id_accounts"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_tokens"),
        sa.UniqueConstraint("hash", name="uq_tokens_hash"),
    )
    op.create_index("ix_tokens_account_id", "tokens", ["account_id"])
    op.create_table(
        "rows",
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("key", sa.String(22), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("data", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name="fk_rows_account_id_accounts"
        ),
        sa.PrimaryKeyConstraint("account_id", "key", name="pk_rows"),
    )
    op.create_index("ix_rows_account_id_seq", "rows", ["account_id", "seq"], unique=True)


def downgrade() -> None:
    op.drop_table("rows")
    op.drop_table("tokens")
    op.drop_table("accounts")
    op.drop_table("server")
