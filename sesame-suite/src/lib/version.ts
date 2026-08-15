import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

function readFileTrim(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Numéro de version = commit + date du dernier commit, pour vérifier depuis
 * l'appli (GET /version, pied de la barre latérale CRM/admin) quel build
 * tourne réellement après un déploiement — utile quand un `git pull` sur le
 * serveur semble ne pas avoir pris effet.
 *
 * En Docker : BUILD_SHA.txt / BUILD_TIME.txt générés au build (voir
 * Dockerfile), le .git n'existe plus dans l'image finale.
 * En dev local (`npm run dev`) : .git est présent, on le lit directement.
 */
function computeVersion(): { sha: string; buildTime: string } {
  const shaFile = readFileTrim(path.join(ROOT, "BUILD_SHA.txt"));
  const timeFile = readFileTrim(path.join(ROOT, "BUILD_TIME.txt"));
  if (shaFile && timeFile) return { sha: shaFile, buildTime: timeFile };

  try {
    const sha = execSync("git rev-parse --short HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const buildTime = execSync("git log -1 --format=%cI", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return { sha, buildTime };
  } catch {
    return { sha: "inconnu", buildTime: new Date().toISOString() };
  }
}

export const VERSION = computeVersion();
