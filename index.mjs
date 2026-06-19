#!/usr/bin/env node
/**
 * AMPERA Mission Control — MCP server (stdio).
 *
 * Thin wrapper over the Mission Control REST API (/api/v1) so Claude (Cowork /
 * Claude Code / Desktop) can read and write strategic org state — tasks,
 * initiatives, procurements, decisions — plus the per-user "shared brain"
 * state that replaces Cowork's local files (scan watermark, today focus,
 * pending-review queue, people/project/glossary lookups).
 *
 * Mission Control is a database + API + UI + MCP server, nothing more: it does
 * NOT call any LLM. This server just hands structured data to the user's Cowork,
 * which does the reasoning. (See REQUIREMENTS.md §2, §6.9, §10.)
 *
 * Config via env:
 *   MISSION_CONTROL_URL      e.g. https://missioncontrol.amperaglobal.com
 *   MISSION_CONTROL_API_KEY  per-user API key (amc_…) from
 *                            Settings → AI Assistant → Claude Cowork
 *
 * The API key determines identity and permissions: writes are attributed to the
 * key's owner, and role/scopes are enforced server-side (see REQUIREMENTS.md §4,
 * §6.1, §6.4). Revoking the key invalidates all subsequent calls.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// SDK ^1.29 surface used below (confirmed in node_modules .d.ts):
//   server.registerTool(name, { title, description, inputSchema }, cb)
//   server.registerResource(name, uriString, { title, description, mimeType }, cb)
//        → cb returns { contents: [{ uri, mimeType, text }] }
//   server.registerPrompt(name, { title, description, argsSchema }, cb)
//        → cb returns { messages: [{ role, content: { type:"text", text } }] }

const BASE = (process.env.MISSION_CONTROL_URL ?? "").replace(/\/$/, "");
const API_KEY = process.env.MISSION_CONTROL_API_KEY ?? "";
if (!BASE || !API_KEY) {
  console.error("MISSION_CONTROL_URL and MISSION_CONTROL_API_KEY env vars are required");
  process.exit(1);
}

/**
 * mcRequest — one HTTP call against the Mission Control REST API.
 *
 * Sends the bearer API key (and Content-Type for bodies), parses the JSON
 * response, and on a non-2xx surfaces the API's `{ error }` body as a thrown
 * Error so it becomes the MCP tool's error text. Mirrors the ServiceDesk MCP.
 */
async function mcRequest(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw: raw.slice(0, 500) };
  }
  if (!res.ok) {
    const msg = data?.error ?? `HTTP ${res.status}`;
    throw new Error(`Mission Control API error (${res.status}): ${msg}`);
  }
  return data;
}

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

const server = new McpServer({ name: "ampera-mission-control", version: "0.1.0" });

// ─── Dashboard ───────────────────────────────────────────────────────────────

server.registerTool(
  "get_dashboard_summary",
  {
    title: "Get the caller's dashboard summary",
    description:
      "Return the calling user's role-specific dashboard data (KPI tiles, widgets) as structured JSON. The shape varies by role; the user's Cowork composes any prose locally.",
    inputSchema: {},
  },
  async () => text(await mcRequest("GET", "/dashboard/summary")),
);

server.registerTool(
  "get_briefing_data",
  {
    title: "Get briefing data",
    description:
      "Return the calling user's role-specific structured briefing payload (the raw data behind weekly/periodic briefings: decisions made, risks, procurement movement, tasks completed, top-of-mind). The caller's Cowork composes the prose. Optionally widen/narrow the lookback window with periodDays.",
    inputSchema: {
      periodDays: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Lookback window in days, e.g. 7 for a weekly briefing (optional)"),
    },
  },
  async (args) => {
    const p = new URLSearchParams();
    if (args.periodDays !== undefined) p.set("periodDays", String(args.periodDays));
    const qs = p.toString();
    return text(await mcRequest("GET", `/briefing${qs ? `?${qs}` : ""}`));
  },
);

// ─── Tasks ───────────────────────────────────────────────────────────────────

server.registerTool(
  "list_tasks",
  {
    title: "List tasks",
    description:
      "List tasks. Defaults to the caller's own tasks; admin/lead callers can widen with mine=false. Optionally filter by status.",
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe("Filter by task status, e.g. 'open', 'in_progress', 'done'"),
      mine: z
        .boolean()
        .optional()
        .describe("true (default) = only the caller's tasks; false = all visible tasks (admin/lead)"),
    },
  },
  async (args) => {
    const p = new URLSearchParams();
    if (args.status) p.set("status", args.status);
    if (args.mine !== undefined) p.set("mine", String(args.mine));
    const qs = p.toString();
    return text(await mcRequest("GET", `/tasks${qs ? `?${qs}` : ""}`));
  },
);

server.registerTool(
  "get_task",
  {
    title: "Get task details",
    description: "Fetch full detail on one task by id.",
    inputSchema: { id: z.string().describe("Task id") },
  },
  async (args) => text(await mcRequest("GET", `/tasks/${encodeURIComponent(args.id)}`)),
);

server.registerTool(
  "create_task",
  {
    title: "Create a task",
    description:
      "Create a new task, auto-attributed to the API key's owner. Optionally link it to a project and set a due date. Returns the new task id, url, and a confirmation message.",
    inputSchema: {
      title: z.string().min(1).describe("Short task title"),
      description: z.string().optional().describe("Full task description (optional)"),
      projectId: z.string().optional().describe("Id of the project to link this task to (optional)"),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Due date, YYYY-MM-DD (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", "/tasks", {
        title: args.title,
        description: args.description,
        projectId: args.projectId,
        dueDate: args.dueDate,
      }),
    ),
);

server.registerTool(
  "update_task",
  {
    title: "Update a task",
    description:
      "Modify a task. Callers can update their own tasks; lead+ can update their team's; admin can update any. Only the provided fields change. Returns the task id, url, and a confirmation message.",
    inputSchema: {
      id: z.string().describe("Task id"),
      title: z.string().min(1).optional().describe("New title (optional)"),
      description: z.string().optional().describe("New description (optional)"),
      status: z.string().optional().describe("New status, e.g. 'open', 'in_progress', 'done' (optional)"),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("New due date, YYYY-MM-DD (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("PATCH", `/tasks/${encodeURIComponent(args.id)}`, {
        title: args.title,
        description: args.description,
        status: args.status,
        dueDate: args.dueDate,
      }),
    ),
);

server.registerTool(
  "complete_task",
  {
    title: "Complete a task",
    description: "Mark a task as done. Returns the task id, url, and a confirmation message.",
    inputSchema: { id: z.string().describe("Task id") },
  },
  async (args) => text(await mcRequest("POST", `/tasks/${encodeURIComponent(args.id)}/complete`)),
);

// ─── Initiatives ───────────────────────────────────────────────────────────────

server.registerTool(
  "list_initiatives",
  {
    title: "List initiatives",
    description: "List strategic initiatives. Optionally filter by status.",
    inputSchema: {
      status: z.string().optional().describe("Filter by initiative status (optional)"),
    },
  },
  async (args) => {
    const p = new URLSearchParams();
    if (args.status) p.set("status", args.status);
    const qs = p.toString();
    return text(await mcRequest("GET", `/initiatives${qs ? `?${qs}` : ""}`));
  },
);

server.registerTool(
  "get_initiative",
  {
    title: "Get initiative details",
    description:
      "Fetch full detail on one initiative by id, including its linked projects, tasks, risks, and decisions.",
    inputSchema: { id: z.string().describe("Initiative id") },
  },
  async (args) => text(await mcRequest("GET", `/initiatives/${encodeURIComponent(args.id)}`)),
);

server.registerTool(
  "update_initiative_status",
  {
    title: "Update initiative status",
    description:
      "Set an initiative's status to one of PROPOSED, ACTIVE, AT_RISK, BLOCKED, COMPLETED, CANCELLED. Role-scoped server-side: the server requires LEAD+ ownership or admin and returns a 403 (whose text is surfaced) if the caller is insufficient. Returns the initiative id, url, and a confirmation message.",
    inputSchema: {
      id: z.string().describe("Initiative id"),
      status: z
        .enum(["PROPOSED", "ACTIVE", "AT_RISK", "BLOCKED", "COMPLETED", "CANCELLED"])
        .describe("New initiative status"),
    },
  },
  async (args) =>
    text(
      await mcRequest("PATCH", `/initiatives/${encodeURIComponent(args.id)}`, {
        status: args.status,
      }),
    ),
);

server.registerTool(
  "create_initiative",
  {
    title: "Create an initiative",
    description:
      "Create a new strategic initiative, attributed to the API key's owner. status is one of PROPOSED, ACTIVE, AT_RISK, BLOCKED, COMPLETED, CANCELLED; percentComplete is 0–100. Optionally set the next milestone and target/milestone dates. Role-scoped server-side: the server enforces RBAC and returns a 403 (whose text is surfaced) if the caller's role is insufficient. Returns the new initiative id, url, and a confirmation message.",
    inputSchema: {
      name: z.string().min(1).describe("Initiative name"),
      description: z.string().optional().describe("Full initiative description (optional)"),
      status: z
        .enum(["PROPOSED", "ACTIVE", "AT_RISK", "BLOCKED", "COMPLETED", "CANCELLED"])
        .optional()
        .describe("Initial status (optional)"),
      percentComplete: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Percent complete, 0–100 (optional)"),
      nextMilestone: z.string().optional().describe("Description of the next milestone (optional)"),
      nextMilestoneDate: z
        .string()
        .optional()
        .describe("Next milestone date, ISO 8601 (optional)"),
      targetDate: z.string().optional().describe("Target completion date, ISO 8601 (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", "/initiatives", {
        name: args.name,
        description: args.description,
        status: args.status,
        percentComplete: args.percentComplete,
        nextMilestone: args.nextMilestone,
        nextMilestoneDate: args.nextMilestoneDate,
        targetDate: args.targetDate,
      }),
    ),
);

server.registerTool(
  "update_initiative",
  {
    title: "Update an initiative",
    description:
      "Update a strategic initiative. status is one of PROPOSED, ACTIVE, AT_RISK, BLOCKED, COMPLETED, CANCELLED; percentComplete is 0–100. Only the provided fields change. Role-scoped server-side: the server requires LEAD+ ownership or admin and returns a 403 (whose text is surfaced) if the caller is insufficient. Returns the initiative id, url, and a confirmation message.",
    inputSchema: {
      id: z.string().describe("Initiative id"),
      name: z.string().min(1).optional().describe("New name (optional)"),
      description: z.string().optional().describe("New description (optional)"),
      status: z
        .enum(["PROPOSED", "ACTIVE", "AT_RISK", "BLOCKED", "COMPLETED", "CANCELLED"])
        .optional()
        .describe("New status (optional)"),
      percentComplete: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("New percent complete, 0–100 (optional)"),
      nextMilestone: z.string().optional().describe("New next-milestone description (optional)"),
      nextMilestoneDate: z
        .string()
        .optional()
        .describe("New next milestone date, ISO 8601 (optional)"),
      targetDate: z
        .string()
        .optional()
        .describe("New target completion date, ISO 8601 (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("PATCH", `/initiatives/${encodeURIComponent(args.id)}`, {
        name: args.name,
        description: args.description,
        status: args.status,
        percentComplete: args.percentComplete,
        nextMilestone: args.nextMilestone,
        nextMilestoneDate: args.nextMilestoneDate,
        targetDate: args.targetDate,
      }),
    ),
);

// ─── Projects ──────────────────────────────────────────────────────────────────

server.registerTool(
  "create_project",
  {
    title: "Create a project",
    description:
      "Create a new project, attributed to the API key's owner. Optionally link it to a strategic initiative and set a slug. status is one of PLANNING, ACTIVE, ON_HOLD, COMPLETED, CANCELLED. Role-scoped server-side: the server enforces RBAC and returns a 403 (whose text is surfaced) if the caller's role is insufficient. Returns the new project id, url, and a confirmation message.",
    inputSchema: {
      name: z.string().min(1).describe("Project name"),
      slug: z.string().optional().describe("URL slug (optional; auto-derived if omitted)"),
      initiativeId: z
        .string()
        .optional()
        .describe("Id of the strategic initiative to link this project to (optional)"),
      description: z.string().optional().describe("Full project description (optional)"),
      status: z
        .enum(["PLANNING", "ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"])
        .optional()
        .describe("Initial status (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", "/projects", {
        name: args.name,
        slug: args.slug,
        initiativeId: args.initiativeId,
        description: args.description,
        status: args.status,
      }),
    ),
);

// ─── Procurements ──────────────────────────────────────────────────────────────

server.registerTool(
  "list_procurements",
  {
    title: "List procurements",
    description:
      "List the procurement pipeline. Optionally filter by stage (e.g. Eval, Vendor Setup, Legal, PO Approval, Issued, Operational).",
    inputSchema: {
      stage: z.string().optional().describe("Filter by pipeline stage (optional)"),
    },
  },
  async (args) => {
    const p = new URLSearchParams();
    if (args.stage) p.set("stage", args.stage);
    const qs = p.toString();
    return text(await mcRequest("GET", `/procurements${qs ? `?${qs}` : ""}`));
  },
);

server.registerTool(
  "advance_procurement_stage",
  {
    title: "Advance procurement stage",
    description:
      "Advance a procurement to a stage: EVAL, VENDOR_SETUP, LEGAL, PO_APPROVAL, ISSUED, OPERATIONAL, or CANCELLED. Optionally record the next action. Admin-only server-side: the server enforces RBAC and returns a 403 (whose text is surfaced) if the caller isn't an admin. Returns the procurement id, url, and a confirmation message.",
    inputSchema: {
      id: z.string().describe("Procurement id"),
      stage: z
        .enum([
          "EVAL",
          "VENDOR_SETUP",
          "LEGAL",
          "PO_APPROVAL",
          "ISSUED",
          "OPERATIONAL",
          "CANCELLED",
        ])
        .describe("Stage to advance the procurement to"),
      nextAction: z.string().optional().describe("Next action to record on the procurement (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", `/procurements/${encodeURIComponent(args.id)}/advance`, {
        stage: args.stage,
        nextAction: args.nextAction,
      }),
    ),
);

server.registerTool(
  "create_procurement",
  {
    title: "Create a procurement",
    description:
      "Create a new procurement-pipeline entry, attributed to the API key's owner. Optionally link a vendor, set the dollar amount, the initial pipeline stage (EVAL, VENDOR_SETUP, LEGAL, PO_APPROVAL, ISSUED, OPERATIONAL, CANCELLED), the next action, and a renewal date. Role-scoped server-side: the server enforces RBAC and returns a 403 (whose text is surfaced) if the caller's role is insufficient. Returns the new procurement id, url, and a confirmation message.",
    inputSchema: {
      scope: z.string().min(1).describe("What is being procured (scope / description)"),
      vendorId: z.string().optional().describe("Id of the vendor to link this procurement to (optional)"),
      dollarAmount: z.number().optional().describe("Dollar amount of the procurement (optional)"),
      stage: z
        .enum([
          "EVAL",
          "VENDOR_SETUP",
          "LEGAL",
          "PO_APPROVAL",
          "ISSUED",
          "OPERATIONAL",
          "CANCELLED",
        ])
        .optional()
        .describe("Initial pipeline stage (optional)"),
      nextAction: z.string().optional().describe("Next action to record on the procurement (optional)"),
      renewalDate: z.string().optional().describe("Renewal date, ISO 8601 (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", "/procurements", {
        scope: args.scope,
        vendorId: args.vendorId,
        dollarAmount: args.dollarAmount,
        stage: args.stage,
        nextAction: args.nextAction,
        renewalDate: args.renewalDate,
      }),
    ),
);

server.registerTool(
  "update_procurement",
  {
    title: "Update a procurement",
    description:
      "Update a procurement-pipeline entry's details. Only the provided fields change. Stage changes go through advance_procurement_stage, not this tool. Role-scoped server-side: the server enforces RBAC and returns a 403 (whose text is surfaced) if the caller's role is insufficient. Returns the procurement id, url, and a confirmation message.",
    inputSchema: {
      id: z.string().describe("Procurement id"),
      scope: z.string().min(1).optional().describe("New scope / description (optional)"),
      vendorId: z.string().optional().describe("New linked vendor id (optional)"),
      dollarAmount: z.number().optional().describe("New dollar amount (optional)"),
      nextAction: z.string().optional().describe("New next action (optional)"),
      renewalDate: z.string().optional().describe("New renewal date, ISO 8601 (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("PATCH", `/procurements/${encodeURIComponent(args.id)}`, {
        scope: args.scope,
        vendorId: args.vendorId,
        dollarAmount: args.dollarAmount,
        nextAction: args.nextAction,
        renewalDate: args.renewalDate,
      }),
    ),
);

// ─── Vendors ───────────────────────────────────────────────────────────────────

server.registerTool(
  "list_vendors",
  {
    title: "List vendors",
    description:
      "List vendors from the shared vendor directory. Read-only; results are scoped to the caller's role and the server enforces RBAC (a 403 with explanatory text is surfaced if the caller can't view a vendor).",
    inputSchema: {},
  },
  async () => text(await mcRequest("GET", "/vendors")),
);

server.registerTool(
  "get_vendor",
  {
    title: "Get vendor details",
    description:
      "Fetch full detail on one vendor by id, including contacts, contract status, and linked procurements. Role-scoped server-side; a 403 with explanatory text is surfaced if the caller can't view it.",
    inputSchema: { id: z.string().describe("Vendor id") },
  },
  async (args) => text(await mcRequest("GET", `/vendors/${encodeURIComponent(args.id)}`)),
);

server.registerTool(
  "create_vendor",
  {
    title: "Create a vendor",
    description:
      "Create a new vendor in the shared vendor directory, attributed to the API key's owner. contractStatus is one of NONE, PROSPECT, ACTIVE, EXPIRING, EXPIRED, TERMINATED. Optionally set the primary contact. Role-scoped server-side: the server enforces RBAC and returns a 403 (whose text is surfaced) if the caller's role is insufficient. Returns the new vendor id, url, and a confirmation message.",
    inputSchema: {
      name: z.string().min(1).describe("Vendor name"),
      primaryContactName: z.string().optional().describe("Primary contact name (optional)"),
      primaryContactEmail: z.string().optional().describe("Primary contact email (optional)"),
      contractStatus: z
        .enum(["NONE", "PROSPECT", "ACTIVE", "EXPIRING", "EXPIRED", "TERMINATED"])
        .optional()
        .describe("Contract status (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", "/vendors", {
        name: args.name,
        primaryContactName: args.primaryContactName,
        primaryContactEmail: args.primaryContactEmail,
        contractStatus: args.contractStatus,
      }),
    ),
);

server.registerTool(
  "update_vendor",
  {
    title: "Update a vendor",
    description:
      "Update a vendor in the shared vendor directory. contractStatus is one of NONE, PROSPECT, ACTIVE, EXPIRING, EXPIRED, TERMINATED. Only the provided fields change. Role-scoped server-side: the server enforces RBAC and returns a 403 (whose text is surfaced) if the caller's role is insufficient. Returns the vendor id, url, and a confirmation message.",
    inputSchema: {
      id: z.string().describe("Vendor id"),
      name: z.string().min(1).optional().describe("New name (optional)"),
      primaryContactName: z.string().optional().describe("New primary contact name (optional)"),
      primaryContactEmail: z.string().optional().describe("New primary contact email (optional)"),
      contractStatus: z
        .enum(["NONE", "PROSPECT", "ACTIVE", "EXPIRING", "EXPIRED", "TERMINATED"])
        .optional()
        .describe("New contract status (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("PATCH", `/vendors/${encodeURIComponent(args.id)}`, {
        name: args.name,
        primaryContactName: args.primaryContactName,
        primaryContactEmail: args.primaryContactEmail,
        contractStatus: args.contractStatus,
      }),
    ),
);

// ─── Decisions ─────────────────────────────────────────────────────────────────

server.registerTool(
  "log_decision",
  {
    title: "Log a decision",
    description:
      "Append a decision to the formal decision log (append-only / audit-grade), attributed to the API key's owner. Optionally summarize the impact and link related initiatives. Returns the new decision id, url, and a confirmation message.",
    inputSchema: {
      title: z.string().min(1).describe("Short decision title, e.g. 'Approved the OZ Digital SOW'"),
      rationale: z.string().min(1).describe("Why the decision was made"),
      impactSummary: z.string().optional().describe("Brief summary of the decision's impact (optional)"),
      relatedInitiatives: z
        .array(z.string())
        .optional()
        .describe("Ids of initiatives this decision relates to (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", "/decisions", {
        title: args.title,
        rationale: args.rationale,
        impactSummary: args.impactSummary,
        relatedInitiatives: args.relatedInitiatives,
      }),
    ),
);

// ─── Risks (append-only register, role-scoped) ──────────────────────────────────

server.registerTool(
  "list_risks",
  {
    title: "List risks",
    description:
      "List entries from the risk register. Optionally filter by status (OPEN, MITIGATED, ACCEPTED, CLOSED). Read-only; results are scoped to the caller's role and the server enforces RBAC (a 403 with explanatory text is surfaced if the caller can't view a risk).",
    inputSchema: {
      status: z
        .enum(["OPEN", "MITIGATED", "ACCEPTED", "CLOSED"])
        .optional()
        .describe("Filter by risk status (optional)"),
    },
  },
  async (args) => {
    const p = new URLSearchParams();
    if (args.status) p.set("status", args.status);
    const qs = p.toString();
    return text(await mcRequest("GET", `/risks${qs ? `?${qs}` : ""}`));
  },
);

server.registerTool(
  "get_risk",
  {
    title: "Get risk details",
    description:
      "Fetch full detail on one risk by id, including its severity/likelihood (each 1–5), mitigation, and supersede history. Role-scoped server-side; a 403 with explanatory text is surfaced if the caller can't view it.",
    inputSchema: { id: z.string().describe("Risk id") },
  },
  async (args) => text(await mcRequest("GET", `/risks/${encodeURIComponent(args.id)}`)),
);

server.registerTool(
  "file_risk",
  {
    title: "File a risk",
    description:
      "File a new risk in the append-only risk register, attributed to the API key's owner. severity and likelihood are each on a 1–5 scale (1 = lowest, 5 = highest). Optionally describe it, note a mitigation, and link related initiatives. Role-scoped server-side: the server enforces RBAC and returns a 403 (whose text is surfaced) if the caller's role is insufficient. Returns the new risk id, url, and a confirmation message.",
    inputSchema: {
      title: z.string().min(1).describe("Short risk title"),
      description: z.string().optional().describe("Full risk description (optional)"),
      severity: z
        .number()
        .int()
        .min(1)
        .max(5)
        .describe("Severity on a 1–5 scale (1 = lowest, 5 = highest)"),
      likelihood: z
        .number()
        .int()
        .min(1)
        .max(5)
        .describe("Likelihood on a 1–5 scale (1 = lowest, 5 = highest)"),
      mitigation: z.string().optional().describe("Planned or in-place mitigation (optional)"),
      relatedInitiatives: z
        .array(z.string())
        .optional()
        .describe("Ids of initiatives this risk relates to (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", "/risks", {
        title: args.title,
        description: args.description,
        severity: args.severity,
        likelihood: args.likelihood,
        mitigation: args.mitigation,
        relatedInitiatives: args.relatedInitiatives,
      }),
    ),
);

server.registerTool(
  "update_risk",
  {
    title: "Update a risk",
    description:
      "Update a risk in the register (append-only / supersede semantics server-side). severity and likelihood, when given, are each on a 1–5 scale (1 = lowest, 5 = highest); status is one of OPEN, MITIGATED, ACCEPTED, CLOSED. Only the provided fields change. Role-scoped server-side: the server enforces RBAC/ownership and returns a 403 (whose text is surfaced) if the caller is insufficient. Returns the risk id, url, and a confirmation message.",
    inputSchema: {
      id: z.string().describe("Risk id"),
      title: z.string().min(1).optional().describe("New title (optional)"),
      description: z.string().optional().describe("New description (optional)"),
      severity: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("New severity on a 1–5 scale (1 = lowest, 5 = highest) (optional)"),
      likelihood: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("New likelihood on a 1–5 scale (1 = lowest, 5 = highest) (optional)"),
      status: z
        .enum(["OPEN", "MITIGATED", "ACCEPTED", "CLOSED"])
        .optional()
        .describe("New risk status (optional)"),
      mitigation: z.string().optional().describe("New mitigation (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("PATCH", `/risks/${encodeURIComponent(args.id)}`, {
        title: args.title,
        description: args.description,
        severity: args.severity,
        likelihood: args.likelihood,
        status: args.status,
        mitigation: args.mitigation,
      }),
    ),
);

// ─── Scan state (per-user Cowork watermark) ─────────────────────────────────────

server.registerTool(
  "get_scan_state",
  {
    title: "Get scan state",
    description:
      "Return the calling user's scan watermark (last email/calendar scan ISO timestamps) and last-run summary. Replaces the local _state/scan-state.json that Cowork's productivity scans used to read.",
    inputSchema: {},
  },
  async () => text(await mcRequest("GET", "/scan-state")),
);

server.registerTool(
  "update_scan_state",
  {
    title: "Update scan state",
    description:
      "Write the caller's scan watermark and last-run result. Only provided fields change. Use after a productivity scan to advance the watermark. Auto-attributed to the caller. Returns a confirmation.",
    inputSchema: {
      lastEmailScanIso: z.string().optional().describe("ISO timestamp of the last email scan (optional)"),
      lastCalendarScanIso: z
        .string()
        .optional()
        .describe("ISO timestamp of the last calendar scan (optional)"),
      lastRunIso: z.string().optional().describe("ISO timestamp of the last scan run (optional)"),
      lastRunResult: z.string().optional().describe("Free-text result/summary of the last run (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("PUT", "/scan-state", {
        lastEmailScanIso: args.lastEmailScanIso,
        lastCalendarScanIso: args.lastCalendarScanIso,
        lastRunIso: args.lastRunIso,
        lastRunResult: args.lastRunResult,
      }),
    ),
);

server.registerTool(
  "log_scan_run",
  {
    title: "Log a scan run",
    description:
      "Append a row to the caller's scan-run history (audit / debugging) capturing the scan window, volume scanned, items proposed, prompt-injection flags, and a summary. Auto-attributed to the caller. Returns a confirmation.",
    inputSchema: {
      windowStartIso: z.string().optional().describe("ISO timestamp of the scan window start (optional)"),
      windowEndIso: z.string().optional().describe("ISO timestamp of the scan window end (optional)"),
      emailsScanned: z.number().int().optional().describe("Number of emails scanned (optional)"),
      itemsProposed: z.number().int().optional().describe("Number of items proposed for review (optional)"),
      promptInjectionFlags: z
        .number()
        .int()
        .optional()
        .describe("Count of prompt-injection attempts flagged during the scan (optional)"),
      summary: z.string().optional().describe("Free-text summary of the run (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", "/scan-runs", {
        windowStartIso: args.windowStartIso,
        windowEndIso: args.windowEndIso,
        emailsScanned: args.emailsScanned,
        itemsProposed: args.itemsProposed,
        promptInjectionFlags: args.promptInjectionFlags,
        summary: args.summary,
      }),
    ),
);

// ─── Today / Focus (per-user-per-day) ───────────────────────────────────────────

server.registerTool(
  "get_today",
  {
    title: "Get today's focus",
    description:
      "Return the caller's current-day focus state (synced calendar, notes, top-of-mind). Replaces the local today.md blob.",
    inputSchema: {},
  },
  async () => text(await mcRequest("GET", "/today")),
);

server.registerTool(
  "update_today",
  {
    title: "Update today's focus",
    description:
      "Write the caller's notes and top-of-mind for today (the calendar is always synced from M365 server-side, so it isn't set here). Only provided fields change. Auto-attributed to the caller. Returns a confirmation.",
    inputSchema: {
      notes: z.string().optional().describe("Free-text notes for today (optional)"),
      topOfMind: z
        .array(z.string())
        .optional()
        .describe("List of top-of-mind items for today (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("PUT", "/today", {
        notes: args.notes,
        topOfMind: args.topOfMind,
      }),
    ),
);

// ─── Pending Review (per-user queue) ────────────────────────────────────────────

server.registerTool(
  "list_pending_reviews",
  {
    title: "List pending review items",
    description:
      "Return the caller's Pending Review queue (proposed items awaiting approve/reject), ordered by created_at. Replaces TASKS.md's '## Pending Review' section.",
    inputSchema: {},
  },
  async () => text(await mcRequest("GET", "/pending-reviews")),
);

server.registerTool(
  "propose_review_item",
  {
    title: "Propose a review item",
    description:
      "Append an item to the caller's Pending Review queue (e.g. a candidate task surfaced by a scan). Optionally record where it came from. Auto-attributed to the caller. Returns the new item id, url, and a confirmation message.",
    inputSchema: {
      title: z.string().min(1).describe("Short title of the proposed item"),
      description: z.string().optional().describe("Detail / context for the proposed item (optional)"),
      sourceType: z
        .string()
        .optional()
        .describe("Where it came from, e.g. 'email', 'calendar', 'manual' (optional)"),
      sourceUrl: z.string().optional().describe("Link back to the source (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", "/pending-reviews", {
        title: args.title,
        description: args.description,
        sourceType: args.sourceType,
        sourceUrl: args.sourceUrl,
      }),
    ),
);

server.registerTool(
  "approve_review_item",
  {
    title: "Approve a review item",
    description:
      "Approve a pending review item, converting it into an active task. Returns the new task id, url, and a confirmation message.",
    inputSchema: { id: z.string().describe("Pending review item id") },
  },
  async (args) =>
    text(await mcRequest("POST", `/pending-reviews/${encodeURIComponent(args.id)}/approve`)),
);

server.registerTool(
  "reject_review_item",
  {
    title: "Reject a review item",
    description:
      "Reject a pending review item, with an optional reason. Returns the item id, url, and a confirmation message.",
    inputSchema: {
      id: z.string().describe("Pending review item id"),
      reason: z.string().optional().describe("Why it was rejected (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", `/pending-reviews/${encodeURIComponent(args.id)}/reject`, {
        reason: args.reason,
      }),
    ),
);

// ─── Shared knowledge lookups (org-wide, role-respecting) ────────────────────────

server.registerTool(
  "lookup_person",
  {
    title: "Look up a person",
    description:
      "Fuzzy-match a person by name (or email) and return their canonical record from the shared people directory. Replaces reading memory/people/*.md — e.g. when Cowork hits an unfamiliar name.",
    inputSchema: { query: z.string().min(1).describe("Name or email to look up") },
  },
  async (args) =>
    text(await mcRequest("GET", `/people?q=${encodeURIComponent(args.query)}`)),
);

server.registerTool(
  "lookup_project",
  {
    title: "Look up a project",
    description:
      "Find a project by name or slug and return its canonical record from shared org state. Replaces reading memory/projects/*.md.",
    inputSchema: { query: z.string().min(1).describe("Project name or slug to look up") },
  },
  async (args) =>
    text(await mcRequest("GET", `/projects?q=${encodeURIComponent(args.query)}`)),
);

server.registerTool(
  "lookup_glossary",
  {
    title: "Look up a glossary term",
    description:
      "Look up an org-wide term/acronym and return its canonical definition from the shared glossary. Replaces memory/context/glossary.md.",
    inputSchema: { term: z.string().min(1).describe("Term or acronym to define") },
  },
  async (args) =>
    text(await mcRequest("GET", `/glossary?term=${encodeURIComponent(args.term)}`)),
);

server.registerTool(
  "search_org_knowledge",
  {
    title: "Search org knowledge",
    description:
      "Full-text keyword search across shared org knowledge (people, projects, decisions, vendors, communications), scoped to the caller's role. Returns structured matches; the caller's Cowork reasons over them.",
    inputSchema: { query: z.string().min(1).describe("Free-text search query") },
  },
  async (args) =>
    text(await mcRequest("GET", `/search?q=${encodeURIComponent(args.query)}`)),
);

// ─── People (shared directory, role-scoped) ──────────────────────────────────────

server.registerTool(
  "add_person",
  {
    title: "Add a person",
    description:
      "Add a person to the shared people directory, attributed to the API key's owner. employmentType is one of FULL_TIME, PART_TIME, CONTRACTOR, ADVISOR, VENDOR; isInternal flags whether they're an internal team member. Optionally set email, role title, start/end dates, and notes. Role-scoped server-side: the server enforces RBAC and returns a 403 (whose text is surfaced) if the caller's role is insufficient. Returns the new person id, url, and a confirmation message.",
    inputSchema: {
      name: z.string().min(1).describe("Person's name"),
      email: z.string().optional().describe("Email address (optional)"),
      roleTitle: z.string().optional().describe("Role / job title (optional)"),
      employmentType: z
        .enum(["FULL_TIME", "PART_TIME", "CONTRACTOR", "ADVISOR", "VENDOR"])
        .optional()
        .describe("Employment type (optional)"),
      startDate: z.string().optional().describe("Start date, ISO 8601 (optional)"),
      endDate: z.string().optional().describe("End date, ISO 8601 (optional)"),
      isInternal: z.boolean().optional().describe("Whether the person is an internal team member (optional)"),
      notes: z.string().optional().describe("Free-text notes (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", "/people", {
        name: args.name,
        email: args.email,
        roleTitle: args.roleTitle,
        employmentType: args.employmentType,
        startDate: args.startDate,
        endDate: args.endDate,
        isInternal: args.isInternal,
        notes: args.notes,
      }),
    ),
);

server.registerTool(
  "update_person",
  {
    title: "Update a person",
    description:
      "Update a person in the shared people directory. employmentType is one of FULL_TIME, PART_TIME, CONTRACTOR, ADVISOR, VENDOR. Only the provided fields change. Role-scoped server-side: the server enforces RBAC and returns a 403 (whose text is surfaced) if the caller's role is insufficient. Returns the person id, url, and a confirmation message.",
    inputSchema: {
      id: z.string().describe("Person id"),
      name: z.string().min(1).optional().describe("New name (optional)"),
      email: z.string().optional().describe("New email address (optional)"),
      roleTitle: z.string().optional().describe("New role / job title (optional)"),
      employmentType: z
        .enum(["FULL_TIME", "PART_TIME", "CONTRACTOR", "ADVISOR", "VENDOR"])
        .optional()
        .describe("New employment type (optional)"),
      startDate: z.string().optional().describe("New start date, ISO 8601 (optional)"),
      endDate: z.string().optional().describe("New end date, ISO 8601 (optional)"),
      isInternal: z.boolean().optional().describe("Whether the person is an internal team member (optional)"),
      notes: z.string().optional().describe("New free-text notes (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("PATCH", `/people/${encodeURIComponent(args.id)}`, {
        name: args.name,
        email: args.email,
        roleTitle: args.roleTitle,
        employmentType: args.employmentType,
        startDate: args.startDate,
        endDate: args.endDate,
        isInternal: args.isInternal,
        notes: args.notes,
      }),
    ),
);

// ─── Glossary (shared, role-scoped) ──────────────────────────────────────────────

server.registerTool(
  "add_glossary_term",
  {
    title: "Add a glossary term",
    description:
      "Add a term to the shared org glossary, attributed to the API key's owner. scope is ORG (org-wide) or DOMAIN (domain-specific). Optionally set a category. Role-scoped server-side: the server enforces RBAC and returns a 403 (whose text is surfaced) if the caller's role is insufficient. Returns the new term id, url, and a confirmation message.",
    inputSchema: {
      term: z.string().min(1).describe("Term or acronym"),
      definition: z.string().min(1).describe("Canonical definition"),
      scope: z
        .enum(["ORG", "DOMAIN"])
        .optional()
        .describe("Scope: ORG (org-wide) or DOMAIN (domain-specific) (optional)"),
      category: z.string().optional().describe("Category for grouping (optional)"),
    },
  },
  async (args) =>
    text(
      await mcRequest("POST", "/glossary", {
        term: args.term,
        definition: args.definition,
        scope: args.scope,
        category: args.category,
      }),
    ),
);

// ═══════════════════════════════════════════════════════════════════════════════
// RESOURCES — readable context the client's Claude can pull into a session.
// (registerResource(name, uriString, { title, description, mimeType }, cb))
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Static onboarding guide. Embedded in the server (no API call) so a fresh Cowork
 * session can read it before touching any tool. This is the only resource whose
 * content lives in this file; the other two proxy live API endpoints.
 */
const GUIDE_MD = `# How to work with Mission Control

Mission Control (MC) is AMPERA's **shared org brain**: one place of record for the
people, projects, strategic initiatives, decisions, risks, vendors/procurements, and
tasks that the leadership team works from. It also holds your **per-user working
state** — your scan watermark, your "today" focus, and your Pending Review queue —
the things a Cowork session used to keep in local files.

MC is **passive**. It is a database + API + UI + MCP server and nothing more: it does
**not** call any LLM and does no reasoning of its own. All prose, judgement, and
synthesis happen in **your** Cowork. These tools just hand you structured data and
record the changes you confirm.

## The shared-brain principle

- **MC is the source of truth.** Prefer it over local memory files. When MC and a
  local note disagree, MC wins; treat local files only as a fallback when MC is
  unreachable.
- Writes are attributed to **you** (the owner of the \`amc_\` API key) and are
  enforced server-side by your role. You cannot do via MCP what your role can't do.
- Decisions and risks are **append-only** with supersede chains — you add new
  records, you never silently edit history.

## Roles

\`VIEWER < CONTRIBUTOR < LEAD < EXECUTIVE < ADMIN\`. Higher ranks see and do more
(e.g. \`list_tasks mine=false\` to see the whole org is LEAD+). The server decides;
if a call is refused, it's a permissions answer, not a bug to route around.

## When to reach for which tool

- **Don't guess names — look them up.** Hit an unfamiliar person, project, or
  acronym? Call \`lookup_person\`, \`lookup_project\`, or \`lookup_glossary\` before
  assuming. For broad recall across everything, \`search_org_knowledge\`.
- **Decisions go in the log.** When the user makes or approves a real decision, call
  \`log_decision\` (title + rationale + impact + related initiatives). Don't leave
  decisions buried in chat.
- **Replace local memory with the state loop.** Instead of reading/writing
  \`scan-state.json\`, \`today.md\`, or a "Pending Review" list on disk, use:
  - \`get_scan_state\` / \`update_scan_state\` / \`log_scan_run\` — the scan watermark
    and run history.
  - \`get_today\` / \`update_today\` — today's notes and top-of-mind.
  - \`list_pending_reviews\` / \`propose_review_item\` / \`approve_review_item\` /
    \`reject_review_item\` — the human-in-the-loop queue. Scans **propose**; the user
    **approves**; approval is what creates a real task.
- **Status & planning.** \`get_dashboard_summary\`, \`get_briefing_data\`,
  \`list_initiatives\` / \`get_initiative\`, \`list_tasks\`, \`list_procurements\`.

## Recommended rhythm

1. Start the day with the \`morning-scan\` prompt (scan state → today → pending
   reviews → my open tasks → dashboard) and agree a focus list.
2. Work the Pending Review queue (\`triage-reviews\`); log decisions as they happen.
3. Close the day with \`end-of-day\` — update today's notes and advance the scan
   watermark so tomorrow's scan starts from the right place.

The MC resources \`mission-control://me\` (your live snapshot) and
\`mission-control://glossary\` (the org glossary) are good things to pull in early.
`;

server.registerResource(
  "mission-control://guide",
  "mission-control://guide",
  {
    title: "How to work with Mission Control",
    description:
      "Onboarding guide for a fresh Cowork session: what Mission Control is, the role model, when to use which tool, the shared-brain / source-of-truth principle, and the daily state loop. Static markdown — no API call.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE_MD }],
  }),
);

server.registerResource(
  "mission-control://me",
  "mission-control://me",
  {
    title: "My Mission Control snapshot",
    description:
      "The caller's live snapshot from GET /api/v1/me: role, open tasks, pending reviews, today's focus, and scan watermark. Pull this in early to ground a session.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(await mcRequest("GET", "/me"), null, 2),
      },
    ],
  }),
);

server.registerResource(
  "mission-control://glossary",
  "mission-control://glossary",
  {
    title: "Org glossary",
    description:
      "The full org glossary from GET /api/v1/glossary (no params): canonical AMPERA terms and acronyms. Use the lookup_glossary tool for a single term.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(await mcRequest("GET", "/glossary"), null, 2),
      },
    ],
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPTS — templates that tell the *client's* Claude which MC tools to call, in
// what order. No LLM calls happen here; MC stays passive (REQUIREMENTS §2). Each
// callback returns a single user-role message carrying the instructions.
// (registerPrompt(name, { title, description, argsSchema }, cb))
// ═══════════════════════════════════════════════════════════════════════════════

/** Wrap instruction text as the single user message a prompt returns. */
const promptText = (instructions) => ({
  messages: [{ role: "user", content: { type: "text", text: instructions } }],
});

server.registerPrompt(
  "morning-scan",
  {
    title: "Morning scan",
    description: "Start-of-day triage across your Mission Control working state.",
  },
  () =>
    promptText(
      [
        "Run my start-of-day triage in Mission Control. In this order, call:",
        "1. get_scan_state — where my last scan left off.",
        "2. get_today — today's synced calendar, notes, and top-of-mind.",
        "3. list_pending_reviews — items proposed but not yet approved/rejected.",
        "4. list_tasks with mine=true and status='open' — my open tasks.",
        "5. get_dashboard_summary — my role's KPI tiles and widgets.",
        "",
        "Then summarize what needs my attention today (overdue/at-risk tasks,",
        "anything stale in the review queue, notable dashboard signals) and propose a",
        "short, prioritized focus list. Don't change anything yet — just brief me.",
      ].join("\n"),
    ),
);

server.registerPrompt(
  "log-decision",
  {
    title: "Log a decision",
    description: "Record a decision in the formal, append-only decision log.",
    argsSchema: {
      note: z.string().min(1).describe("What was decided, in the user's own words (required)"),
      initiative: z
        .string()
        .optional()
        .describe("Name of a related strategic initiative, if any (optional)"),
    },
  },
  (args) =>
    promptText(
      [
        `I need to log this decision: "${args.note}".`,
        args.initiative
          ? `It relates to the "${args.initiative}" initiative. First call list_initiatives to resolve that name to its id; if it's ambiguous, ask me which one before continuing.`
          : "No specific initiative was named; leave relatedInitiatives empty unless I tell you otherwise.",
        "",
        "Then call log_decision with:",
        "- title: a clear, specific one-line title (not just my raw note),",
        "- rationale: why this decision was made,",
        "- impactSummary: a brief note on what it affects,",
        args.initiative
          ? "- relatedInitiatives: the resolved initiative id(s)."
          : "- relatedInitiatives: omit unless I name one.",
        "",
        "Confirm by quoting the created decision's id and URL from the response.",
      ].join("\n"),
    ),
);

server.registerPrompt(
  "triage-reviews",
  {
    title: "Triage reviews",
    description: "Work the Pending Review queue: approve or reject proposed items.",
  },
  () =>
    promptText(
      [
        "Help me work my Pending Review queue in Mission Control.",
        "1. Call list_pending_reviews.",
        "2. For each item, recommend approve or reject with a one-line reason",
        "   (consider its source, whether it's actionable, and whether it duplicates",
        "   something I already have).",
        "3. Wait for my confirmation on each. Only then act:",
        "   - approve_review_item(id) to turn it into a real task, or",
        "   - reject_review_item(id, reason) with the reason we agreed.",
        "Never approve or reject without my explicit go-ahead.",
      ].join("\n"),
    ),
);

server.registerPrompt(
  "initiative-status",
  {
    title: "Initiative status",
    description: "Summarize the current status of one strategic initiative.",
    argsSchema: {
      initiative: z
        .string()
        .min(1)
        .describe("Name (or partial name) of the initiative to report on (required)"),
    },
  },
  (args) =>
    promptText(
      [
        `Give me a status read on the "${args.initiative}" initiative.`,
        "First resolve it to an id: try list_initiatives (and lookup_project if it",
        "reads like a project); if neither pins it down, use search_org_knowledge.",
        "If it stays ambiguous, ask me which one before continuing.",
        "",
        "Then call get_initiative with that id and summarize:",
        "- overall status and health,",
        "- linked projects and their state,",
        "- open/at-risk tasks,",
        "- recent decisions and any open or elevated risks,",
        "- current blockers and what they're waiting on.",
        "Keep it tight and executive-readable.",
      ].join("\n"),
    ),
);

server.registerPrompt(
  "weekly-briefing",
  {
    title: "Weekly briefing",
    description: "Compose the Monday briefing from Mission Control data.",
    argsSchema: {
      periodDays: z
        .string()
        .optional()
        .describe("Lookback window in days as a string, default 7 (optional)"),
    },
  },
  (args) => {
    const days = args.periodDays && args.periodDays.trim() ? args.periodDays.trim() : "7";
    return promptText(
      [
        "Compose my Monday briefing from Mission Control.",
        `1. Call get_briefing_data with periodDays=${days}.`,
        "2. Call get_today for this week's top-of-mind.",
        "",
        "Then write a concise, role-tailored briefing in prose suitable for email or",
        "PDF, covering:",
        "- decisions made in the period,",
        "- risks open or recently elevated,",
        "- procurement / vendor movement,",
        "- tasks completed,",
        "- what's top-of-mind for the week ahead.",
        "No tables of raw JSON — narrative an executive would actually read.",
      ].join("\n"),
    );
  },
);

server.registerPrompt(
  "end-of-day",
  {
    title: "End of day",
    description: "Close out the day: capture notes and advance the scan watermark.",
  },
  () =>
    promptText(
      [
        "Help me close out the day in Mission Control.",
        "1. Ask me for today's notes and my top-of-mind for tomorrow, then call",
        "   update_today with notes and topOfMind.",
        "2. Call update_scan_state with lastRunIso set to now (current ISO timestamp)",
        "   and lastRunResult set to a short summary of what we covered today.",
        "3. Optionally, if we did a real scan, call log_scan_run with the window and a",
        "   summary so there's a history entry.",
        "Confirm what was saved.",
      ].join("\n"),
    ),
);

server.registerPrompt(
  "migrate-from-cowork",
  {
    title: "Migrate my Cowork work in",
    description:
      "Turn the durable work from your Cowork sessions into Mission Control records on the shared dashboards — deduped, role-checked, and confirmed before each write.",
    argsSchema: {
      scope: z
        .string()
        .optional()
        .describe(
          "Narrow the migration to a topic, e.g. 'just my AI initiatives' or 'Q2 procurement' (optional; default = everything)",
        ),
      since: z
        .string()
        .optional()
        .describe("Only consider work from this point onward, e.g. 'January' or '2026-04-01' (optional)"),
    },
  },
  (args) => {
    const scopeLine = args.scope && args.scope.trim()
      ? `Focus only on: ${args.scope.trim()}.`
      : "Look across all of our past work together.";
    const sinceLine = args.since && args.since.trim()
      ? `Only consider work from ${args.since.trim()} onward.`
      : "";
    return promptText(
      [
        "Help me migrate my existing work into Mission Control. I've been working in",
        "Cowork for a while and want the durable items — the ones worth tracking on the",
        "shared dashboards — to become real Mission Control records. Work in phases, and",
        "do NOT create anything until I approve that category.",
        "",
        "PHASE 1 — Orient.",
        "- Read the mission-control://me resource to confirm who I am and my role.",
        "- My role gates what we can create: initiatives, projects, procurements,",
        "  vendors and people need LEAD or above; glossary needs CONTRIBUTOR or above;",
        "  tasks, decisions and risks are open to me. If my role is too low for a",
        "  category, tell me and skip it — don't attempt those writes.",
        "- Call get_dashboard_summary so you know which dashboard my data feeds.",
        "",
        "PHASE 2 — See what's already there, so we never create a duplicate.",
        "  Call list_initiatives, list_procurements, list_vendors, list_risks,",
        "  list_tasks (mine=true) and list_pending_reviews, and hold those as the",
        '  "already in Mission Control" set. Use search_org_knowledge, lookup_person',
        "  and lookup_glossary to spot-check specific names before proposing them.",
        "",
        "PHASE 3 — Mine my Cowork history for durable items.",
        `  ${scopeLine}${sinceLine ? " " + sinceLine : ""}`,
        "  Pull out the things that deserve to live in the system of record — not",
        "  one-off questions or chit-chat. Sort each into exactly one category and the",
        "  tool that creates it:",
        "   - Strategic initiative   → create_initiative",
        "   - Project                 → create_project",
        "   - Decision already made   → log_decision",
        "   - Risk                    → file_risk",
        "   - Vendor                  → create_vendor",
        "   - Procurement / contract  → create_procurement (create_vendor first if the vendor is new)",
        "   - Person (team or org)    → add_person",
        "   - Task / action item      → create_task",
        "   - Acronym / term          → add_glossary_term",
        '  Drop anything that already matches the "already in Mission Control" set.',
        "  For each kept item, note why it qualifies and how confident you are.",
        "",
        "PHASE 4 — Show me the plan before touching anything.",
        "  Present it grouped by category — for each proposed record, the key fields",
        "  you'd send, marked NEW, DUPLICATE (skipped) or LOW-CONFIDENCE (needs my",
        "  call). Put the totals at the top. Write nothing yet.",
        "",
        "PHASE 5 — Create, one category at a time, only what I approve.",
        "  When I approve a category, create those records with the mapped tool, one by",
        "  one, and quote the id and URL each call returns. If a write fails (a 403 for",
        "  my role, or a validation error), report it and move on — never loop or guess",
        "  around it.",
        "",
        "PHASE 6 — Wrap up.",
        "  Summarize what was created and which dashboard each item now appears on, then",
        "  list everything we skipped (duplicates, low-confidence, or blocked by role)",
        "  so I can follow up.",
      ].join("\n"),
    );
  },
);

await server.connect(new StdioServerTransport());
console.error(`ampera-mission-control MCP ready (${BASE})`);
