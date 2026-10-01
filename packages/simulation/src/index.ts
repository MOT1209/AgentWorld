/**
 * Phase 1 simulation package.
 *
 * Owns the World's simulated time, agent needs, skills, goals, activities, the
 * deterministic decision engine, the validated action system, and the tick
 * loop. It depends on world/agents/events/memory services and never on the HTTP
 * layer, so the same engine is exercised by tests and by the API.
 */
export * from "./personality.js";
export * from "./needs.js";
export * from "./skills.js";
export * from "./goals.js";
export * from "./activities.js";
export * from "./decision.js";
export * from "./actions.js";
export * from "./clock.js";
export * from "./engine.js";
