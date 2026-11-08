// The chart: a canvas painted over a horizontal scroller, so only the visible bars are drawn.
import { fmt, MON } from "../core/format.js";
import { textScale } from "../core/prefs.js";
import { ui } from "../data/state.js";
import { detailRender } from "./detail.js";
import { $ } from "./dom.js";

// Scroll position to keep on the next redraw (instead of jumping to the selected point).
export const chartScroll = { keep: null };

export function drawChart(ser) {
  const sc = $("#chart"),
    cv = $("#cv"),
    sp = $("#spacer");
  if (!sc) return;
  const css = getComputedStyle(document.documentElement);
  const col = {
    bar: css.getPropertyValue("--bar").trim(),
    sel: css.getPropertyValue("--bar-sel").trim(),
    fg: css.getPropertyValue("--fg").trim(),
    dim: css.getPropertyValue("--fg-dim").trim(),
    line: css.getPropertyValue("--line").trim(),
  };
  const bars = ui.mode === "totals";
  const step = bars ? 14 : ui.mode === "all" ? 7 : 12;
  const AX = 42,
    PAD = 10;
  const W = sc.clientWidth,
    H = sc.clientHeight;
  const contentW = Math.max(W, ser.length * step + PAD * 2 + AX);
  sp.style.width = `${contentW}px`;
  const vals = ser.map((x) => x.v);
  let mx = Math.max(...vals),
    mn = bars ? 0 : Math.min(...vals);
  if (!ser.length) {
    mx = 1;
    mn = 0;
  }
  if (mx === mn) {
    mx += 1;
    mn = bars ? 0 : mn - 1;
  }
  const top = 10,
    bot = H - 22;
  const y = (v) => bot - ((v - mn) / (mx - mn)) * (bot - top);
  const xOf = (i) => PAD + i * step + step / 2;
  // x-axis labels sit on calendar boundaries (month / quarter / year...), chosen once for the whole series so they scroll with the bars
  const mi = (t) => {
    const d = new Date(t);
    return d.getFullYear() * 12 + d.getMonth();
  };
  const labels = [];
  if (ser.length) {
    const span = Math.max(1, mi(ser[ser.length - 1].t) - mi(ser[0].t) + 1),
      bpm = ser.length / span;
    const unit = [1, 3, 6, 12, 24, 60, 120].find((u) => bpm * u * step >= 64) || 120;
    let last = -1e9,
      prev = null;
    for (let i = 0; i < ser.length; i++) {
      const k = Math.floor(mi(ser[i].t) / unit);
      if (k === prev) continue;
      prev = k;
      const x = xOf(i);
      if (x - last >= 56) {
        const d = new Date(ser[i].t);
        labels.push([i, unit >= 12 ? String(d.getFullYear()) : `${MON[d.getMonth()]} ${d.getFullYear()}`]);
        last = x;
      }
    }
  }
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const g = cv.getContext("2d");
  const paint = () => {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const off = sc.scrollLeft;
    const i0 = Math.max(0, Math.floor((off - PAD) / step) - 2),
      i1 = Math.min(ser.length - 1, Math.ceil((off + W - PAD) / step) + 2);
    g.strokeStyle = col.line;
    g.lineWidth = 1;
    for (const yy of [top, (top + bot) / 2, bot]) {
      g.beginPath();
      g.moveTo(0, yy + 0.5);
      g.lineTo(W - AX, yy + 0.5);
      g.stroke();
    }
    g.save();
    g.beginPath();
    g.rect(0, 0, W - AX, H);
    g.clip();
    if (bars) {
      for (let i = i0; i <= i1; i++) {
        const x = xOf(i) - off,
          yy = y(ser[i].v);
        g.fillStyle = i === ui.sel ? col.sel : col.bar;
        g.fillRect(x - (step - 4) / 2, yy, step - 4, Math.max(1, bot - yy));
      }
    } else if (ser.length) {
      g.strokeStyle = col.bar;
      g.lineWidth = 2;
      g.lineJoin = "round";
      g.beginPath();
      for (let i = i0; i <= i1; i++) {
        const x = xOf(i) - off,
          yy = y(ser[i].v);
        i === i0 ? g.moveTo(x, yy) : g.lineTo(x, yy);
      }
      g.stroke();
      const grad = g.createLinearGradient(0, top, 0, bot);
      grad.addColorStop(0, "rgba(255,255,255,.22)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.lineTo(xOf(i1) - off, bot);
      g.lineTo(xOf(i0) - off, bot);
      g.closePath();
      g.fillStyle = grad;
      g.fill();
    }
    if (ui.sel != null && ser[ui.sel] && !bars) {
      const x = xOf(ui.sel) - off,
        yy = y(ser[ui.sel].v);
      g.fillStyle = col.sel;
      g.beginPath();
      g.arc(x, yy, 4.5, 0, 7);
      g.fill();
    }
    // x labels
    g.fillStyle = col.dim;
    g.strokeStyle = col.line;
    g.lineWidth = 1;
    g.font = `${Math.round(10 * textScale())}px ${css.getPropertyValue("--font")}`;
    g.textAlign = "center";
    for (const [i, txt] of labels) {
      const x = xOf(i) - off;
      if (x < -60 || x > W + 60) continue;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, bot);
      g.lineTo(Math.round(x) + 0.5, bot + 4);
      g.stroke();
      g.fillText(txt, x, H - 6);
    }
    g.restore();
    g.fillStyle = col.fg;
    g.textAlign = "right";
    g.font = `${Math.round(11 * textScale())}px ${css.getPropertyValue("--font")}`;
    g.fillText(fmt(mx), W - 2, top + 4);
    g.fillText(fmt((mx + mn) / 2), W - 2, (top + bot) / 2 + 4);
    g.fillText(fmt(mn), W - 2, bot + 4);
  };
  sc.onscroll = () => requestAnimationFrame(paint);
  sc.onclick = (ev) => {
    const r = sc.getBoundingClientRect();
    const x = ev.clientX - r.left + sc.scrollLeft;
    const i = Math.round((x - PAD - step / 2) / step);
    if (i >= 0 && i < ser.length) {
      ui.sel = i;
      chartScroll.keep = sc.scrollLeft;
      detailRender();
    }
  };
  sc.onkeydown = (ev) => {
    if (ev.key === "ArrowLeft" && ui.sel > 0) {
      ui.sel--;
      detailRender();
      $("#chart").focus();
    } else if (ev.key === "ArrowRight" && ui.sel < ser.length - 1) {
      ui.sel++;
      detailRender();
      $("#chart").focus();
    }
  };
  // keep the selected point visible
  const target = xOf(ui.sel ?? ser.length - 1);
  if (chartScroll.keep != null) {
    sc.scrollLeft = chartScroll.keep;
    chartScroll.keep = null;
  } else sc.scrollLeft = Math.max(0, target - (W - AX) * 0.75);
  paint();
}
