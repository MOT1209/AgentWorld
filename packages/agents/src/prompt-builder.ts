/**
 * Prompt construction.
 *
 * Kept separate from the runtime loop so the exact text sent to a model is one
 * readable function. When an agent behaves oddly, this is the first place to
 * look, and having it isolated means it can be asserted on in tests.
 *
 * Structure of a turn:
 *   1. system  - identity, role, hard rules, tool budget
 *   2. system  - relevant memories (injected by the runtime)
 *   3. system  - current situational context: work, place, company, money
 *   4. recent  - conversation transcript, trimmed to a budget
 *   5. user    - the trigger for this run
 */
import { Money } from "../../shared/src/index.js";
import type { DbClient } from "../../database/src/index.js";
import { getActiveTask, getTaskDetail } from "../../tasks/src/index.js";
import { getCompanyOverview } from "../../company/src/index.js";
import { getWorldSnapshot } from "../../world/src/index.js";
import { ensureWallet } from "../../economy/src/index.js";
import { getRecentMessages } from "./communication.service.js";
import type { ChatMessage } from "../../ai/src/index.js";
import type { AgentRuntimeProfile } from "./agent.service.js";

/** Transcript budget. Keeps a long thread from crowding out the instructions. */
export const MAX_CONTEXT_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 4_000;

export function buildSystemPrompt(profile: AgentRuntimeProfile): string {
  const { agent, role, personality, goals, skills } = profile;

  const sections: string[] = [];

  sections.push(
    [
      `You are ${agent.name}, ${agent.title}.`,
      `You work inside a simulated digital company and you are an autonomous agent, not a human.`,
      `Your permanent role is: ${role.displayName}.`,
      role.description,
    ].join(" "),
  );

  if (Object.keys(personality).length > 0) {
    sections.push(`Personality: ${JSON.stringify(personality)}`);
  }
  if (goals.length > 0) {
    sections.push(`Your standing goals:\n${goals.map((goal) => `- ${goal}`).join("\n")}`);
  }
  if (skills.length > 0) {
    sections.push(`Your skills:\n${skills.map((skill) => `- ${skill}`).join("\n")}`);
  }

  sections.push(`Your role instructions:\n${role.systemPromptFragments.join("\n")}`);

  sections.push(
    [
      "Rules you must not break:",
      ...role.behaviouralRules.map((rule) => `- ${rule}`),
      "- You can only affect the world by calling tools. You cannot perform actions by describing them.",
      "- If a tool reports that it needs approval, the action has NOT happened. Say so and stop.",
      "- If a tool is denied, do not attempt a workaround, and do not ask a human to bypass it.",
      "- Never invent task ids, wallet balances or results. Only report what a tool returned.",
    ].join("\n"),
  );

  if (role.allowedTools !== "*") {
    sections.push(`Tools available to you: ${role.allowedTools.join(", ")}.`);
  }

  sections.push(
    "Work through your role cycle using tools, then reply with a short plain-language summary of what you did and what you need next.",
  );

  return sections.join("\n\n");
}

export interface SituationalInput {
  profile: AgentRuntimeProfile;
  taskId?: string;
  conversationId?: string;
  userMessage?: string;
}

export async function buildTurnMessages(
  db: DbClient,
  input: SituationalInput,
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];

  const context = await buildSituationalContext(db, input);
  if (context !== "") {
    messages.push({ role: "system", content: `Current situation:\n${context}` });
  }

  if (input.conversationId !== undefined) {
    const recent = await getRecentMessages(db, input.conversationId, MAX_CONTEXT_MESSAGES);
    for (const message of recent) {
      if (message.senderType === "HUMAN" && message.senderUserId !== null) {
        messages.push({ role: "user", content: message.content });
        continue;
      }
      if (message.senderType === "AGENT" && message.senderAgentId !== null) {
        // An agent turn is context, not an instruction: framing matters, or the
        // model will treat another agent's words as a command from the owner.
        messages.push({
          role: "assistant",
          content: `[message from agent ${message.senderAgentId}]\n${message.content}`,
        });
        continue;
      }
      messages.push({ role: "system", content: `[system notice]\n${message.content}` });
    }
  }

  if (input.userMessage !== undefined) {
    messages.push({ role: "user", content: input.userMessage.slice(0, MAX_MESSAGE_CHARS) });
  }

  return messages;
}

async function buildSituationalContext(
  db: DbClient,
  input: SituationalInput,
): Promise<string> {
  const agent = input.profile.agent;
  const lines: string[] = [];

  // Current work.
  let taskId = input.taskId;
  if (taskId === undefined) {
    const active = await getActiveTask(db, agent.id);
    taskId = active?.id;
  }
  if (taskId !== undefined) {
    const detail = await getTaskDetail(db, taskId).catch(() => null);
    if (detail !== null) {
      lines.push(
        [
          `Current task #${detail.task.id}: "${detail.task.title}"`,
          `status=${detail.task.status} priority=${detail.task.priority}`,
          detail.task.description !== null ? `description: ${detail.task.description}` : null,
          detail.dependenciesSatisfied ? null : "WARNING: dependencies are not satisfied.",
          detail.task.result !== null ? `recorded result: ${detail.task.result}` : null,
          detail.task.error !== null ? `recorded error: ${detail.task.error}` : null,
        ]
          .filter((part) => part !== null)
          .join("\n  "),
      );
    }
  } else {
    lines.push("You have no task assigned to you right now.");
  }

  // Place.
  if (agent.currentLocationId !== null) {
    const snapshot = await getWorldSnapshot(db, agent.worldId ?? undefined).catch(() => null);
    if (snapshot !== null) {
      const location = snapshot.locations.find((entry) => entry.id === agent.currentLocationId);
      if (location !== undefined) {
        lines.push(
          `You are at ${location.name} (${location.kind}) in ${location.cityName}. ` +
            `It is ${snapshot.simulatedNow.slice(11, 16)} simulated time in ${snapshot.world.name} (${snapshot.phase}).`,
        );
      }
    }
  }

  // Company.
  if (agent.currentCompanyId !== null) {
    const overview = await getCompanyOverview(db, agent.currentCompanyId).catch(() => null);
    if (overview !== null) {
      const counts = Object.entries(overview.taskCounts)
        .map(([status, count]) => `${status}:${count}`)
        .join(" ");
      lines.push(
        `Company: ${overview.company.name}. ${overview.agentCount} agents, ` +
          `${overview.pendingApprovals} approvals pending. Tasks ${counts || "none"}.`,
      );
    }
  }

  // Money. An agent can always see its own balance, so it never has to guess.
  const wallet = await ensureWallet(db, { ownerType: "AGENT", ownerId: agent.id });
  lines.push(`Your wallet balance: ${Money.fromMinor(wallet.balanceMinor, wallet.currency).toString()} ${wallet.currency}.`);

  return lines.join("\n");
}
