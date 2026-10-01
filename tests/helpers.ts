import { prisma } from "../packages/database/src/client.js";
import { resetConfigCache, Money, slugify } from "../packages/shared/src/index.js";
import { hashPassword } from "../packages/security/src/password.js";
import { ensureWallet } from "../packages/economy/src/wallet.service.js";
import { actorSystem } from "../packages/shared/src/actor.js";

resetConfigCache();

export const SYSTEM = actorSystem("tests");
export const CORRELATION = "test-correlation";

let counter = 0;
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export async function createTestUser(email?: string): Promise<{ id: string; email: string }> {
  const address = (email ?? unique("user@test.local")).toLowerCase();
  const user = await prisma.user.create({
    data: {
      email: address,
      passwordHash: hashPassword("TestPassword123", 10),
      displayName: "Test Owner",
      role: "OWNER",
      isActive: true,
    },
  });
  await ensureWallet(prisma, { ownerType: "USER", ownerId: user.id });
  return { id: user.id, email: user.email };
}

export async function createTestAgent(input?: {
  name?: string;
  roleKey?: string;
  companyId?: string | null;
  worldId?: string | null;
}): Promise<{ id: string; name: string }> {
  const name = input?.name ?? unique("Agent");
  const agent = await prisma.agent.create({
    data: {
      name,
      slug: `${slugify(name)}-${counter}`,
      roleKey: input?.roleKey ?? "EXECUTOR",
      title: "Test Agent",
      systemPrompt: "Test prompt",
      personality: JSON.stringify({}),
      goals: JSON.stringify([]),
      skills: JSON.stringify([]),
      capabilities: JSON.stringify([]),
      providerId: "mock",
      model: "mock-1",
      worldId: input?.worldId ?? null,
      currentCompanyId: input?.companyId ?? null,
    },
  });
  await prisma.agentState.create({ data: { agentId: agent.id, state: "IDLE" } });
  await ensureWallet(prisma, { ownerType: "AGENT", ownerId: agent.id });
  return { id: agent.id, name: agent.name };
}

export async function fundAgentWallet(agentId: string, minor: number): Promise<string> {
  const wallet = await ensureWallet(prisma, { ownerType: "AGENT", ownerId: agentId });
  const { deposit } = await import("../packages/economy/src/ledger.service.js");
  await deposit({
    toWalletId: wallet.id,
    amount: Money.fromMinor(minor, "KW"),
    description: "test funding",
    actor: SYSTEM,
    correlationId: `${CORRELATION}-${counter}`,
  });
  return wallet.id;
}
