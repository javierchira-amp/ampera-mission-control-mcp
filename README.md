# AMPERA Mission Control — MCP server

Connect your **Claude Cowork / Claude Desktop** to **AMPERA Mission Control** so Claude can read and write your org data (initiatives, tasks, risks, decisions, procurements, your scan-state / today / pending-review queue, and more) — scoped to your role.

This is a thin, read-it-yourself client: it just calls the Mission Control REST API with your personal API key. **No secrets live in here** — you supply your key via env.

> **You must be on the Ampera office network or VPN.** Mission Control is internal-only (`missioncontrol.amperaglobal.com` resolves to a private address), so the server is only reachable from inside the network.
>
> This runs **alongside** the ServiceDesk MCP — add it as a second entry; both stay connected.

## Prerequisites

- **Node 18+** (Node 22 recommended) — Claude Desktop does not bundle Node; install it on your laptop if you haven't.
- A Mission Control account (sign in with Microsoft) and access to the network/VPN.

## 1. Install

```bash
git clone https://github.com/javierchira-amp/ampera-mission-control-mcp.git
cd ampera-mission-control-mcp
npm install
npm install -g .      # puts the `ampera-mission-control-mcp` command on your PATH
```

## 2. Get your API key

In Mission Control: **AI Assistant** (sidebar) → **Generate API Key** → copy the `amc_…` value (shown once).

## 3. Add it to your Claude config

Edit `claude_desktop_config.json` (Claude → Settings → Developer → Edit Config) and add a `mcpServers` entry:

```json
{
  "mcpServers": {
    "ampera-mission-control": {
      "command": "ampera-mission-control-mcp",
      "env": {
        "MISSION_CONTROL_URL": "https://missioncontrol.amperaglobal.com",
        "MISSION_CONTROL_API_KEY": "amc_paste-your-key-here"
      }
    }
  }
}
```

**If `command: "ampera-mission-control-mcp"` isn't found** (some GUI apps don't see your global npm bin), use the absolute path instead:

```json
{
  "mcpServers": {
    "ampera-mission-control": {
      "command": "node",
      "args": ["/absolute/path/to/ampera-mission-control-mcp/index.mjs"],
      "env": {
        "MISSION_CONTROL_URL": "https://missioncontrol.amperaglobal.com",
        "MISSION_CONTROL_API_KEY": "amc_paste-your-key-here"
      }
    }
  }
}
```

(Find your Node path with `which node` on macOS/Linux or `where node` on Windows.)

## 4. Restart & use

Fully **quit and reopen** Claude, then start a **new conversation**. The AI Assistant page in Mission Control will show **"Connected via Cowork"** after the first call.

Try: *"What's my Mission Control scan state?"* · *"Log a decision: …"* · *"File a risk: … severity 3, likelihood 4"* · or run the **`mc:morning-scan`** prompt.

## What's exposed

- **30 tools** — reads (dashboard, tasks, initiatives, procurements, risks, scan-state, today, pending-reviews, people/projects/glossary lookups, org search, briefing) and role-scoped writes (create/update/complete tasks, log decisions, file/update risks, update initiative status, advance procurement stage, update scan-state/today, propose/approve/reject review items).
- **6 prompts** — `mc:morning-scan`, `log-decision`, `triage-reviews`, `initiative-status`, `weekly-briefing`, `end-of-day`.
- **3 resources** — `mission-control://guide`, `mission-control://me`, `mission-control://glossary`.

Everything is enforced server-side by your role; the server returns a clear error if your key lacks permission. Revoke a key anytime on the AI Assistant page.
