/**
 * Plan de l'hôtel + photos de chambres pour Hôtel Churchill : générés en
 * interne (SVG → data URI) faute de plan architectural réel ou de shooting
 * photo — suffisant pour peupler "Plan de l'hôtel" et les fiches chambres de
 * l'admin avec un rendu correct plutôt que des champs vides.
 *
 * Partagé entre seed.ts (nouvelles bases) et scripts/backfill-room-media.ts
 * (bases déjà provisionnées, où seed.ts ne repasse jamais sur les chambres
 * existantes — cf. `update: {}` dans l'upsert).
 */

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// floor: RDC=0, R+1=1, R+2=2, R+3=3, R+4=4 (cf. flLbls dans le prototype) —
// x/y = position sur le plan schématique 540x380 (cf. Room.x/y dans le schema).
export const ROOMS: Array<{
  code: string; name: string; floor: number; surface: number; category: string; available: boolean; tag: string; x: number; y: number;
}> = [
  { code: "A11", name: "Chambre A11 — Supérieure", floor: 1, surface: 25.1, category: "A — Supérieure", available: true, tag: "Supérieure", x: 70, y: 110 },
  { code: "A12", name: "Suite A12 — Supérieure", floor: 1, surface: 30.6, category: "A — Supérieure", available: true, tag: "Supérieure", x: 190, y: 110 },
  { code: "A14", name: "Chambre A14 — Supérieure", floor: 1, surface: 26.6, category: "A — Supérieure", available: false, tag: "Supérieure", x: 310, y: 110 },
  { code: "A23", name: "Chambre A23 — Supérieure", floor: 2, surface: 19.3, category: "A — Supérieure", available: true, tag: "Supérieure", x: 270, y: 100 },
  { code: "A42", name: "Chambre A42 — Supérieure Attique", floor: 4, surface: 24.1, category: "A — Supérieure", available: true, tag: "Attique", x: 150, y: 110 },
  { code: "A43", name: "Suite A43 — Attique", floor: 4, surface: 22.0, category: "A — Supérieure", available: true, tag: "Attique", x: 270, y: 110 },
  { code: "B13", name: "Chambre B13 — Standard", floor: 1, surface: 14.1, category: "B — Standard", available: true, tag: "Standard", x: 430, y: 110 },
  { code: "B14", name: "Chambre B14 — Standard", floor: 1, surface: 14.6, category: "B — Standard", available: true, tag: "Standard", x: 70, y: 270 },
  { code: "B43", name: "Chambre B43 — Standard", floor: 4, surface: 14.1, category: "B — Standard", available: true, tag: "Standard", x: 390, y: 110 },
  { code: "C16", name: "Chambre C16 — Compacte", floor: 1, surface: 15.3, category: "C — Compacte", available: true, tag: "Compacte", x: 190, y: 270 },
  { code: "C17", name: "Chambre C17 — Compacte", floor: 1, surface: 15.3, category: "C — Compacte", available: true, tag: "Compacte", x: 310, y: 270 },
  { code: "C19", name: "Chambre C19 — Compacte", floor: 1, surface: 15.2, category: "C — Compacte", available: false, tag: "Compacte", x: 430, y: 270 },
];

export function hotelPlanSvg(): string {
  // Fond schématique uniquement : les pastilles de chambres sont dessinées
  // par-dessus dynamiquement (drawRooms() dans admin.html), filtrées par
  // étage sélectionné — les baker dans l'image mélangerait tous les étages.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="380" viewBox="0 0 540 380">
    <rect width="540" height="380" fill="#FAF9F5"/>
    <rect x="20" y="20" width="500" height="340" fill="#FFFFFF" stroke="#C9C4B6" stroke-width="2"/>
    <rect x="20" y="175" width="500" height="30" fill="#F1EEE4"/>
    <text x="270" y="195" font-family="DM Sans,Arial,sans-serif" font-size="11" fill="#B0ADA4" text-anchor="middle" letter-spacing="2">COULOIR</text>
    ${Array.from({ length: 9 })
      .map((_, i) => `<line x1="${20 + i * 62.5}" y1="20" x2="${20 + i * 62.5}" y2="175" stroke="#EDEAE0" stroke-width="1"/><line x1="${20 + i * 62.5}" y1="205" x2="${20 + i * 62.5}" y2="360" stroke="#EDEAE0" stroke-width="1"/>`)
      .join("")}
    <g font-family="DM Sans,Arial,sans-serif">
      <text x="30" y="42" font-size="14" font-weight="700" fill="#8B1A2E">Hôtel Churchill</text>
      <text x="30" y="58" font-size="9" fill="#B0ADA4">Plan schématique — étage sélectionné en haut du panneau</text>
    </g>
    <g transform="translate(492,42)">
      <circle r="14" fill="#FFFFFF" stroke="#C9C4B6"/>
      <text y="4" font-size="11" font-weight="700" fill="#8B1A2E" text-anchor="middle">N</text>
      <path d="M0,-9 L3,0 L0,-3 L-3,0 Z" fill="#8B1A2E"/>
    </g>
  </svg>`;
}

const ROOM_PHOTO_THEME: Record<string, { wall: string; accent: string; wood: string }> = {
  "A — Supérieure": { wall: "#F4ECD8", accent: "#9B6E0A", wood: "#B98A3E" },
  "B — Standard": { wall: "#E9EFF6", accent: "#1A4880", wood: "#8A9BB0" },
  "C — Compacte": { wall: "#E9F3ED", accent: "#2D9B6A", wood: "#7CAE95" },
};

export function roomPhotoSvg(label: string, category: string, kind: "chambre" | "sdb"): string {
  const t = ROOM_PHOTO_THEME[category] || ROOM_PHOTO_THEME["B — Standard"];
  const body =
    kind === "chambre"
      ? `<rect width="320" height="200" fill="${t.wall}"/>
         <rect x="0" y="150" width="320" height="50" fill="${t.wood}" opacity=".35"/>
         <rect x="200" y="20" width="90" height="70" rx="3" fill="#FFFFFF" opacity=".55" stroke="${t.accent}" stroke-width="2"/>
         <rect x="20" y="90" width="150" height="80" rx="6" fill="#FFFFFF" stroke="${t.accent}" stroke-width="2"/>
         <rect x="20" y="90" width="150" height="22" rx="6" fill="${t.accent}" opacity=".85"/>
         <circle cx="45" cy="101" r="9" fill="#FFFFFF" opacity=".9"/>
         <circle cx="70" cy="101" r="9" fill="#FFFFFF" opacity=".9"/>
         <rect x="190" y="120" width="34" height="50" rx="4" fill="${t.accent}" opacity=".5"/>`
      : `<rect width="320" height="200" fill="#F5F5F2"/>
         <rect x="0" y="150" width="320" height="50" fill="${t.accent}" opacity=".18"/>
         <rect x="30" y="40" width="80" height="90" rx="4" fill="#FFFFFF" stroke="${t.accent}" stroke-width="2"/>
         <circle cx="70" cy="60" r="12" fill="${t.accent}" opacity=".3"/>
         <rect x="150" y="90" width="140" height="55" rx="27" fill="#FFFFFF" stroke="${t.accent}" stroke-width="2"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
    ${body}
    <rect x="0" y="176" width="320" height="24" fill="rgba(20,19,13,.55)"/>
    <text x="10" y="192" font-family="DM Sans,Arial,sans-serif" font-size="11" fill="#fff">${label} — ${kind === "chambre" ? "Chambre" : "Salle de bain"}</text>
  </svg>`;
}
