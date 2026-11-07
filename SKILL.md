---
name: desmos-graphing
description: Use whenever the user wants to graph, plot, visualize, or explore math (functions, equations, inequalities, parametric or polar curves, data and regressions, sliders, animations, 3D surfaces) or mentions Desmos. Explains Desmos LaTeX syntax and the create → check → fix workflow for the desmos MCP tools.
---

# Graphing with Desmos

You have live Desmos tools from the `desmos` MCP server. Graphs open in the user's browser and stay in sync: every update you make appears immediately, and the page reports Desmos's own error messages and numeric evaluations back to you.

## Workflow

1. **Plan** the expressions. Give each one a short, meaningful `id` (`f`, `deriv`, `tangent`, `slider-a`) so you can update it later.
2. **Create** with `desmos_create_graph`. Set a `viewport` that frames the interesting part, since the default ±10 window often hides it.
3. **Check** with `desmos_get_graph`. Fix every `ERROR` line with `desmos_update_graph` (upsert by the same id), then check again. Don't tell the user a graph is done while errors remain.
4. **Look** with `desmos_screenshot` when correctness depends on the picture (framing, intersections, shading, whether a curve is visible at all).
5. **Iterate** with `desmos_update_graph` rather than creating a new graph, unless the user wants a separate one.
6. If the user says they changed something in the browser, `desmos_get_graph` shows their edits (moved sliders, typed expressions). Build on those.

Use `desmos_export_html` when the user wants a file to share or embed.

## Desmos LaTeX essentials

Remember that backslashes must be escaped in JSON: write `"y=\\sin(x)"`.

| Want | Desmos LaTeX |
|---|---|
| Function | `f(x)=x^{2}-3x+1` |
| Fraction, root | `\frac{1}{x}`, `\sqrt{x}`, `\sqrt[3]{x}` |
| Trig, logs | `\sin(x)`, `\arctan(x)`, `\ln(x)`, `\log(x)`, `\log_{2}(x)` |
| Absolute value | `\left|x\right|` or `\operatorname{abs}(x)` |
| Exponent grouping | `e^{-x^{2}}` (always brace multi-char exponents) |
| Slider | `a=1` on its own line, then use `a` elsewhere. Set `sliderBounds` `{min:"-5",max:"5",step:"0.1"}` |
| Point | `(2,3)`, or labeled with `label` + `showLabel:true` |
| Movable point | `(a,f(a))` with `a` a slider |
| Domain restriction | `y=x^{2}\left\{-1<x<2\right\}` |
| Piecewise | `f(x)=\left\{x<0:-x,x\ge0:x^{2}\right\}` |
| Inequality (shaded) | `y\le\sin(x)`, `x^{2}+y^{2}<4` |
| Implicit | `x^{2}+y^{2}=9` |
| Parametric | `(\cos(t),\sin(2t))` (uses `t`; Desmos's default range is 0 to 1, so set the expression's `parametricDomain` `{min:"0",max:"2\\pi"}`) |
| Polar | `r=1+\cos(\theta)` |
| Derivative | `\frac{d}{dx}f(x)` or `f'(x)` |
| Integral | `\int_{0}^{x}\sin(t)dt` |
| Sum | `\sum_{n=1}^{10}\frac{1}{n^{2}}` |
| List | `L=[1,2,3,4]`, `[1...10]`, points `(L,L^{2})` |
| Multi-letter functions | `\operatorname{mean}(L)`, `\operatorname{sort}(L)`, `\operatorname{floor}(x)`, `\operatorname{mod}(a,b)` |
| Comparison operators | `\le`, `\ge`, `<`, `>` |
| Subscripted variables | `x_{1}`, `a_{0}` (single-letter variable names only, plus subscripts) |

**Variables must be single letters** (optionally with subscripts). `rate=2` is an error; use `r=2` or `r_{ate}=2`.

### Tables and regressions

```json
{"id":"data","type":"table","columns":[
  {"latex":"x_{1}","values":["1","2","3","4"]},
  {"latex":"y_{1}","values":["2.1","3.9","6.2","7.8"]}]}
{"id":"fit","latex":"y_{1}\\sim mx_{1}+b"}
```
The fitted parameters (`m`, `b`) show in the browser under the regression. To get them into your own context, add evaluation expressions `m` and `b` after the regression and read them from `desmos_get_graph`.

### Evaluations
An expression without `y=` or `=` that evaluates to a number (e.g. `f(2)`, `\int_{0}^{1}x^{2}dx`) comes back from `desmos_get_graph` as `= value`. You can use this to compute with Desmos and confirm numbers you tell the user.

### Notes
`{"type":"text","text":"Drag a to move the tangent line"}` adds a note in the expression list.

### Styling
`color` hex (`#c74440` red, `#2d70b3` blue, `#388c46` green, `#6042a6` purple, `#fa7e19` orange, `#000000` black), `lineStyle` `DASHED`/`DOTTED`, `lineWidth`, `fillOpacity` for shaded regions, `hidden:true` for helper definitions.

### Settings
Pass via `settings`: `{"degreeMode":true}`, `{"showGrid":false}`, `{"xAxisLabel":"time (s)","yAxisLabel":"height (m)"}`, `{"xAxisStep":1}`, `{"polarMode":true}`.

## 3D graphs

Use `mode:"3d"`. Surfaces are `z=f(x,y)` (e.g. `z=\sin(x)\cos(y)`), points are `(1,2,3)`, implicit surfaces like `x^{2}+y^{2}+z^{2}=4`. Viewport accepts `zmin`/`zmax`.

## Good habits

- Define functions once (`f(x)=...`) and reuse them (`f'(x)`, `(a,f(a))`) instead of repeating formulas.
- Hide helper definitions; keep the visible list short and labeled.
- For teaching, add a slider so the user can explore, and a text note explaining what to drag.
- When an expression errors, read Desmos's message: the usual culprits are multi-letter variables, missing braces in exponents, unescaped backslashes, and undefined names.
