/**
 * Economy tools: read a balance, move money.
 *
 * `wallet.transfer` is the only tool in the system an agent can use to affect
 * money, and it is deliberately awkward:
 *
 *  - Its approval policy escalates on AMOUNT, so routine small payments run
 *    unattended while anything at or above the configured threshold stops for a
 *    human. That is the behaviour the specification asks for: expensive or
 *    irreversible actions require explicit approval.
 *  - It accepts an idempotency key, so a retry after a timeout cannot double
 *    charge.
 *  - It resolves the counterparty from an AGENT ID or an OWNER address only.
 *    There is no "raw wallet id" argument, so an agent cannot be steered by a
 *    prompt into moving funds to an account it was handed.
 */
import { z } from "zod";
import { Money, validationError } from "../../../shared/src/index.js";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import { ensureWallet, getStatement, transfer } from "../../../economy/src/index.js";
import { requiresHumanApproval } from "../../../approvals/src/index.js";
import type { ToolDefinition } from "../types.js";

export const walletBalanceTool: ToolDefinition<{ agentId?: string }> = {
  name: "wallet.balance",
  description:
    "Read a wallet balance. With no argument, returns your own balance. " +
    "You may only read the owner's balance in addition to your own.",
  inputSchema: z.object({
    agentId: z.string().optional().describe("Another agent. Only the company owner may be inspected."),
  }),
  requiredPermission: PERMISSIONS.WALLET_READ,
  risk: "LOW",
  async execute(context, input) {
    const targets = resolveReadableWallets(context, input.agentId);
    const balances = [];
    for (const target of targets) {
      const wallet = await ensureWallet(context.db, {
        ownerType: target.ownerType,
        ownerId: target.ownerId,
      });
      balances.push({
        ownerType: wallet.ownerType,
        ownerId: wallet.ownerId,
        ownerName: target.name,
        balance: Money.fromMinor(wallet.balanceMinor, wallet.currency).toString(),
        currency: wallet.currency,
      });
    }
    return {
      data: { balances },
      summary: balances
        .map((balance) => `${balance.ownerName ?? balance.ownerId}: ${balance.balance} ${balance.currency}`)
        .join("; "),
    };
  },
};

export const walletTransferTool: ToolDefinition<{
  toAgentId?: string;
  toOwner?: boolean;
  amount: string;
  description?: string;
  idempotencyKey?: string;
}> = {
  name: "wallet.transfer",
  description:
    "Transfer virtual currency to another agent, or to the company owner. " +
    "Amounts are decimal strings in major units, for example '250.00'. " +
    "Transfers at or above the company's configured approval threshold are withheld " +
    "until a human approves them; if that happens the transfer has NOT occurred and you must report it. " +
    "Always pass an idempotencyKey so a retry cannot pay twice.",
  inputSchema: z.object({
    toAgentId: z.string().optional().describe("Recipient agent id"),
    toOwner: z
      .boolean()
      .default(false)
      .describe("Send to the human owner instead of an agent"),
    amount: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, "Amount must be a positive decimal, e.g. '250.00'")
      .describe("Amount in major units"),
    description: z.string().max(300).optional().describe("Why this payment is being made"),
    idempotencyKey: z
      .string()
      .max(120)
      .optional()
      .describe("Unique key for this payment. Reusing it makes the call a no-op"),
  }),
  requiredPermission: PERMISSIONS.WALLET_TRANSFER,
  risk: "MEDIUM",
  approvalPolicy: (input, context) => {
    if (context.isApprovalReplay === true) return null;
    const amount = parseAmount(input.amount);
    return requiresHumanApproval("wallet.transfer", { amountMinor: amount.minor });
  },
  async execute(context, input) {
    const agentId = context.agentId;
    if (agentId === undefined) throw validationError("wallet.transfer requires an agent");

    const amount = parseAmount(input.amount);
    const from = await ensureWallet(context.db, { ownerType: "AGENT", ownerId: agentId });

    const to = input.toOwner === true
      ? await ensureWallet(context.db, {
          ownerType: "USER",
          ownerId: context.actor.actorId ?? (await resolveOwnerId(context)),
        })
      : await ensureWallet(context.db, {
          ownerType: "AGENT",
          ownerId: requireString(input.toAgentId, "toAgentId is required unless toOwner is true"),
        });

    const result = await transfer({
      fromWalletId: from.id,
      toWalletId: to.id,
      amount,
      description: input.description ?? `Transfer from agent ${agentId}`,
      actor: context.actor,
      correlationId: context.correlationId,
      client: context.db,
      ...(context.approvalRequestId !== undefined
        ? { approvalRequestId: context.approvalRequestId }
        : {}),
      ...(input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
    });

    return {
      data: {
        transferGroupId: result.transferGroupId,
        amount: amount.toString(),
        currency: amount.currency,
        fromBalance: result.fromBalanceAfter.toString(),
        toBalance: result.toBalanceAfter.toString(),
        replayed: result.replayed,
      },
      summary: result.replayed
        ? `Transfer of ${amount.toString()} was already recorded; no money moved again`
        : `Transferred ${amount.toString()} ${amount.currency}`,
    };
  },
};

export const walletStatementTool: ToolDefinition<{ limit?: number }> = {
  name: "wallet.statement",
  description:
    "Read your own recent wallet activity, with a running balance after each entry. " +
    "Use this to check a balance or confirm that a payment you made actually landed.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).default(20),
  }),
  requiredPermission: PERMISSIONS.TRANSACTION_READ,
  risk: "LOW",
  async execute(context, input) {
    const agentId = context.agentId;
    if (agentId === undefined) throw validationError("wallet.statement requires an agent");

    const statements = await getStatement(context.db, {
      ownerType: "AGENT",
      ownerId: agentId,
      limit: input.limit,
    });
    const statement = statements[0];
    if (statement === undefined) return { data: { entries: [] }, summary: "No transactions yet" };

    return {
      data: {
        balance: Money.fromMinor(statement.closingBalanceMinor, statement.currency).toString(),
        currency: statement.currency,
        entries: statement.entries.map((entry) => ({
          type: entry.type,
          direction: entry.direction,
          amountMinor: entry.amountMinor,
          balanceAfter: Money.fromMinor(entry.balanceAfterMinor, entry.currency).toString(),
          description: entry.description,
          createdAt: entry.createdAt,
        })),
      },
      summary: `Balance ${Money.fromMinor(statement.closingBalanceMinor, statement.currency).toString()} ${statement.currency}`,
    };
  },
};

// -- helpers -----------------------------------------------------------------

function parseAmount(raw: string): Money {
  const value = Money.fromMajor(raw);
  if (!value.isPositive) throw validationError("Transfer amount must be greater than zero");
  return value;
}

function requireString(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === "") throw validationError(message);
  return value;
}

async function resolveOwnerId(context: { db: { user: { findFirst(args: unknown): Promise<{ id: string } | null> } } }): Promise<string> {
  const owner = await context.db.user.findFirst({
    where: { role: "OWNER" },
    orderBy: { createdAt: "asc" },
  });
  if (owner === null) throw validationError("No company owner is configured");
  return owner.id;
}

interface ReadableWallet {
  ownerType: "AGENT" | "USER";
  ownerId: string;
  name: string | null;
}

/**
 * An agent may read its own balance and the owner's. Reading an arbitrary
 * third party's balance would leak the state of a peer for no operational
 * benefit, so it is refused here rather than trusted to the caller.
 */
function resolveReadableWallets(
  context: { agentId?: string; actor: { actorType: string } },
  requestedAgentId: string | undefined,
): ReadableWallet[] {
  const self: ReadableWallet[] =
    context.agentId !== undefined
      ? [{ ownerType: "AGENT", ownerId: context.agentId, name: "you" }]
      : [];

  if (requestedAgentId !== undefined) {
    if (context.actor.actorType !== "USER") {
      throw validationError("Only the company owner may inspect another agent's balance");
    }
    return [{ ownerType: "AGENT", ownerId: requestedAgentId, name: requestedAgentId }];
  }

  if (context.actor.actorType === "USER" && context.actor.actorType !== undefined) {
    const actorId = (context.actor as { actorId?: string }).actorId;
    if (actorId !== undefined) {
      self.push({ ownerType: "USER", ownerId: actorId, name: "you (owner)" });
    }
  }

  if (self.length === 0) {
    throw validationError("No wallet could be resolved for this caller");
  }
  return self;
}

export const economyTools = [walletBalanceTool, walletTransferTool, walletStatementTool];
