import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { randomPassword } from "./password";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function nextEntityCode(): Promise<string> {
  const count = await prisma.entity.count();
  return "E" + String(count + 1).padStart(8, "0");
}

/** Provisionne un nouvel établissement (Entity + configuration par défaut +
 * compte admin "hotel") — utilisé à la fois par la création manuelle
 * (panneau Hôtels) et par l'activation d'une souscription. Retourne les
 * identifiants du compte admin en clair (uniquement disponibles à cet
 * instant — le mot de passe n'est jamais stocké autrement que hashé). */
export async function provisionEntity(opts: { name: string; stars?: number; adminEmail?: string; adminPassword?: string }) {
  const code = await nextEntityCode();
  const adminEmail = (opts.adminEmail || `admin@${slugify(opts.name) || "hotel"}.sesame-app.fr`).toLowerCase();
  const adminPassword = opts.adminPassword || randomPassword();

  const existingEmail = await prisma.adminUser.findUnique({ where: { email: adminEmail } });
  if (existingEmail) throw new Error(`Un compte admin existe déjà avec l'email ${adminEmail}`);

  const entity = await prisma.entity.create({ data: { code, name: opts.name } });

  await prisma.entityModuleConfig.create({
    data: {
      entityId: entity.id,
      hotelName: opts.name,
      stars: opts.stars || 3,
      colors: {
        primary: "#8B1A2E",
        primaryLight: "#FDEDF0",
        accent: "#8B1A2E",
        headerBg: "#8B1A2E",
        headerText: "#FFFFFF",
        bg: "#F5F3F0",
        cardBg: "#FFFFFF",
        border: "#E3DED8",
        text: "#14121E",
        btnNav: "#8B1A2E",
      },
      msgEco: "Chaque geste compte ! Vos choix génèrent des récompenses.",
      tarifs: [0.88, 1.65, 2.6, 4.2, 6.0],
      freqOpts: [0, 3, 1],
      gains: {
        points: { active: true, name: "Sesame Points", perLiter: 1.0, perMenage: 0, perServ: 0 },
        reduction: { active: true, pct: 5, cond: "any", cumul: true },
        produit: { active: false, list: [], mode: "single" },
        financier: { active: false, euroPerMenage: 2.5, deductible: true, toPoints: true },
      },
      checkinModules: {
        room: { active: true, mandatory: true },
        taxe: { active: true, mandatory: true },
        kyc: { active: true, mandatory: false },
        eco: { active: true, mandatory: false },
        boutique: { active: true, mandatory: false },
        rewards: { active: true, mandatory: true },
        roomservice: { active: true, mandatory: false },
      },
      roomTags: [],
      rewardCatalog: [],
      accessPoints: [{ id: "room", label: "Chambre", ico: "ti-door", facilityCode: "", auto: true }],
    },
  });

  const passwordHash = await bcrypt.hash(adminPassword, 10);
  const admin = await prisma.adminUser.create({
    data: { entityId: entity.id, email: adminEmail, passwordHash, name: `Direction ${opts.name}`, role: "hotel" },
  });

  return { entity, admin, adminEmail, adminPassword };
}
