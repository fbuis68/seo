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
  // par-dessus dynamiquement (drawRooms() dans admin.html, renderRoomMap()
  // dans checkin.html), filtrées par étage sélectionné — les baker dans
  // l'image mélangerait tous les étages. Coordonnées de la grille (9
  // colonnes tous les 62.5px à partir de x=20) INCHANGÉES par rapport à la
  // version précédente : ROOMS[].x/y (prisma/roomMedia.ts) sont calibrées
  // dessus, un décalage romprait l'alignement des pastilles cliquables.
  // Amélioration purement visuelle (25/08/2026) : dégradés, ombre douce,
  // amorces de porte à chaque cellule le long du couloir, boussole
  // détaillée — même esprit que le lifting des photos de chambres.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="380" viewBox="0 0 540 380">
    <defs>
      <linearGradient id="planBg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FBF8F2"/><stop offset="1" stop-color="#F1EADC"/>
      </linearGradient>
      <linearGradient id="planCorridor" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#EFE9DC"/><stop offset="1" stop-color="#E6DDC9"/>
      </linearGradient>
      <filter id="planShadow" x="-10%" y="-15%" width="120%" height="140%">
        <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#14130D" flood-opacity=".1"/>
      </filter>
    </defs>

    <rect width="540" height="380" fill="url(#planBg)"/>
    <rect x="20" y="20" width="500" height="340" rx="6" fill="#FFFFFF" stroke="#D9D2C0" stroke-width="1.5" filter="url(#planShadow)"/>

    <g stroke="#EEE8DA" stroke-width="1">
      ${Array.from({ length: 9 })
        .map((_, i) => `<line x1="${20 + i * 62.5}" y1="20" x2="${20 + i * 62.5}" y2="175"/><line x1="${20 + i * 62.5}" y1="205" x2="${20 + i * 62.5}" y2="360"/>`)
        .join("")}
    </g>
    <!-- amorces de porte : un repère par cellule, de chaque côté du couloir -->
    <g fill="#C9BFA0">
      ${Array.from({ length: 9 })
        .map((_, i) => {
          const cx = 20 + i * 62.5 + 31.25;
          return `<rect x="${cx - 7}" y="171" width="14" height="4" rx="2"/><rect x="${cx - 7}" y="205" width="14" height="4" rx="2"/>`;
        })
        .join("")}
    </g>

    <rect x="20" y="175" width="500" height="30" fill="url(#planCorridor)"/>
    <text x="270" y="195" font-family="DM Sans,Arial,sans-serif" font-size="11" font-weight="600" fill="#A69A78" text-anchor="middle" letter-spacing="3">COULOIR</text>

    <g font-family="DM Sans,Arial,sans-serif">
      <text x="30" y="42" font-size="15" font-weight="700" fill="#8B1A2E">Hôtel Churchill</text>
      <text x="30" y="58" font-size="9" fill="#B0ADA4">Plan schématique — étage sélectionné en haut du panneau</text>
    </g>
    <g transform="translate(492,42)">
      <circle r="15" fill="#FFFFFF" stroke="#D9D2C0" stroke-width="1.5"/>
      <g stroke="#D9D2C0" stroke-width="1">
        <line x1="-15" y1="0" x2="-19" y2="0"/><line x1="15" y1="0" x2="19" y2="0"/><line x1="0" y1="15" x2="0" y2="19"/>
      </g>
      <path d="M0,-10 L3.5,-1 L0,-4 L-3.5,-1 Z" fill="#8B1A2E"/>
      <text y="4" font-size="11" font-weight="700" fill="#8B1A2E" text-anchor="middle">N</text>
    </g>
  </svg>`;
}

// Palette par catégorie — reprise du thème existant (A=doré/bois,
// B=bleu, C=vert), enrichie de teintes de mur/ciel/linge pour les
// illustrations façon "scène" ci-dessous (25/08/2026 : les photos étaient
// de simples aplats rectangulaires, remplacées par une scène avec
// dégradés/ombres pour un rendu nettement plus soigné — toujours généré en
// interne, faute d'accès réseau à un vrai shooting photo dans cet
// environnement).
const ROOM_PHOTO_THEME: Record<string, { wallTop: string; wallBot: string; accent: string; accentDark: string; wood: string; woodDark: string; linen: string; sky1: string; sky2: string }> = {
  "A — Supérieure": { wallTop: "#F7EFDD", wallBot: "#EDE0C4", accent: "#B9862F", accentDark: "#8A5F16", wood: "#C79A55", woodDark: "#A67B3B", linen: "#FBF6EC", sky1: "#FDECC8", sky2: "#F7C873" },
  "B — Standard": { wallTop: "#EDF2F9", wallBot: "#DCE6F2", accent: "#3A6FB0", accentDark: "#1A4880", wood: "#9FB3C8", woodDark: "#7B93AC", linen: "#F7FAFD", sky1: "#DCEBFB", sky2: "#8FC1EF" },
  "C — Compacte": { wallTop: "#EDF6F0", wallBot: "#DCEEE2", accent: "#2F9A6B", accentDark: "#1E7350", wood: "#9BC3AC", woodDark: "#78A98D", linen: "#F6FBF8", sky1: "#DFF3E6", sky2: "#8FD3AC" },
};

/** Chambre illustrée (dégradés + ombres douces) : fenêtre/ciel, lit avec
 * couette + oreillers, table de chevet + lampe, cadre mural, tapis. */
function chambreSvg(t: (typeof ROOM_PHOTO_THEME)[string], label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
    <defs>
      <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${t.wallTop}"/><stop offset="1" stop-color="${t.wallBot}"/>
      </linearGradient>
      <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${t.wood}"/><stop offset="1" stop-color="${t.woodDark}"/>
      </linearGradient>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${t.sky1}"/><stop offset="1" stop-color="${t.sky2}"/>
      </linearGradient>
      <linearGradient id="duvet" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="${t.linen}"/>
      </linearGradient>
      <radialGradient id="lampGlow" cx="0.5" cy="0.35" r="0.65">
        <stop offset="0" stop-color="#FFE9A8" stop-opacity=".9"/><stop offset="1" stop-color="#FFE9A8" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="vignette" cx="0.5" cy="0.42" r="0.75">
        <stop offset="0.6" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity=".1"/>
      </radialGradient>
      <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="4"/>
      </filter>
    </defs>

    <rect width="320" height="200" fill="url(#wall)"/>
    <rect x="0" y="140" width="320" height="60" fill="url(#floor)"/>
    <g stroke="${t.woodDark}" stroke-width="1" opacity=".25">
      ${[0, 40, 80, 120, 160, 200, 240, 280].map((x) => `<line x1="${x}" y1="140" x2="${x - 14}" y2="200"/>`).join("")}
    </g>

    <!-- fenêtre + ciel -->
    <rect x="214" y="16" width="92" height="80" rx="3" fill="url(#sky)"/>
    <circle cx="270" cy="38" r="10" fill="#FFF6DD" opacity=".85"/>
    <rect x="214" y="80" width="92" height="16" fill="${t.accentDark}" opacity=".18"/>
    <rect x="214" y="16" width="92" height="80" rx="3" fill="none" stroke="${t.accentDark}" stroke-width="3"/>
    <line x1="260" y1="16" x2="260" y2="96" stroke="${t.accentDark}" stroke-width="2"/>
    <line x1="214" y1="56" x2="306" y2="56" stroke="${t.accentDark}" stroke-width="2"/>

    <!-- rideaux -->
    <line x1="196" y1="10" x2="320" y2="10" stroke="${t.accentDark}" stroke-width="3"/>
    <rect x="200" y="9" width="18" height="132" fill="${t.accent}" opacity=".38"/>
    <rect x="303" y="9" width="17" height="132" fill="${t.accent}" opacity=".38"/>
    <g stroke="${t.accentDark}" stroke-width="1" opacity=".2">
      <line x1="206" y1="9" x2="206" y2="141"/><line x1="212" y1="9" x2="212" y2="141"/>
      <line x1="309" y1="9" x2="309" y2="141"/><line x1="315" y1="9" x2="315" y2="141"/>
    </g>

    <!-- tapis -->
    <ellipse cx="95" cy="176" rx="88" ry="16" fill="${t.accent}" opacity=".22"/>

    <!-- ombre du lit -->
    <ellipse cx="92" cy="172" rx="82" ry="10" fill="#000000" opacity=".12" filter="url(#soft)"/>

    <!-- tête de lit -->
    <rect x="18" y="66" width="150" height="46" rx="10" fill="${t.accent}"/>
    <rect x="18" y="66" width="150" height="46" rx="10" fill="none" stroke="${t.accentDark}" stroke-width="1" opacity=".4"/>

    <!-- sommier + couette -->
    <rect x="14" y="100" width="158" height="58" rx="8" fill="url(#duvet)" stroke="#E7E0D2" stroke-width="1"/>
    <rect x="14" y="100" width="158" height="14" rx="7" fill="${t.accent}" opacity=".9"/>
    <!-- oreillers -->
    <rect x="24" y="88" width="52" height="30" rx="10" fill="#FFFFFF" stroke="#E7E0D2" stroke-width="1"/>
    <rect x="82" y="88" width="52" height="30" rx="10" fill="#FFFFFF" stroke="#E7E0D2" stroke-width="1"/>

    <!-- chevet + lampe (base → pied fin → abat-jour, le pied disparaît
         sous l'abat-jour plutôt que de dépasser dessus) -->
    <rect x="182" y="118" width="30" height="40" rx="4" fill="${t.woodDark}"/>
    <circle cx="197" cy="76" r="22" fill="url(#lampGlow)"/>
    <rect x="190" y="109" width="14" height="9" rx="2" fill="${t.accentDark}"/>
    <line x1="197" y1="109" x2="197" y2="82" stroke="${t.woodDark}" stroke-width="2"/>
    <path d="M186,86 L208,86 L201,64 L193,64 Z" fill="${t.accent}"/>
    <path d="M186,86 L208,86 L201,64 L193,64 Z" fill="none" stroke="${t.accentDark}" stroke-width="1" opacity=".35"/>

    <!-- cadre mural -->
    <rect x="234" y="118" width="52" height="34" rx="2" fill="#FFFFFF" stroke="${t.accentDark}" stroke-width="2"/>
    <rect x="240" y="124" width="18" height="22" fill="${t.accent}" opacity=".6"/>
    <rect x="262" y="124" width="18" height="22" fill="${t.woodDark}" opacity=".5"/>

    <rect width="320" height="200" fill="url(#vignette)"/>
    <rect x="0" y="176" width="320" height="24" fill="rgba(20,19,13,.5)"/>
    <text x="10" y="192" font-family="DM Sans,Arial,sans-serif" font-size="11" fill="#fff">${label} — Chambre</text>
  </svg>`;
}

/** Salle de bain illustrée : vasque + miroir lumineux, douche vitrée,
 * carrelage au sol, touche végétale. */
function sdbSvg(t: (typeof ROOM_PHOTO_THEME)[string], label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
    <defs>
      <linearGradient id="wall2" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="${t.wallBot}"/>
      </linearGradient>
      <linearGradient id="counter" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="${t.linen}"/>
      </linearGradient>
      <radialGradient id="mirrorGlow" cx="0.5" cy="0.4" r="0.7">
        <stop offset="0" stop-color="#FFFFFF" stop-opacity=".95"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${t.accent}" stop-opacity=".16"/><stop offset="1" stop-color="${t.accent}" stop-opacity=".05"/>
      </linearGradient>
      <pattern id="tiles" width="20" height="20" patternUnits="userSpaceOnUse">
        <rect width="20" height="20" fill="${t.linen}"/>
        <rect width="19" height="19" fill="none" stroke="${t.wallBot}" stroke-width="1"/>
      </pattern>
    </defs>

    <rect width="320" height="200" fill="url(#wall2)"/>
    <rect x="0" y="150" width="320" height="50" fill="url(#tiles)"/>
    <rect x="0" y="150" width="320" height="3" fill="${t.accentDark}" opacity=".25"/>

    <!-- douche vitrée -->
    <rect x="216" y="20" width="92" height="150" rx="4" fill="url(#glass)" stroke="${t.accentDark}" stroke-width="2.5"/>
    <line x1="262" y1="24" x2="262" y2="166" stroke="${t.accentDark}" stroke-width="1.5" opacity=".5"/>
    <circle cx="248" cy="34" r="7" fill="${t.accentDark}" opacity=".7"/>
    <line x1="248" y1="41" x2="248" y2="58" stroke="${t.accentDark}" stroke-width="2" opacity=".7"/>
    <g stroke="${t.accent}" stroke-width="1.5" opacity=".35">
      <line x1="240" y1="64" x2="236" y2="80"/><line x1="248" y1="64" x2="245" y2="82"/><line x1="256" y1="64" x2="254" y2="80"/>
    </g>

    <!-- vasque -->
    <rect x="24" y="96" width="150" height="18" rx="6" fill="url(#counter)" stroke="#E7E0D2" stroke-width="1"/>
    <rect x="24" y="112" width="150" height="42" fill="${t.woodDark}" opacity=".9"/>
    <ellipse cx="65" cy="104" rx="26" ry="9" fill="#FFFFFF" stroke="${t.accentDark}" stroke-width="1.5"/>
    <rect x="60" y="82" width="4" height="16" fill="${t.accentDark}"/>
    <rect x="52" y="80" width="20" height="5" rx="2" fill="${t.accentDark}"/>

    <!-- miroir -->
    <circle cx="65" cy="58" r="32" fill="url(#mirrorGlow)" stroke="${t.accentDark}" stroke-width="2.5"/>

    <!-- plante (3 feuilles depuis un pot, plutôt qu'une masse unique) -->
    <rect x="189" y="146" width="16" height="14" rx="2" fill="${t.woodDark}"/>
    <path d="M197,146 C197,128 188,116 182,108 C186,124 190,138 197,146 Z" fill="${t.accent}" opacity=".85"/>
    <path d="M197,146 C197,124 200,110 197,98 C193,112 195,132 197,146 Z" fill="${t.accent}"/>
    <path d="M197,146 C197,128 206,116 212,108 C208,124 204,138 197,146 Z" fill="${t.accent}" opacity=".7"/>

    <rect x="0" y="176" width="320" height="24" fill="rgba(20,19,13,.5)"/>
    <text x="10" y="192" font-family="DM Sans,Arial,sans-serif" font-size="11" fill="#fff">${label} — Salle de bain</text>
  </svg>`;
}

export function roomPhotoSvg(label: string, category: string, kind: "chambre" | "sdb"): string {
  const t = ROOM_PHOTO_THEME[category] || ROOM_PHOTO_THEME["B — Standard"];
  return kind === "chambre" ? chambreSvg(t, label) : sdbSvg(t, label);
}
