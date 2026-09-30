/**
 * World tools: read-only inspection of the simulation.
 *
 * Neither world tool can change anything. `world.write` exists as an action
 * name in the approval policy so that Phase 2's city construction is
 * approval-gated from the moment it is written, but it has no Phase 1
 * implementation - an agent physically cannot mutate the world right now.
 */
import { z } from "zod";
import { PERMISSIONS } from "../../../security/src/permissions.js";
import { getLocationDetail, getWorldSnapshot } from "../../../world/src/index.js";
import { validationError } from "../../../shared/src/index.js";
import type { ToolDefinition } from "../types.js";

export const worldGetStateTool: ToolDefinition<Record<string, never>> = {
  name: "world.get_state",
  description:
    "Read the current state of the world: name, simulated time and time of day, cities, locations, " +
    "and which agents are present where. Read-only; use it before deciding where or when to act.",
  inputSchema: z.object({}),
  requiredPermission: PERMISSIONS.WORLD_READ,
  risk: "LOW",
  async execute(context) {
    const snapshot = await getWorldSnapshot(context.db, context.worldId);
    return {
      data: {
        world: snapshot.world.name,
        simulatedNow: snapshot.simulatedNow,
        phase: snapshot.phase,
        cities: snapshot.cities,
        locations: snapshot.locations,
        agentCount: snapshot.agentCount,
      },
      summary: `${snapshot.world.name}: ${snapshot.cities.length} cities, ${snapshot.locations.length} locations, ${snapshot.phase.toLowerCase()}`,
    };
  },
};

export const worldGetLocationTool: ToolDefinition<{ locationId?: string; locationName?: string }> = {
  name: "world.get_location",
  description:
    "Inspect a location: its kind, capacity, and which agents are currently there. " +
    "Identify it either by id or by name.",
  inputSchema: z.object({
    locationId: z.string().optional(),
    locationName: z.string().max(120).optional(),
  }),
  requiredPermission: PERMISSIONS.WORLD_READ,
  risk: "LOW",
  async execute(context, input) {
    let locationId = input.locationId;

    if (locationId === undefined && input.locationName !== undefined) {
      const snapshot = await getWorldSnapshot(context.db, context.worldId);
      const match = snapshot.locations.find(
        (location) => location.name.toLowerCase() === input.locationName?.toLowerCase(),
      );
      if (match === undefined) {
        throw validationError(`No location named '${input.locationName}'`, {
          available: snapshot.locations.map((location) => location.name),
        });
      }
      locationId = match.id;
    }

    if (locationId === undefined) {
      throw validationError("Provide either locationId or locationName");
    }

    const detail = await getLocationDetail(context.db, locationId);
    return {
      data: {
        id: detail.location.id,
        name: detail.location.name,
        kind: detail.location.kind,
        address: detail.location.address,
        capacity: detail.location.capacity,
        city: detail.city.name,
        occupants: detail.occupants.map((agent) => ({ id: agent.id, name: agent.name, title: agent.title })),
      },
      summary: `${detail.location.name} (${detail.location.kind}) in ${detail.city.name}: ${detail.occupants.length} present`,
    };
  },
};

export const worldTools = [worldGetStateTool, worldGetLocationTool];
