-- Phase 3, M2: idempotent execution creation.
-- A caller-supplied key makes a retried create return the original job instead of a duplicate.
ALTER TABLE "ExecutionJob" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "ExecutionJob_idempotencyKey_key" ON "ExecutionJob"("idempotencyKey");
