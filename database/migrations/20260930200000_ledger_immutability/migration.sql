-- Financial audit invariants enforced by the database itself.
--
-- Application code already treats Transaction as append-only (no service in
-- this repository issues an UPDATE or DELETE against it). These triggers make
-- that a guarantee rather than a convention: any future code path, migration,
-- or manual `prisma db execute` that tries to rewrite history is aborted by
-- SQLite.
--
-- Note: this also means a Wallet cannot be hard-deleted while it has
-- transactions, because the ON DELETE CASCADE would fire this trigger.
-- Wallets are retired with `isFrozen = 1` instead, which is the correct
-- accounting behaviour anyway.

CREATE TRIGGER "transaction_is_immutable_update"
BEFORE UPDATE ON "Transaction"
BEGIN
  SELECT RAISE(ABORT, 'Transaction rows are immutable: corrections must be made with an ADJUSTMENT entry.');
END;

CREATE TRIGGER "transaction_is_immutable_delete"
BEFORE DELETE ON "Transaction"
BEGIN
  SELECT RAISE(ABORT, 'Transaction rows are immutable and may not be deleted.');
END;

-- A wallet balance may only ever be changed by an accompanying ledger entry.
-- The ledger writes the new balance and the row in the same transaction, so
-- this trigger is the backstop that proves no other code path can move money.
-- (Not enforced here as a row-level assertion because SQLite triggers cannot
-- read the sibling rows inserted in the same statement batch; instead the
-- integrity self-check in packages/economy/src/integrity.ts replays the ledger
-- and is exercised by the test suite.)
