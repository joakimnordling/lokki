"""
The storage interface on Google Cloud Firestore (Native mode), for LOKKI_DATABASE_URL=firestore://...

Collections, their names prefixed with `lokki_` unless the URL says otherwise (each conditional
write is one transaction, as the protocol needs):

    lokki_server/id                {value}: the server's ID
    lokki_names/{vault name}       {vault}: which vault document has this name; keeps names unique
    lokki_vaults/{vault id}        {name, head, mark, pushes, keyring, keyring_vault_id,
                                    keyring_version, created, changed}
        rows/r{key}                {seq, data}; the "r" keeps a row key from looking like one of
                                   Firestore's reserved IDs (__...__)
        pushes/p{number}           {base, head, mark}: the latest pushes (protocol 7.4)
        labels/{sha256 of label}   {token}: keeps a vault's token labels unique, whatever their text
    lokki_tokens/{sha256 of token} {vault, label, scope, created, last_used}

The prefix keeps the server's collections apart from anything else in the same database: the free
quota covers only one database per project.

The server signs in with Google's default credentials: on Cloud Run, its service account; on your
own machine, `gcloud auth application-default login`. With FIRESTORE_EMULATOR_HOST set, the client
uses the emulator instead.
"""

import hashlib
import re
import uuid
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from google.cloud.firestore import (
    AsyncClient,
    FieldFilter,
    async_transactional,
)

from lokki_server.models import Scope
from lokki_server.storage.base import (
    NameTaken,
    Outcome,
    PullResult,
    Row,
    Token,
    TokenId,
    TokenSummary,
    VaultId,
    VaultStatus,
    VaultSummary,
    WriteResult,
)

type Doc = dict[str, Any]

_ATTEMPTS = 25


DEFAULT_PREFIX = "lokki_"
_PREFIX = re.compile(r"[A-Za-z0-9_-]{0,32}")


def parse_url(url: str) -> tuple[str, str, str]:
    """
    The project, database and collection prefix of firestore://PROJECT[/DATABASE][?prefix=PREFIX].

    The database defaults to "(default)", the one Firestore's free quota covers, and the prefix to
    "lokki_"; `?prefix=` turns it off.
    """
    parts = urlsplit(url)
    if parts.scheme != "firestore" or not parts.netloc:
        raise ValueError(f"{url!r} isn't a Firestore URL, e.g. firestore://my-project.")
    query = dict(
        parse_qsl(
            parts.query,
            keep_blank_values=True,
        )
    )
    prefix = query.pop("prefix", DEFAULT_PREFIX)
    if query or not _PREFIX.fullmatch(prefix):
        raise ValueError(
            f"{url!r}: the only setting is a prefix of up to 32 letters, digits, _ and -, "
            "e.g. firestore://my-project?prefix=lokki_."
        )
    return parts.netloc, parts.path.strip("/") or "(default)", prefix


def _label_id(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()


class FirestoreStorage:
    """The storage interface on Firestore."""

    def __init__(self, url: str) -> None:
        project, database, self.prefix = parse_url(url)
        # Any: the client library's own type hints are partly incomplete (unknown types in
        # references, queries and transactions), which strict type checking can't work with
        self.client: Any = AsyncClient(
            project=project,
            database=database,
        )

    def _collection(self, name: str) -> Any:
        """One of the server's own top-level collections, with the prefix."""
        return self.client.collection(self.prefix + name)

    async def close(self) -> None:
        self.client.close()

    def _transaction(self) -> Any:
        # Contending transactions are retried; each retry sees what the winner wrote (e.g. a new
        # head, so the others answer BEHIND). Enough tries for many devices writing at once.
        return self.client.transaction(max_attempts=_ATTEMPTS)

    def _vault(self, vault_id: VaultId) -> Any:
        return self._collection("vaults").document(str(vault_id))

    async def server_id(self) -> str:
        ref = self._collection("server").document("id")

        @async_transactional
        async def made_once(transaction: Any) -> str:
            found = await ref.get(transaction=transaction)
            if found.exists:
                return str(_data(found)["value"])
            value = str(uuid.uuid4())
            transaction.create(ref, {"value": value})
            return value

        return await made_once(self._transaction())

    # vaults and tokens

    async def create_vault(self, name: str, now: int) -> VaultId:
        name_ref = self._collection("names").document(name)
        vault_ref = self._collection("vaults").document()

        @async_transactional
        async def create(transaction: Any) -> VaultId:
            if (await name_ref.get(transaction=transaction)).exists:
                raise NameTaken(name)
            transaction.create(name_ref, {"vault": vault_ref.id})
            transaction.create(
                vault_ref,
                {
                    "name": name,
                    "head": 0,
                    "mark": None,
                    "pushes": 0,
                    "keyring": None,
                    "keyring_vault_id": None,
                    "keyring_version": 0,
                    "created": now,
                    "changed": now,
                },
            )
            return vault_ref.id

        return await create(self._transaction())

    async def find_vault(self, name: str) -> VaultId | None:
        found = await self._collection("names").document(name).get()
        return str(_data(found)["vault"]) if found.exists else None

    async def add_token(
        self,
        vault_id: VaultId,
        label: str,
        token_hash: str,
        scope: Scope,
        now: int,
    ) -> None:
        label_ref = self._vault(vault_id).collection("labels").document(_label_id(label))
        token_ref = self._collection("tokens").document(token_hash)

        @async_transactional
        async def add(transaction: Any) -> None:
            if (await label_ref.get(transaction=transaction)).exists:
                raise NameTaken(label)
            transaction.create(label_ref, {"token": token_hash})
            transaction.create(
                token_ref,
                {
                    "vault": str(vault_id),
                    "label": label,
                    "scope": str(scope),
                    "created": now,
                    "last_used": None,
                },
            )

        await add(self._transaction())

    async def find_token(self, token_hash: str) -> Token | None:
        found = await self._collection("tokens").document(token_hash).get()
        if not found.exists:
            return None
        doc = _data(found)
        return Token(
            token_id=token_hash,
            vault_id=str(doc["vault"]),
            scope=Scope(doc["scope"]),
            last_used=doc.get("last_used"),
        )

    async def touch_token(self, token_id: TokenId, now: int) -> None:
        await self._collection("tokens").document(str(token_id)).update({"last_used": now})

    async def revoke_token(self, vault_id: VaultId, label: str) -> bool:
        label_ref = self._vault(vault_id).collection("labels").document(_label_id(label))

        @async_transactional
        async def revoke(transaction: Any) -> bool:
            found = await label_ref.get(transaction=transaction)
            if not found.exists:
                return False
            transaction.delete(self._collection("tokens").document(_data(found)["token"]))
            transaction.delete(label_ref)
            return True

        return await revoke(self._transaction())

    async def list_vaults(self) -> list[VaultSummary]:
        found: list[VaultSummary] = []
        async for vault in self._collection("vaults").stream():
            doc = _data(vault)
            found.append(
                VaultSummary(
                    name=doc["name"],
                    head=doc["head"],
                    rows=await _count(vault.reference.collection("rows")),
                    tokens=await _count(
                        self._collection("tokens").where(
                            filter=FieldFilter(
                                "vault",
                                "==",
                                vault.id,
                            )
                        )
                    ),
                    created=doc["created"],
                )
            )
        return sorted(
            found,
            key=lambda v: v.name,
        )

    async def list_tokens(self, vault_id: VaultId) -> list[TokenSummary]:
        query = self._collection("tokens").where(
            filter=FieldFilter(
                "vault",
                "==",
                str(vault_id),
            )
        )
        found = [_data(t) async for t in query.stream()]
        # sorted here: ordering in the query would need a composite index
        return [
            TokenSummary(
                label=t["label"],
                scope=Scope(t["scope"]),
                created=t["created"],
                last_used=t.get("last_used"),
            )
            for t in sorted(
                found,
                key=lambda t: (t["created"], t["label"]),
            )
        ]

    async def delete_vault(self, vault_id: VaultId) -> bool:
        vault_ref = self._vault(vault_id)
        found = await vault_ref.get()
        if not found.exists:
            return False
        # Tokens first, so nobody can use the vault while the rest goes
        tokens = self._collection("tokens").where(
            filter=FieldFilter(
                "vault",
                "==",
                str(vault_id),
            )
        )
        async for token in tokens.stream():
            await token.reference.delete()

        # The vault document next, in a transaction: a push or keyring write that passed its token
        # check just before can no longer write into the vault, as it finds no vault document
        @async_transactional
        async def remove(transaction: Any) -> None:
            await vault_ref.get(transaction=transaction)
            transaction.delete(self._collection("names").document(_data(found)["name"]))
            transaction.delete(vault_ref)

        await remove(self._transaction())
        await self.client.recursive_delete(vault_ref)  # its rows, pushes and labels
        return True

    # the vault

    async def vault(self, vault_id: VaultId) -> VaultStatus:
        vault_ref = self._vault(vault_id)
        doc = _data(await vault_ref.get())
        return VaultStatus(
            keyring=doc["keyring"],
            keyring_version=doc["keyring_version"],
            head=doc["head"],
            mark=doc.get("mark"),
            rows=await _count(vault_ref.collection("rows")),
            changed=doc["changed"],
        )

    async def put_keyring(
        self,
        vault_id: VaultId,
        base: int,
        keyring: str,
        keyring_vault_id: str,
        now: int,
    ) -> WriteResult:
        vault_ref = self._vault(vault_id)

        @async_transactional
        async def put(transaction: Any) -> WriteResult:
            doc = _data(await vault_ref.get(transaction=transaction))
            version = doc["keyring_version"]
            if doc["keyring_vault_id"] not in (None, keyring_vault_id):
                return WriteResult(Outcome.DIFFERENT_VAULT, version)
            if version != base:
                return WriteResult(Outcome.BEHIND, version)
            transaction.update(
                vault_ref,
                {
                    "keyring": keyring,
                    "keyring_vault_id": keyring_vault_id,
                    "keyring_version": version + 1,
                    "changed": now,
                },
            )
            return WriteResult(Outcome.OK, version + 1)

        return await put(self._transaction())

    async def pull(
        self,
        vault_id: VaultId,
        since: int,
        limit: int,
        at: int | None = None,
    ) -> PullResult:
        vault_ref = self._vault(vault_id)

        # A read-only transaction: every read sees the database as it was at one moment
        @async_transactional
        async def pull(transaction: Any) -> PullResult:
            vault = _data(await vault_ref.get(transaction=transaction))
            head: int = vault["head"]
            query = (
                vault_ref.collection("rows")
                .where(
                    filter=FieldFilter(
                        "seq",
                        ">",
                        since,
                    )
                )
                .where(
                    filter=FieldFilter(
                        "seq",
                        "<=",
                        head,
                    )
                )
                .order_by("seq")
                .limit(limit + 1)
            )
            found = [
                Row(
                    key=row.id[1:],
                    seq=_data(row)["seq"],
                    data=_data(row)["data"],
                )
                async for row in await transaction.get(query)
            ]
            more = len(found) > limit
            page = found[:limit]
            cursor = page[-1].seq if more else head

            async def mark_at(seq: int) -> str | None:
                """The mark of the push that wrote row `seq`; the head's is in the vault."""
                if seq == head:
                    return vault.get("mark")  # .get(): vaults made before marks have none
                if seq == 0 or seq > head:
                    return None
                return await self._find_mark(vault_ref, seq, transaction)

            return PullResult(
                rows=page,
                cursor=cursor,
                more=more,
                head=head,
                at_mark=None if at is None else await mark_at(at),
                mark=await mark_at(cursor),
            )

        return await pull(self.client.transaction(read_only=True))

    @staticmethod
    async def _find_mark(vault_ref: Any, seq: int, transaction: Any) -> str | None:
        """The mark of the push that wrote row number `seq`, if it's remembered."""
        query = (
            vault_ref.collection("pushes")
            .where(
                filter=FieldFilter(
                    "head",
                    ">=",
                    seq,
                )
            )
            .order_by("head")
            .limit(1)
        )
        found = [_data(p) async for p in await transaction.get(query)]
        return found[0]["mark"] if found and found[0]["base"] < seq else None

    async def push(
        self,
        vault_id: VaultId,
        base: int,
        base_mark: str | None,
        new_rows: list[tuple[str, str]],
        new_mark: str,
        history: int,
        now: int,
    ) -> WriteResult:
        vault_ref = self._vault(vault_id)
        rows = vault_ref.collection("rows")
        pushes = vault_ref.collection("pushes")
        head = base + len(new_rows)

        @async_transactional
        async def push(transaction: Any) -> WriteResult:
            vault = _data(await vault_ref.get(transaction=transaction))
            # .get(): vaults made before marks existed have neither field
            if vault["head"] != base or vault.get("mark") != base_mark:
                return WriteResult(Outcome.BEHIND, vault["head"])
            number = vault.get("pushes", 0) + 1
            # Pushes to forget: normally one; a smaller `history` setting trims the rest over
            # the next pushes, as a transaction can only write so much.
            forget = pushes.where(
                filter=FieldFilter(
                    "number",
                    "<=",
                    number - history,
                )
            ).limit(100)
            old = [p.reference async for p in await transaction.get(forget)]
            for seq, (key, data) in enumerate(
                new_rows,
                start=base + 1,
            ):
                transaction.set(rows.document(f"r{key}"), {"seq": seq, "data": data})
            transaction.create(
                pushes.document(f"p{number}"),
                {"number": number, "base": base, "head": head, "mark": new_mark},
            )
            for ref in old:
                transaction.delete(ref)
            transaction.update(
                vault_ref,
                {"head": head, "mark": new_mark, "pushes": number, "changed": now},
            )
            return WriteResult(Outcome.OK, head, new_mark)

        return await push(self._transaction())


def _data(snapshot: Any) -> Doc:
    data: Doc | None = snapshot.to_dict()
    if data is None:
        raise LookupError(f"{snapshot.reference.path} doesn't exist")
    return data


async def _count(query: Any) -> int:
    """How many documents match, counted by Firestore (one read per 1,000 documents)."""
    result = await query.count().get()
    return int(result[0][0].value)
