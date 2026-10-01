import { describe, it, expect } from "vitest";
import { prisma } from "../packages/database/src/client.js";
import { Money } from "../packages/shared/src/index.js";
import { ensureWallet } from "../packages/economy/src/wallet.service.js";
import { deposit, transfer, withdraw } from "../packages/economy/src/ledger.service.js";
import { getStatement, verifyLedger } from "../packages/economy/src/statements.js";
import { SYSTEM, CORRELATION, createTestAgent } from "./helpers.js";

async function walletBalance(walletId: string): Promise<number> {
  const row = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
  return row.balanceMinor;
}

describe("finance edge cases", () => {
  it("refuses insufficient funds and never goes negative", async () => {
    const agent = await createTestAgent({ name: "Poor Agent" });
    const wallet = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: agent.id });
    const other = await createTestAgent({ name: "Rich Agent" });
    const otherWallet = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: other.id });

    await expect(
      transfer({
        fromWalletId: wallet.id,
        toWalletId: otherWallet.id,
        amount: Money.fromMinor(100, "KW"),
        description: "should fail",
        actor: SYSTEM,
        correlationId: `${CORRELATION}-insufficient`,
      }),
    ).rejects.toThrow();

    expect(await walletBalance(wallet.id)).toBe(0);
  });

  it("conserves money across transfers", async () => {
    const a = await createTestAgent({ name: "Conserve A" });
    const b = await createTestAgent({ name: "Conserve B" });
    const wa = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: a.id });
    const wb = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: b.id });

    await deposit({
      toWalletId: wa.id,
      amount: Money.fromMinor(10000, "KW"),
      description: "fund",
      actor: SYSTEM,
      correlationId: `${CORRELATION}-fund`,
    });
    const before = (await walletBalance(wa.id)) + (await walletBalance(wb.id));
    await transfer({
      fromWalletId: wa.id,
      toWalletId: wb.id,
      amount: Money.fromMinor(2500, "KW"),
      description: "move",
      actor: SYSTEM,
      correlationId: `${CORRELATION}-move`,
    });
    const after = (await walletBalance(wa.id)) + (await walletBalance(wb.id));
    expect(after).toBe(before);
  });

  it("replays idempotency keys without double-charging", async () => {
    const a = await createTestAgent({ name: "Idem A" });
    const b = await createTestAgent({ name: "Idem B" });
    const wa = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: a.id });
    const wb = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: b.id });
    await deposit({
      toWalletId: wa.id,
      amount: Money.fromMinor(5000, "KW"),
      description: "fund",
      actor: SYSTEM,
      correlationId: `${CORRELATION}-idem-fund`,
    });
    const key = `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const first = await transfer({
      fromWalletId: wa.id,
      toWalletId: wb.id,
      amount: Money.fromMinor(1000, "KW"),
      description: "idem",
      actor: SYSTEM,
      correlationId: `${CORRELATION}-idem-1`,
      idempotencyKey: key,
    });
    const second = await transfer({
      fromWalletId: wa.id,
      toWalletId: wb.id,
      amount: Money.fromMinor(1000, "KW"),
      description: "idem",
      actor: SYSTEM,
      correlationId: `${CORRELATION}-idem-2`,
      idempotencyKey: key,
    });
    expect(second.replayed).toBe(true);
    expect(second.transferGroupId).toBe(first.transferGroupId);
    expect(await walletBalance(wa.id)).toBe(4000);
  });

  it("prevents concurrent double-spend via optimistic locking", async () => {
    const a = await createTestAgent({ name: "Race A" });
    const b = await createTestAgent({ name: "Race B" });
    const c = await createTestAgent({ name: "Race C" });
    const wa = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: a.id });
    const wb = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: b.id });
    const wc = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: c.id });
    await deposit({
      toWalletId: wa.id,
      amount: Money.fromMinor(1000, "KW"),
      description: "fund",
      actor: SYSTEM,
      correlationId: `${CORRELATION}-race-fund`,
    });
    const results = await Promise.allSettled([
      transfer({ fromWalletId: wa.id, toWalletId: wb.id, amount: Money.fromMinor(800, "KW"), description: "r1", actor: SYSTEM, correlationId: `${CORRELATION}-r1` }),
      transfer({ fromWalletId: wa.id, toWalletId: wc.id, amount: Money.fromMinor(800, "KW"), description: "r2", actor: SYSTEM, correlationId: `${CORRELATION}-r2` }),
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(succeeded).toBe(1);
    expect(await walletBalance(wa.id)).toBeGreaterThanOrEqual(0);
  });

  it("keeps verifyLedger clean after a mixed sequence", async () => {
    const a = await createTestAgent({ name: "Ledger A" });
    const b = await createTestAgent({ name: "Ledger B" });
    const wa = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: a.id });
    const wb = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: b.id });
    await deposit({ toWalletId: wa.id, amount: Money.fromMinor(3000, "KW"), description: "d", actor: SYSTEM, correlationId: `${CORRELATION}-l1` });
    await transfer({ fromWalletId: wa.id, toWalletId: wb.id, amount: Money.fromMinor(1000, "KW"), description: "t", actor: SYSTEM, correlationId: `${CORRELATION}-l2` });
    await withdraw({ fromWalletId: wb.id, amount: Money.fromMinor(200, "KW"), description: "w", actor: SYSTEM, correlationId: `${CORRELATION}-l3` });
    const report = await verifyLedger(prisma, [wa.id, wb.id]);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    const statements = await getStatement(prisma, { walletId: wa.id });
    expect(statements.length).toBeGreaterThan(0);
  });

  it("rejects Transaction UPDATE and DELETE via trigger", async () => {
    const a = await createTestAgent({ name: "Immutable A" });
    const wa = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: a.id });
    await deposit({ toWalletId: wa.id, amount: Money.fromMinor(500, "KW"), description: "d", actor: SYSTEM, correlationId: `${CORRELATION}-imm` });
    const tx = await prisma.transaction.findFirstOrThrow({ where: { walletId: wa.id } });
    await expect(prisma.transaction.update({ where: { id: tx.id }, data: { description: "tampered" } })).rejects.toThrow();
    await expect(prisma.transaction.delete({ where: { id: tx.id } })).rejects.toThrow();
  });

  it("rejects same-wallet and currency-mismatch transfers", async () => {
    const a = await createTestAgent({ name: "Same Wallet" });
    const wa = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: a.id });
    await deposit({ toWalletId: wa.id, amount: Money.fromMinor(1000, "KW"), description: "d", actor: SYSTEM, correlationId: `${CORRELATION}-same` });
    await expect(
      transfer({ fromWalletId: wa.id, toWalletId: wa.id, amount: Money.fromMinor(10, "KW"), description: "self", actor: SYSTEM, correlationId: `${CORRELATION}-self` }),
    ).rejects.toThrow();

    const b = await createTestAgent({ name: "Currency B" });
    const wb = await prisma.wallet.create({
      data: { ownerType: "AGENT", ownerId: b.id, currency: "USD", balanceMinor: 0 },
    });
    await expect(
      transfer({ fromWalletId: wa.id, toWalletId: wb.id, amount: Money.fromMinor(10, "KW"), description: "x", actor: SYSTEM, correlationId: `${CORRELATION}-x` }),
    ).rejects.toThrow();
  });
});
