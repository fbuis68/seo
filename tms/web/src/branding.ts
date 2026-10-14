/** Identité visuelle de l'organisme appliquée à l'interface (variables CSS sur <html>). */
export interface Branding { accentColor: string | null; sidebarColor: string | null; docColor: string | null; theme: 'auto' | 'light' | 'dark'; logoUrl: string | null; logoWidth?: number | null; logoHeight?: number | null }

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
/** Rapport de contraste WCAG entre deux couleurs. */
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

const VARS = ['--accent', '--accent-soft', '--side-bg', '--side-fg', '--side-muted', '--side-active-bg', '--side-active-fg'];
export function applyBranding(b: Branding | null) {
  const root = document.documentElement;
  for (const v of VARS) root.style.removeProperty(v);
  if (!b) { root.removeAttribute('data-theme'); return; }
  if (b.theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', b.theme);
  if (b.accentColor) {
    root.style.setProperty('--accent', b.accentColor);
    root.style.setProperty('--accent-soft', `color-mix(in srgb, ${b.accentColor} 14%, var(--panel))`);
  }
  if (b.sidebarColor) {
    // Texte clair ou foncé selon le fond choisi (lisibilité garantie).
    const dark = contrast(b.sidebarColor, '#ffffff') >= contrast(b.sidebarColor, '#14161a');
    root.style.setProperty('--side-bg', b.sidebarColor);
    root.style.setProperty('--side-fg', dark ? '#ffffff' : '#14161a');
    root.style.setProperty('--side-muted', dark ? 'rgba(255,255,255,.72)' : 'rgba(20,22,26,.65)');
    root.style.setProperty('--side-active-bg', dark ? 'rgba(255,255,255,.16)' : 'rgba(20,22,26,.08)');
    root.style.setProperty('--side-active-fg', dark ? '#ffffff' : '#14161a');
  }
}

/**
 * Prépare le logo dans le navigateur : redimensionné (600 × 240 max), PNG transparent pour
 * l'interface, JPEG sur fond blanc pour les documents PDF. Aucun SVG transmis au serveur.
 */
export async function prepareLogo(file: File): Promise<{ png: string; jpeg: string; previewUrl: string }> {
  if (!/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(file.type)) throw new Error('Format accepté : PNG, JPEG, WebP, GIF ou SVG.');
  if (file.size > 5_000_000) throw new Error('Fichier trop volumineux (5 Mo maximum).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error('Image illisible.')); i.src = url; });
    const w0 = img.naturalWidth || 600; const h0 = img.naturalHeight || 240;
    const k = Math.min(1, 600 / w0, 240 / h0);
    const w = Math.max(1, Math.round(w0 * k)); const h = Math.max(1, Math.round(h0 * k));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    const png = canvas.toDataURL('image/png');
    ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    const jpeg = canvas.toDataURL('image/jpeg', 0.9);
    return { png: png.split(',')[1], jpeg: jpeg.split(',')[1], previewUrl: png };
  } finally { URL.revokeObjectURL(url); }
}
