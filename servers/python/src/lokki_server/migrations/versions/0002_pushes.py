"""
Marks of pushes: the vaults' latest mark and count of pushes, and the pushes table.

A vault that has rows already gets one push covering all of them, with a new mark. Devices that
synced with it before don't know that mark, so each pulls everything once.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-10
"""

import secrets
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "vaults",
        sa.Column("mark", sa.String(32), nullable=True),
    )
    op.add_column(
        "vaults",
        sa.Column("pushes", sa.BigInteger(), nullable=False, server_default="0"),
    )
    pushes = op.create_table(
        "pushes",
        sa.Column("vault_id", sa.Integer(), nullable=False),
        sa.Column("number", sa.BigInteger(), nullable=False),
        sa.Column("base", sa.BigInteger(), nullable=False),
        sa.Column("head", sa.BigInteger(), nullable=False),
        sa.Column("mark", sa.String(32), nullable=False),
        sa.ForeignKeyConstraint(["vault_id"], ["vaults.id"], name="fk_pushes_vault_id_vaults"),
        sa.PrimaryKeyConstraint("vault_id", "number", name="pk_pushes"),
    )
    op.create_index("ix_pushes_vault_id_head", "pushes", ["vault_id", "head"], unique=True)

    vaults = sa.table(
        "vaults",
        sa.column("id", sa.Integer()),
        sa.column("head", sa.BigInteger()),
        sa.column("mark", sa.String(32)),
        sa.column("pushes", sa.BigInteger()),
    )
    connection = op.get_bind()
    for vault_id, head in connection.execute(
        sa.select(vaults.c.id, vaults.c.head).where(vaults.c.head > 0)
    ).all():
        mark = secrets.token_urlsafe(12)
        connection.execute(
            sa.insert(pushes).values(vault_id=vault_id, number=1, base=0, head=head, mark=mark)
        )
        connection.execute(
            sa.update(vaults).where(vaults.c.id == vault_id).values(mark=mark, pushes=1)
        )


def downgrade() -> None:
    op.drop_table("pushes")
    op.drop_column("vaults", "pushes")
    op.drop_column("vaults", "mark")
