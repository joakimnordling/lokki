export function stats(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b),
    n = s.length,
    tot = vals.reduce((a, b) => a + b, 0),
    mean = tot / n;
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  return { min: s[0], max: s[n - 1], mean, med, tot, sd };
}
// Pearson correlation of two equally long series; null with fewer than 5 pairs or no variation.
export function pearson(a, b) {
  const n = a.length;
  if (n < 5) return null;
  let ma = 0,
    mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let c = 0,
    va = 0,
    vb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma,
      y = b[i] - mb;
    c += x * y;
    va += x * x;
    vb += y * y;
  }
  if (!va || !vb) return null;
  return c / Math.sqrt(va * vb);
}
