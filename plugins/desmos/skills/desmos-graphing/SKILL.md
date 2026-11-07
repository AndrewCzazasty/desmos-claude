# Desmos plugin for Claude

Lets Claude draw live [Desmos](https://www.desmos.com) graphs in your browser, then **check its own work**: the page reports Desmos's error messages, numeric evaluations, your slider tweaks, and screenshots back to Claude so it can fix and refine graphs on its own.

Works in Claude Code and Claude Cowork. Requires Node.js 18+. No npm install, no dependencies.

## What's inside

```
desmos-marketplace/
├── .claude-plugin/marketplace.json      # lets you install it as a marketplace
└── plugins/desmos/
    ├── .claude-plugin/plugin.json       # plugin manifest
    ├── .mcp.json                        # registers the MCP server
    ├── server/index.js                  # MCP server (stdio) + local web bridge
    ├── server/page.js                   # the browser page hosting the calculator
    ├── skills/desmos-graphing/SKILL.md  # Desmos LaTeX syntax + check/fix workflow
    └── commands/graph.md                # /desmos:graph slash command
```

### Tools Claude gets

| Tool | What it does |
|---|---|
| `desmos_create_graph` | New 2D or 3D graph with expressions, sliders, tables, notes, viewport, settings. Opens in your browser. |
| `desmos_update_graph` | Add/replace expressions by id, remove ids, change viewport. Open tabs update live. |
| `desmos_get_graph` | Expressions plus Desmos's per-expression errors and evaluations, and edits you made in the browser. |
| `desmos_screenshot` | PNG of the graph, returned to Claude as an image. |
| `desmos_export_html` | Standalone HTML file that works without the server. |
| `desmos_list_graphs`, `desmos_open` | Housekeeping. |

## Install

**Try it locally:**
```bash
claude --plugin-dir ./desmos-marketplace/plugins/desmos
```

**Install as a marketplace** (local path or a GitHub repo you push this folder to):
```
/plugin marketplace add ./desmos-marketplace
/plugin install desmos@desmos-marketplace
```

Then ask things like:

- "Graph sin(x) with a draggable tangent line"
- "Plot this data and fit a quadratic regression: ..."
- "Show the surface z = x² − y² in 3D"
- `/desmos:graph the region between y=x and y=x² shaded`

## Configuration

Set these environment variables before launching Claude:

| Variable | Default | Purpose |
|---|---|---|
| `DESMOS_API_KEY` | Desmos's public demo key | **Get your own key for anything beyond personal use** at desmos.com/my-api. The demo key is for development only. |
| `DESMOS_PORT` | `7878` | Local port for the live page (falls back to a random port if busy). |
| `DESMOS_API_VERSION` | `v1.11` | Desmos API version to load. |
| `DESMOS_DATA_DIR` | `~/.claude-desmos` | Where graphs are saved between sessions. |
| `DESMOS_AUTO_OPEN` | `true` | Set `false` to stop auto-opening browser tabs. |

## How it works

The MCP server speaks JSON-RPC over stdio to Claude and runs a small web server bound to `127.0.0.1`. Each graph page loads the official Desmos API, renders the spec, and holds a Server-Sent Events connection open. When Claude updates a graph, the page re-renders; when Desmos re-analyses expressions, the page posts errors and evaluations back. Screenshots are requested over the same channel. Error checking and screenshots need the graph open in a browser tab.

The page's **Copy state** button copies the full Desmos state JSON, and **Download PNG** saves a high-resolution image.

## Notes

- The server only listens on localhost, but anything on your machine can reach that port while Claude is running.
- Desmos is a trademark of Desmos Studio PBC. This plugin uses their public embeddable API and is not affiliated with Desmos. Check their API terms before distributing.
