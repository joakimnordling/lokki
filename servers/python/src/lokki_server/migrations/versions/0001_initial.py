"""
Initial tables: server, vaults, tokens and rows.

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
        "vaults",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("head", sa.BigInteger(), nullable=False),
        sa.Column("keyring", sa.Text(), nullable=True),
        sa.Column("keyring_vault_id", sa.String(64), nullable=True),
        sa.Column("keyring_version", sa.Integer(), nullable=False),
        sa.Column("created", sa.BigInteger(), nullable=False),
        sa.Column("changed", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_vaults"),
        sa.UniqueConstraint("name", name="uq_vaults_name"),
    )
    op.create_table(
        "tokens",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("vault_id", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(100), nullable=False),
        sa.Column("hash", sa.String(64), nullable=False),
        sa.Column("scope", sa.String(5), nullable=False),
        sa.Column("created", sa.BigInteger(), nullable=False),
        sa.Column("last_used", sa.BigInteger(), nullable=True),
        sa.ForeignKeyConstraint(["vault_id"], ["vaults.id"], name="fk_tokens_vault_id_vaults"),
        sa.PrimaryKeyConstraint("id", name="pk_tokens"),
        sa.UniqueConstraint("hash", name="uq_tokens_hash"),
        sa.UniqueConstraint("vault_id", "label", name="uq_tokens_vault_id_label"),
    )
    op.create_table(
        "rows",
        sa.Column("vault_id", sa.Integer(), nullable=False),
        sa.Column("key", sa.String(22), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("data", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["vault_id"], ["vaults.id"], name="fk_rows_vault_id_vaults"),
        sa.PrimaryKeyConstraint("vault_id", "key", name="pk_rows"),
    )
    op.create_index("ix_rows_vault_id_seq", "rows", ["vault_id", "seq"], unique=True)


def downgrade() -> None:
    op.drop_table("rows")
    op.drop_table("tokens")
    op.drop_table("vaults")
    op.drop_table("server")
