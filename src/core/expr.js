// The value field accepts simple arithmetic: 5,5 or 2+3 or (10-2)×1,5. Returns null for anything else.
export function evalExpr(str) {
  const src = String(str)
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .replace(/[×x*]/g, "*")
    .replace(/[÷/]/g, "/")
    .replace(/[−–]/g, "-");
  if (!src) return null;
  let i = 0;
  const num = () => {
    const m = /^\d*\.?\d+(e[+-]?\d+)?|^\d+\./i.exec(src.slice(i));
    if (!m) throw 0;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const fac = () => {
    if (src[i] === "-") {
      i++;
      return -fac();
    }
    if (src[i] === "+") {
      i++;
      return fac();
    }
    if (src[i] === "(") {
      i++;
      const v = add();
      if (src[i] !== ")") throw 0;
      i++;
      return v;
    }
    return num();
  };
  const mul = () => {
    let v = fac();
    while (src[i] === "*" || src[i] === "/") {
      const o = src[i++],
        r = fac();
      v = o === "*" ? v * r : v / r;
    }
    return v;
  };
  const add = () => {
    let v = mul();
    while (src[i] === "+" || src[i] === "-") {
      const o = src[i++],
        r = mul();
      v = o === "+" ? v + r : v - r;
    }
    return v;
  };
  try {
    const v = add();
    if (i !== src.length || !Number.isFinite(v)) return null;
    return Math.round(v * 1e6) / 1e6;
  } catch (_e) {
    return null;
  }
}
