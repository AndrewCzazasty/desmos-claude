'use strict';
// Renders the browser page that hosts a Desmos calculator.
// live=true  -> page subscribes to the MCP server (SSE) and reports errors/screenshots back.
// live=false -> fully standalone snapshot with the spec embedded.

function renderPage(spec, { live, apiKey, apiVersion }) {
  const specJson = JSON.stringify(spec).replace(/</g, '\\u003c');
  const title = String(spec.title || 'Desmos graph').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --line:#deded8; --accent:#2d70b3; --bad:#c74440; --good:#388c46; }
  @media (prefers-color-scheme: dark) {
    :root { color-scheme: dark; --bg:#1b1b1a; --fg:#ececea; --muted:#9a9a94; --line:#33332f; --accent:#6aa3dc; --bad:#e2726e; --good:#6cbf78; }
  }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:14px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px; border-bottom:1px solid var(--line); }
  h1 { font-size:15px; font-weight:600; margin:0; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #status { color:var(--muted); font-size:12px; }
  #status.bad { color:var(--bad); } #status.good { color:var(--good); }
  button { font:inherit; font-size:12px; padding:5px 10px; border-radius:6px; border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; }
  button:hover { border-color:var(--accent); color:var(--accent); }
  #calc { position:absolute; top:49px; left:0; right:0; bottom:0; }
</style>
</head>
<body>
<header>
  <h1 id="title">${title}</h1>
  <span id="status">${live ? 'connecting…' : 'snapshot'}</span>
  <button id="copy" title="Copy Desmos state JSON (paste into the Desmos console with Calc.setState)">Copy state</button>
  <button id="png">Download PNG</button>
</header>
<div id="calc"></div>
<script src="https://www.desmos.com/api/${apiVersion}/calculator.js?apiKey=${apiKey}"></script>
<script>
(function () {
  var LIVE = ${live ? 'true' : 'false'};
  var spec = ${specJson};
  var statusEl = document.getElementById('status');
  var el = document.getElementById('calc');
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  if (!window.Desmos) { statusEl.textContent = 'Could not load Desmos (offline or bad API key)'; statusEl.className = 'bad'; return; }

  var calc = spec.mode === '3d'
    ? Desmos.Calculator3D(el, { invertedColors: dark })
    : Desmos.GraphingCalculator(el, { invertedColors: dark });
  window.Calc = calc;
  var localErrors = {};

  function styleConst(v) { return (v && Desmos.Styles && Desmos.Styles[v]) || (v && String(v).toLowerCase()); }

  function clean(e) {
    var o = {};
    ['id','type','latex','text','color','hidden','lineWidth','lineOpacity','pointSize','pointOpacity',
     'fillOpacity','label','showLabel','sliderBounds','playing','secret','fill','points','lines','parametricDomain','polarDomain','dragMode'].forEach(function (k) {
      if (e[k] !== undefined && e[k] !== null) o[k] = e[k];
    });
    if (e.lineStyle) o.lineStyle = styleConst(e.lineStyle);
    if (e.pointStyle) o.pointStyle = styleConst(e.pointStyle);
    if (e.type === 'table' && e.columns) {
      o.columns = e.columns.map(function (c) {
        var col = { latex: c.latex, values: (c.values || []).map(String) };
        if (c.color) col.color = c.color;
        if (c.hidden !== undefined) col.hidden = c.hidden;
        if (c.points !== undefined) col.points = c.points;
        if (c.lines !== undefined) col.lines = c.lines;
        return col;
      });
    }
    if (!o.type) o.type = 'expression';
    return o;
  }

  function render(s) {
    spec = s;
    document.title = s.title || 'Desmos graph';
    document.getElementById('title').textContent = s.title || 'Desmos graph';
    localErrors = {};
    calc.setBlank();
    (s.expressions || []).forEach(function (e) {
      try { calc.setExpression(clean(e)); }
      catch (err) { localErrors[e.id] = { isError: true, errorMessage: 'Rejected by setExpression: ' + err.message }; }
    });
    try { if (s.settings && Object.keys(s.settings).length) calc.updateSettings(s.settings); }
    catch (err) { localErrors._settings = { isError: true, errorMessage: 'Bad settings: ' + err.message }; }
    if (s.viewport) {
      var v = s.viewport, b = {};
      ['xmin','xmax','ymin','ymax','zmin','zmax'].forEach(function (k) { if (typeof v[k] === 'number') b[k] = v[k]; });
      try { calc.setMathBounds(b); } catch (err) { localErrors._viewport = { isError: true, errorMessage: 'Bad viewport: ' + err.message }; }
    }
    setTimeout(report, 400);
  }

  function analysis() {
    var a = {};
    try { var ea = calc.expressionAnalysis || {}; Object.keys(ea).forEach(function (k) { a[k] = ea[k]; }); } catch (e) {}
    Object.keys(localErrors).forEach(function (k) { a[k] = localErrors[k]; });
    return a;
  }

  var reportTimer = null;
  function report() {
    var a = analysis();
    var errs = Object.keys(a).filter(function (k) { return a[k] && a[k].isError; }).length;
    if (LIVE) {
      statusEl.textContent = errs ? errs + ' error(s)' : 'live · synced with Claude';
      statusEl.className = errs ? 'bad' : 'good';
      var exprs = [];
      try { exprs = calc.getExpressions().map(function (e) { return { id: e.id, type: e.type, latex: e.latex }; }); } catch (e) {}
      fetch('/api/graph/' + spec.id + '/client', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rev: spec.rev, analysis: a, expressions: exprs })
      }).catch(function () {});
    } else if (errs) {
      statusEl.textContent = errs + ' error(s)'; statusEl.className = 'bad';
    }
  }
  function scheduleReport() { clearTimeout(reportTimer); reportTimer = setTimeout(report, 500); }
  try { calc.observe('expressionAnalysis', scheduleReport); } catch (e) {}
  try { calc.observeEvent('change', scheduleReport); } catch (e) {}

  function shoot(w, h, cb) {
    var opts = { width: w, height: h, targetPixelRatio: 2 };
    try {
      if (calc.asyncScreenshot) return calc.asyncScreenshot(Object.assign({ format: 'png' }, opts), function (d) { cb(null, d); });
      cb(null, calc.screenshot(opts));
    } catch (err) { cb(err); }
  }

  document.getElementById('copy').onclick = function () {
    navigator.clipboard.writeText(JSON.stringify(calc.getState())).then(function () {
      statusEl.textContent = 'state copied'; statusEl.className = '';
    });
  };
  document.getElementById('png').onclick = function () {
    shoot(1200, 900, function (err, data) {
      if (err) return alert(err.message);
      var a = document.createElement('a'); a.href = data; a.download = (spec.title || 'graph') + '.png'; a.click();
    });
  };

  render(spec);

  if (LIVE && window.EventSource) {
    var es = new EventSource('/events/' + spec.id);
    es.addEventListener('update', function () {
      fetch('/api/graph/' + spec.id).then(function (r) { return r.json(); }).then(render);
    });
    es.addEventListener('screenshot', function (ev) {
      var d = JSON.parse(ev.data);
      shoot(d.width, d.height, function (err, data) {
        fetch('/api/screenshot/' + d.reqId, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(err ? { error: err.message } : { dataUrl: data })
        });
      });
    });
    es.onerror = function () { statusEl.textContent = 'disconnected from Claude (graph still usable)'; statusEl.className = 'bad'; };
    es.onopen = scheduleReport;
  }
})();
</script>
</body>
</html>`;
}

module.exports = { renderPage };
