# AMPERA Mission Control — MCP server

Connect your **Claude Desktop / Cowork** to **AMPERA Mission Control** so Claude can read and write your org data (initiatives, tasks, risks, decisions, procurements, your scan-state / today / pending-review queue, and more) — scoped to your role.

A thin, read-it-yourself client: it just calls the Mission Control REST API with your personal API key. **No secrets live in here** — you supply your key via env.

> **You must be on the Ampera office network or VPN.** Mission Control is internal-only (`missioncontrol.amperaglobal.com` resolves to a private address).
>
> This runs **alongside** the ServiceDesk MCP — add it as a second entry; both stay connected.

## Prerequisites

- **Node 18+** (Node 22 recommended). Claude Desktop does not bundle Node — install it on your laptop.

## 1. Install

```bash
git clone https://github.com/javierchira-amp/ampera-mission-control-mcp.git
cd ampera-mission-control-mcp
npm install
```
Note the full path to `index.mjs` in this folder — you'll need it below (`pwd` on macOS/Linux, `cd` shows it on Windows).

## 2. Get your API key

In Mission Control: **AI Assistant** (sidebar) → **Generate API Key** → copy the `amc_…` value (shown once).

## 3. Add it to your Claude config

Edit `claude_desktop_config.json` (Claude → Settings → Developer → Edit Config) and add an entry under `mcpServers`. **Use `node` + the absolute path to `index.mjs`** — this is the form that reliably works on both Windows and macOS (a bare command name often isn't found by Claude's launcher).

**Windows** (escape backslashes as `\\`):
```json
{
  "mcpServers": {
    "ampera-mission-control": {
      "command": "node",
      "args": ["C:\\Users\\YOU\\ampera-mission-control-mcp\\index.mjs"],
      "env": {
        "MISSION_CONTROL_URL": "https://missioncontrol.amperaglobal.com",
        "MISSION_CONTROL_API_KEY": "amc_paste-your-key-here"
      }
    }
  }
}
```

**macOS / Linux:**
```json
{
  "mcpServers": {
    "ampera-mission-control": {
      "command": "node",
      "args": ["/Users/you/ampera-mission-control-mcp/index.mjs"],
      "env": {
        "MISSION_CONTROL_URL": "https://missioncontrol.amperaglobal.com",
        "MISSION_CONTROL_API_KEY": "amc_paste-your-key-here"
      }
    }
  }
}
```
If you already have other MCP servers (e.g. ServiceDesk), add `ampera-mission-control` as a **sibling key** inside the same `mcpServers` object.

> **If Claude can't find `node`** (rare on Windows, common with `nvm` on macOS): use the absolute path to node instead of `"node"` — find it with `where node` (Windows) or `which node` (macOS/Linux).

## 4. Restart & use

Fully **quit** Claude — on **Windows** that means right-click the **system-tray** icon → **Quit** (closing the window just minimizes it). Reopen and start a **new** conversation. The AI Assistant page shows **"Connected via Cowork"** after the first call.

Try: *"What's my Mission Control scan state?"* · *"Log a decision: …"* · *"File a risk: … severity 3, likelihood 4"* · or run the **`mc:morning-scan`** prompt.

## Troubleshooting

- **"Server disconnected" right away** → check the log: `%APPDATA%\Claude\logs\mcp-server-ampera-mission-control.log` (Windows) or `~/Library/Logs/Claude/mcp-server-ampera-mission-control.log` (macOS).
  - `spawn … ENOENT` → wrong `command`/path; use `node` + the absolute `index.mjs` path as above.
  - `Cannot find module '@modelcontextprotocol/sdk'` → run `npm install` in this folder.
  - `… env vars are required` → the `env` block isn't reaching it; check your JSON.
- **Verify manually** (it should print `ampera-mission-control MCP ready (...)` then hang):
  ```bash
  MISSION_CONTROL_URL=https://missioncontrol.amperaglobal.com MISSION_CONTROL_API_KEY=amc_… node index.mjs
  ```
- **Tool calls fail but it connects** → you're likely off the VPN/office network, or your key was revoked.

## What's exposed

- **65 tools** — reads (dashboard, tasks, initiatives, procurements, risks, scan-state, today, pending-reviews, full list/get for tasks, projects, initiatives, procurements, vendors, people, decisions, risks; lookups, org search, briefing) and role-scoped writes incl. full create/update for tasks (priority, assignee, tags, subtasks, blockers + bulk updates), initiatives, projects, procurements, vendors, people, decisions, risks, and glossary.
- **7 prompts** — `mc:morning-scan`, `log-decision`, `triage-reviews`, `initiative-status`, `weekly-briefing`, `end-of-day`, `migrate-from-cowork`.
- **3 resources** — `mission-control://guide`, `mission-control://me`, `mission-control://glossary`.

Everything is enforced server-side by your role. Revoke a key anytime on the AI Assistant page.
