#!/usr/bin/env node
// Desmos MCP server for Claude — zero dependencies, Node >= 18.
// Speaks MCP over stdio and runs a small local web server that hosts live
// Desmos calculators. The browser page reports errors, evaluations and
// screenshots back here so Claude can check and iterate on its graphs.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { renderPage } = require('./page');

const API_KEY = process.env.DESMOS_API_KEY || 'dcb31709b452b1cf9dc26972add0fda6'; // Desmos public demo key (development only)
const API_VERSION = process.env.DESMOS_API_VERSION || 'v1.11';
const PREFERRED_PORT = parseInt(process.env.DESMOS_PORT || '7878', 10);
const DATA_DIR = process.env.DESMOS_DATA_DIR || path.join(os.homedir(), '.claude-desmos');
const AUTO_OPEN = process.env.DESMOS_AUTO_OPEN !== 'false';

const log = (...a) => process.stderr.write('[desmos] ' + a.join(' ') + '\n');
fs.mkdirSync(path.join(DATA_DIR, 'graphs'), { recursive: true });

// ---------------------------------------------------------------- storage
const graphs = new Map();        // id -> spec
const clientInfo = new Map();    // id -> { analysis, expressions, receivedAt }
const sseClients = new Map();    // id -> Set<res>
const pendingShots = new Map();  // requestId -> { resolve, timer }

function specPath(id) { return path.join(DATA_DIR, 'graphs', id + '.json'); }
function save(spec) { fs.writeFileSync(specPath(spec.id), JSON.stringify(spec, null, 2)); }
for (const f of fs.readdirSync(path.join(DATA_DIR, 'graphs'))) {
  if (!f.endsWith('.json')) continue;
  try { const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'graphs', f), 'utf8')); graphs.set(s.id, s); } catch {}
}

function slug(s) {
  return (s || 'graph').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'graph';
}
function newId(title) { return slug(title) + '-' + crypto.randomBytes(3).toString('hex'); }

function normalizeExpressions(list) {
  return (list || []).map((e, i) => {
    if (typeof e === 'string') e = { latex: e };
    return { id: e.id || 'e' + (i + 1) + '-' + crypto.randomBytes(2).toString('hex'), ...e };
  });
}

function resolveGraph(ref) {
  if (!ref) {
    const all = [...graphs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!all.length) throw new Error('No graphs exist yet. Call desmos_create_graph first.');
    return all[0];
  }
  const g = graphs.get(ref) || [...graphs.values()].find(x => x.title && x.title.toLowerCase() === String(ref).toLowerCase());
  if (!g) throw new Error(`Graph "${ref}" not found. Use desmos_list_graphs to see ids.`);
  return g;
}

// ---------------------------------------------------------------- http/sse
let port = null;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && parts[0] === 'g' && parts[1]) {
      const g = graphs.get(parts[1]);
      if (!g) return send(res, 404, 'text/plain', 'Graph not found');
      return send(res, 200, 'text/html; charset=utf-8',
        renderPage(g, { live: true, apiKey: API_KEY, apiVersion: API_VERSION }));
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'graph' && parts[2] && !parts[3]) {
      const g = graphs.get(parts[2]);
      return g ? send(res, 200, 'application/json', JSON.stringify(g)) : send(res, 404, 'application/json', '{}');
    }
    if (req.method === 'GET' && parts[0] === 'events' && parts[1]) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      if (!sseClients.has(parts[1])) sseClients.set(parts[1], new Set());
      sseClients.get(parts[1]).add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); sseClients.get(parts[1])?.delete(res); });
      return;
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'graph' && parts[3] === 'client') {
      const body = JSON.parse(await readBody(req));
      clientInfo.set(parts[2], { ...body, receivedAt: new Date().toISOString() });
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'screenshot' && parts[2]) {
      const body = JSON.parse(await readBody(req));
      const p = pendingShots.get(parts[2]);
      if (p) { clearTimeout(p.timer); pendingShots.delete(parts[2]); p.resolve(body); }
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const items = [...graphs.values()].map(g => `<li><a href="/g/${g.id}">${escapeHtml(g.title)}</a> <small>${g.id}</small></li>`).join('');
      return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><title>Desmos for Claude</title><h1>Graphs</h1><ul>${items || '<li>None yet</li>'}</ul>`);
    }
    send(res, 404, 'text/plain', 'Not found');
  } catch (err) {
    send(res, 500, 'text/plain', String(err));
  }
});

function send(res, code, type, body) { res.writeHead(code, { 'Content-Type': type }); res.end(body); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 25e6) req.destroy(); });
    req.on('end', () => resolve(d || '{}')); req.on('error', reject);
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function broadcast(id, event, data) {
  for (const res of sseClients.get(id) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function viewerCount(id) { return (sseClients.get(id) || new Set()).size; }

function listen(p) {
  return new Promise((resolve) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && p !== 0) { log(`port ${p} busy, picking a random port`); resolve(listen(0)); }
      else { log('http error', e.message); resolve(null); }
    });
    server.listen(p, '127.0.0.1', () => resolve(server.address().port));
  });
}

function graphUrl(id) { return `http://127.0.0.1:${port}/g/${id}`; }
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); return true; } catch { return false; }
}

// ---------------------------------------------------------------- tools
const exprSchema = {
  type: 'object',
  description: 'A Desmos expression. Most fields mirror Desmos setExpression().',
  properties: {
    id: { type: 'string', description: 'Stable id; reuse it to replace this expression later.' },
    type: { type: 'string', enum: ['expression', 'table', 'text'], default: 'expression' },
    latex: { type: 'string', description: 'Desmos LaTeX, e.g. "y=\\\\sin(x)", "a=2", "(1,2)".' },
    text: { type: 'string', description: 'Note text (type "text" only).' },
    columns: {
      type: 'array', description: 'Table columns (type "table" only).',
      items: { type: 'object', properties: { latex: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } } },
    },
    color: { type: 'string', description: 'Hex color like "#c74440".' },
    hidden: { type: 'boolean' },
    lineStyle: { type: 'string', enum: ['SOLID', 'DASHED', 'DOTTED'] },
    lineWidth: { type: 'number' },
    pointStyle: { type: 'string', enum: ['POINT', 'OPEN', 'CROSS', 'SQUARE', 'PLUS', 'TRIANGLE', 'DIAMOND', 'STAR'] },
    fillOpacity: { type: 'number' },
    label: { type: 'string' },
    showLabel: { type: 'boolean' },
    sliderBounds: { type: 'object', properties: { min: { type: 'string' }, max: { type: 'string' }, step: { type: 'string' } } },
    playing: { type: 'boolean', description: 'Animate a slider.' },
    parametricDomain: { type: 'object', description: 'Range of t for parametric curves, e.g. {"min":"0","max":"2\\pi"}.', properties: { min: { type: 'string' }, max: { type: 'string' } } },
    polarDomain: { type: 'object', description: 'Range of theta for polar curves.', properties: { min: { type: 'string' }, max: { type: 'string' } } },
  },
};
const viewportSchema = {
  type: 'object', description: 'Visible math bounds.',
  properties: { xmin: { type: 'number' }, xmax: { type: 'number' }, ymin: { type: 'number' }, ymax: { type: 'number' }, zmin: { type: 'number' }, zmax: { type: 'number' } },
};

const tools = [
  {
    name: 'desmos_create_graph',
    description: 'Create a new Desmos graph and open it live in the browser. Afterwards call desmos_get_graph to check for LaTeX errors.',
    inputSchema: {
      type: 'object', required: ['expressions'],
      properties: {
        title: { type: 'string' },
        mode: { type: 'string', enum: ['2d', '3d'], default: '2d' },
        expressions: { type: 'array', items: exprSchema },
        viewport: viewportSchema,
        settings: { type: 'object', description: 'Passed to updateSettings, e.g. {"degreeMode":true,"showGrid":false,"xAxisLabel":"t"}.' },
        open: { type: 'boolean', description: 'Open in browser (default true).' },
      },
    },
  },
  {
    name: 'desmos_update_graph',
    description: 'Modify an existing graph. Upserts expressions by id, removes ids, and/or changes viewport/settings. Open browser tabs refresh live.',
    inputSchema: {
      type: 'object',
      properties: {
        graph: { type: 'string', description: 'Graph id or title. Defaults to the most recently updated graph.' },
        title: { type: 'string' },
        upsert: { type: 'array', items: exprSchema, description: 'Expressions to add, or replace if the id exists.' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Expression ids to remove.' },
        replace_all: { type: 'array', items: exprSchema, description: 'Replace the whole expression list.' },
        viewport: viewportSchema,
        settings: { type: 'object' },
      },
    },
  },
  {
    name: 'desmos_get_graph',
    description: 'Read a graph: its expressions plus live feedback from the browser (per-expression errors and numeric evaluations, and any edits the user made, like moved sliders).',
    inputSchema: { type: 'object', properties: { graph: { type: 'string' } } },
  },
  {
    name: 'desmos_screenshot',
    description: 'Capture a PNG of the graph from the open browser tab so you can see what it looks like.',
    inputSchema: {
      type: 'object',
      properties: { graph: { type: 'string' }, width: { type: 'number', default: 800 }, height: { type: 'number', default: 600 } },
    },
  },
  {
    name: 'desmos_list_graphs',
    description: 'List saved graphs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'desmos_export_html',
    description: 'Write a standalone HTML file of the graph that works without this server (good for sharing or embedding).',
    inputSchema: {
      type: 'object', required: ['path'],
      properties: { graph: { type: 'string' }, path: { type: 'string', description: 'Output file path, e.g. ./graph.html' } },
    },
  },
  {
    name: 'desmos_open',
    description: 'Open (or re-open) a graph in the browser.',
    inputSchema: { type: 'object', properties: { graph: { type: 'string' } } },
  },
];

function touch(g) { g.updatedAt = new Date().toISOString(); g.rev = (g.rev || 0) + 1; save(g); broadcast(g.id, 'update', { rev: g.rev }); }

const handlers = {
  async desmos_create_graph(a) {
    const id = newId(a.title);
    const g = {
      id, title: a.title || 'Untitled graph', mode: a.mode === '3d' ? '3d' : '2d',
      expressions: normalizeExpressions(a.expressions), viewport: a.viewport || null, settings: a.settings || {},
      createdAt: new Date().toISOString(),
    };
    graphs.set(id, g); touch(g);
    const url = graphUrl(id);
    const opened = a.open !== false && AUTO_OPEN && openBrowser(url);
    return text(`Created graph "${g.title}" (id: ${id}) with ${g.expressions.length} expression(s).\nURL: ${url}\n` +
      (opened ? 'Opened in the browser. ' : 'Not opened automatically; share the URL. ') +
      'Call desmos_get_graph in a moment to check for errors.');
  },

  async desmos_update_graph(a) {
    const g = resolveGraph(a.graph);
    if (a.title) g.title = a.title;
    if (a.replace_all) g.expressions = normalizeExpressions(a.replace_all);
    if (a.remove) g.expressions = g.expressions.filter(e => !a.remove.includes(e.id));
    for (const e of normalizeExpressions(a.upsert)) {
      const i = g.expressions.findIndex(x => x.id === e.id);
      if (i >= 0) g.expressions[i] = e; else g.expressions.push(e);
    }
    if (a.viewport) g.viewport = { ...(g.viewport || {}), ...a.viewport };
    if (a.settings) g.settings = { ...g.settings, ...a.settings };
    clientInfo.delete(g.id);
    touch(g);
    return text(`Updated "${g.title}" (rev ${g.rev}); ${g.expressions.length} expression(s). ` +
      `${viewerCount(g.id)} browser tab(s) refreshed.`);
  },

  async desmos_get_graph(a) {
    const g = resolveGraph(a.graph);
    const c = clientInfo.get(g.id);
    const lines = [`Graph "${g.title}" (id ${g.id}, ${g.mode}, rev ${g.rev})`, `URL: ${graphUrl(g.id)}`, '', 'Expressions:'];
    for (const e of g.expressions) {
      const an = c?.analysis?.[e.id];
      let status = '';
      if (an?.isError) status = `  ❌ ERROR: ${an.errorMessage}`;
      else if (an?.evaluation) status = `  = ${JSON.stringify(an.evaluation.value)}`;
      lines.push(`- [${e.id}] ${e.type && e.type !== 'expression' ? `(${e.type}) ` : ''}${e.latex ?? e.text ?? ''}${status}`);
    }
    if (!c) {
      lines.push('', viewerCount(g.id)
        ? 'Browser is open but has not reported yet; try again in a second.'
        : 'No browser tab is open, so errors cannot be checked. Use desmos_open.');
    } else {
      const userEdits = (c.expressions || []).filter(ce => {
        const orig = g.expressions.find(e => e.id === ce.id);
        return !orig || (ce.latex && orig.latex !== ce.latex);
      });
      if (userEdits.length) {
        lines.push('', 'Edits made by the user in the browser:');
        for (const ce of userEdits) lines.push(`- [${ce.id}] ${ce.latex}`);
      }
      const errs = Object.values(c.analysis || {}).filter(x => x.isError).length;
      lines.push('', errs ? `${errs} expression(s) have errors.` : 'No errors reported by Desmos.');
    }
    return text(lines.join('\n'));
  },

  async desmos_screenshot(a) {
    const g = resolveGraph(a.graph);
    if (!viewerCount(g.id)) {
      if (AUTO_OPEN) openBrowser(graphUrl(g.id));
      await new Promise(r => setTimeout(r, 4000));
      if (!viewerCount(g.id)) return text('No browser tab is connected for this graph, so no screenshot is possible. Use desmos_open.', true);
    }
    const reqId = crypto.randomBytes(6).toString('hex');
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { pendingShots.delete(reqId); resolve(null); }, 15000);
      pendingShots.set(reqId, { resolve, timer });
      broadcast(g.id, 'screenshot', { reqId, width: a.width || 800, height: a.height || 600 });
    });
    if (!result || !result.dataUrl) return text('Screenshot timed out or failed' + (result?.error ? `: ${result.error}` : '.'), true);
    const b64 = result.dataUrl.replace(/^data:image\/png;base64,/, '');
    return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }, { type: 'text', text: `Screenshot of "${g.title}".` }] };
  },

  async desmos_list_graphs() {
    const all = [...graphs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!all.length) return text('No graphs yet.');
    return text(all.map(g => `- ${g.title} (id ${g.id}, ${g.mode}, ${g.expressions.length} expr, updated ${g.updatedAt}) ${graphUrl(g.id)}`).join('\n'));
  },

  async desmos_export_html(a) {
    const g = resolveGraph(a.graph);
    const out = path.resolve(a.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderPage(g, { live: false, apiKey: API_KEY, apiVersion: API_VERSION }));
    return text(`Wrote standalone graph to ${out}`);
  },

  async desmos_open(a) {
    const g = resolveGraph(a.graph);
    const url = graphUrl(g.id);
    return text(openBrowser(url) ? `Opened ${url}` : `Could not launch a browser. Open this URL: ${url}`);
  },
};

function text(t, isError = false) { return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) }; }

// ---------------------------------------------------------------- MCP stdio
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function replyErr(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'desmos', version: '1.0.0' },
        instructions: 'Tools for drawing and checking Desmos graphs. After creating or updating a graph, call desmos_get_graph to see errors.',
      });
    case 'ping': return reply(id, {});
    case 'tools/list': return reply(id, { tools });
    case 'tools/call': {
      const h = handlers[params?.name];
      if (!h) return replyErr(id, -32602, `Unknown tool ${params?.name}`);
      try { return reply(id, await h(params.arguments || {})); }
      catch (e) { return reply(id, text(e.message || String(e), true)); }
    }
    default: return replyErr(id, -32601, `Method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { replyErr(null, -32700, 'Parse error'); continue; }
    handle(msg).catch(e => log('handler error', e.stack));
  }
});
process.stdin.on('end', () => process.exit(0));

listen(PREFERRED_PORT).then((p) => { port = p; log(`live graphs at http://127.0.0.1:${p}/`); });
