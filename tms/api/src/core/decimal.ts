/**
 * Arithmétique décimale en centimes (BigInt) : aucun calcul financier en virgule flottante.
 */
export function toCents(v: string | number): bigint {
  const s = typeof v === 'number' ? v.toFixed(4) : v.trim();
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const frac4 = (f + '0000').slice(0, 4);
  // arrondi commercial au centime (half up) sur 4 décimales
  let cents = BigInt(i || '0') * 100n + BigInt(frac4.slice(0, 2));
  if (Number(frac4[2]) >= 5) cents += 1n;
  return neg ? -cents : cents;
}
export function fromCents(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
}
/** quantité × prix unitaire (4 décimales chacun) arrondi au centime. */
export function mulToCents(qty: string, unit: string): bigint {
  const scale = (s: string) => { const [i, f = ''] = s.trim().split('.'); return BigInt((i || '0') + (f + '0000').slice(0, 4)); };
  const p = scale(qty) * scale(unit); // échelle 10^8
  const neg = p < 0n; const a = neg ? -p : p;
  const cents = (a + 500000n) / 1000000n;
  return neg ? -cents : cents;
}
/** base × taux% arrondi au centime (taux "20.00"). */
export function pctOfCents(baseCents: bigint, rate: string): bigint {
  const r = toCents(rate); // taux ×100
  const p = baseCents * r; // échelle 10^4
  const neg = p < 0n; const a = neg ? -p : p;
  const c = (a + 5000n) / 10000n;
  return neg ? -c : c;
}
