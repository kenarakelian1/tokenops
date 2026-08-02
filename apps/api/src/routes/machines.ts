import { Hono } from "hono";
import { requireUser } from "../auth/middleware.js";
import type { Machine } from "../db/schema.js";
import type { EventsRepo } from "../services/events-repo.js";

export type MachinesRouteVariables = {
  eventsRepo: EventsRepo;
  userId: string;
};

function machineToDto(row: Machine) {
  return {
    machineId: row.machineId,
    name: row.name,
    lastSeenAt: row.lastSeenAt.toISOString(),
    lastQueueDepth: row.lastQueueDepth,
  };
}

export const machinesRoutes = new Hono<{ Variables: MachinesRouteVariables }>();

/** Dashboard: list machines for the user. */
machinesRoutes.get("/", requireUser, async (c) => {
  const repo = c.get("eventsRepo");
  const userId = c.get("userId");
  const rows = await repo.listMachines(userId);
  return c.json({ machines: rows.map(machineToDto) });
});
