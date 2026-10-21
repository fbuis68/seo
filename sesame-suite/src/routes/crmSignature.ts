import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { config } from "../config";
import { asyncHandler, HttpError } from "../lib/asyncHandler";
import { requireAdmin, requireSesame } from "../middleware/requireAdmin";
import { sendEmailRaw } from "../lib/email";
import { sendChannelRaw } from "../lib/sms";

/**
 * Gestionnaire de signature électronique générique (§ demande client
 * 21/10/2026) — envoie un document quelconque (contrat, devis en PDF, PV
 * de réception) à un signataire, qui le consulte sur une page publique
 * (public/signature.html) et confirme son identité par un code reçu par
 * SMS, à la manière d'un prestataire tiers (Yousign/DocuSign). Portée CRM
 * globale (entityId=null pour l'envoi SMS/email, cf. lib/sms.ts et
 * lib/email.ts) — aucun rapport avec les établissements hôteliers
 * eux-mêmes, réservé aux comptes Sesame.
 */
export const crmSignatureRouter = Router();

const DOCUMENT_TYPES = ["contract", "quote", "pv_reception"];
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

function shapeRequest(r: {
  id: string;
  documentType: string;
  title: string;
  fileName: string;
  signerFirstname: string;
  signerLastname: string;
  signerEmail: string;
  signerPhone: string | null;
  status: string;
  signToken: string;
  signedAt: Date | null;
  sentAt: Date | null;
  viewedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: r.id,
    documentType: r.documentType,
    title: r.title,
    fileName: r.fileName,
    signerFirstname: r.signerFirstname,
    signerLastname: r.signerLastname,
    signerEmail: r.signerEmail,
    signerPhone: r.signerPhone,
    status: r.status,
    signToken: r.signToken,
    signedAt: r.signedAt,
    sentAt: r.sentAt,
    viewedAt: r.viewedAt,
    createdAt: r.createdAt,
  };
}

// ══════════════════════════ CÔTÉ ADMIN (CRM, Sesame uniquement) ══════════════════════════

crmSignatureRouter.get(
  "/crmSignature/list",
  requireAdmin,
  requireSesame,
  asyncHandler(async (_req, res) => {
    const rows = await prisma.crmSignatureRequest.findMany({ orderBy: { createdAt: "desc" } });
    res.json(rows.map(shapeRequest));
  })
);

interface CreateBody {
  documentType?: string;
  title?: string;
  fileName?: string;
  fileMimeType?: string;
  fileContentBase64?: string; // data URL complète (data:application/pdf;base64,....) ou base64 nu — nettoyé ci-dessous
  signerFirstname?: string;
  signerLastname?: string;
  signerEmail?: string;
  signerPhone?: string;
}

crmSignatureRouter.post(
  "/crmSignature/create",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const b = req.body as CreateBody;
    const documentType = b.documentType || "";
    if (!DOCUMENT_TYPES.includes(documentType)) throw new HttpError(400, "Type de document invalide (contrat, devis ou PV de réception)");
    const title = (b.title || "").trim();
    if (!title) throw new HttpError(400, "Titre requis");
    const fileName = (b.fileName || "document.pdf").trim();
    const signerFirstname = (b.signerFirstname || "").trim();
    const signerLastname = (b.signerLastname || "").trim();
    const signerEmail = (b.signerEmail || "").trim().toLowerCase();
    if (!signerFirstname || !signerLastname || !signerEmail) throw new HttpError(400, "Prénom, nom et email du signataire requis");
    const raw = (b.fileContentBase64 || "").trim();
    if (!raw) throw new HttpError(400, "Fichier requis");
    // Accepte une data URL complète (cf. convention déjà utilisée ailleurs —
    // uploadLogo/uploadPlan côté admin.html, FileReader.readAsDataURL) et
    // n'en garde que la partie base64, jamais le préfixe "data:...;base64,".
    const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;

    const row = await prisma.crmSignatureRequest.create({
      data: {
        documentType,
        title,
        fileName,
        fileMimeType: b.fileMimeType || "application/pdf",
        fileContentBase64: base64,
        signerFirstname,
        signerLastname,
        signerEmail,
        signerPhone: (b.signerPhone || "").trim() || null,
        signToken: crypto.randomBytes(24).toString("hex"),
        createdByAdminId: req.admin!.adminId,
      },
    });
    res.status(201).json(shapeRequest(row));
  })
);

/** POST /wa/crmSignature/:id/send — envoie (ou réenvoie) le lien de signature par email. */
crmSignatureRouter.post(
  "/crmSignature/:id/send",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const existing = await prisma.crmSignatureRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "Demande introuvable");
    if (existing.status === "signed") throw new HttpError(400, "Ce document est déjà signé");
    if (existing.status === "cancelled") throw new HttpError(400, "Cette demande a été annulée");
    if (!config.publicBaseUrl) throw new HttpError(400, "PUBLIC_BASE_URL non configuré côté serveur — requis pour générer le lien de signature");

    const url = `${config.publicBaseUrl}/signature.html?token=${existing.signToken}`;
    const docLabel = existing.documentType === "contract" ? "contrat" : existing.documentType === "quote" ? "devis" : "PV de réception";
    const html = `<p>Bonjour ${existing.signerFirstname},</p>
<p>Un ${docLabel} intitulé « ${existing.title} » attend votre signature électronique.</p>
<p><a href="${url}">Consulter et signer le document</a></p>
<p>Vous recevrez un code de confirmation par SMS au moment de la signature.</p>`;
    await sendEmailRaw(null, existing.signerEmail, `Signature électronique — ${existing.title}`, html);

    const row = await prisma.crmSignatureRequest.update({
      where: { id: existing.id },
      data: { status: existing.status === "draft" ? "sent" : existing.status, sentAt: new Date() },
    });
    res.json(shapeRequest(row));
  })
);

/** POST /wa/crmSignature/:id/cancel — annule une demande non signée. */
crmSignatureRouter.post(
  "/crmSignature/:id/cancel",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const existing = await prisma.crmSignatureRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "Demande introuvable");
    if (existing.status === "signed") throw new HttpError(400, "Un document déjà signé ne peut pas être annulé");
    const row = await prisma.crmSignatureRequest.update({ where: { id: existing.id }, data: { status: "cancelled" } });
    res.json(shapeRequest(row));
  })
);

/** POST /wa/crmSignature/:id/delete — supprime une demande non envoyée (brouillon uniquement, jamais un document déjà signé ou envoyé — valeur probante à conserver). */
crmSignatureRouter.post(
  "/crmSignature/:id/delete",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const existing = await prisma.crmSignatureRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, "Demande introuvable");
    if (existing.status !== "draft") throw new HttpError(400, "Seul un brouillon jamais envoyé peut être supprimé — annulez-le sinon");
    await prisma.crmSignatureRequest.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  })
);

/** GET /wa/crmSignature/:id/file — relit le PDF (aperçu côté CRM). */
crmSignatureRouter.get(
  "/crmSignature/:id/file",
  requireAdmin,
  requireSesame,
  asyncHandler(async (req, res) => {
    const row = await prisma.crmSignatureRequest.findUnique({ where: { id: req.params.id } });
    if (!row) throw new HttpError(404, "Demande introuvable");
    res.json({ fileName: row.fileName, fileMimeType: row.fileMimeType, fileContentBase64: row.fileContentBase64 });
  })
);

// ══════════════════════════ CÔTÉ PUBLIC (page de signature, pas de compte) ══════════════════════════

/** GET /wa/crmSignature/public/:token — infos + fichier pour l'affichage. Pose viewedAt au premier accès. */
crmSignatureRouter.get(
  "/crmSignature/public/:token",
  asyncHandler(async (req, res) => {
    const row = await prisma.crmSignatureRequest.findUnique({ where: { signToken: req.params.token } });
    if (!row) throw new HttpError(404, "Lien de signature invalide");
    if (row.status === "cancelled") throw new HttpError(410, "Cette demande de signature a été annulée");

    if (!row.viewedAt) {
      await prisma.crmSignatureRequest.update({
        where: { id: row.id },
        data: { viewedAt: new Date(), status: row.status === "sent" ? "viewed" : row.status },
      });
    }
    res.json({
      documentType: row.documentType,
      title: row.title,
      fileName: row.fileName,
      fileMimeType: row.fileMimeType,
      fileContentBase64: row.fileContentBase64,
      signerFirstname: row.signerFirstname,
      signerLastname: row.signerLastname,
      signerEmail: row.signerEmail,
      signerPhone: row.signerPhone,
      status: row.status,
      signedAt: row.signedAt,
    });
  })
);

interface RequestOtpBody {
  firstname?: string;
  lastname?: string;
  email?: string;
  phone?: string;
}

/** POST /wa/crmSignature/public/:token/requestOtp — met à jour les coordonnées
 * confirmées/corrigées par le signataire puis envoie le code par SMS. */
crmSignatureRouter.post(
  "/crmSignature/public/:token/requestOtp",
  asyncHandler(async (req, res) => {
    const row = await prisma.crmSignatureRequest.findUnique({ where: { signToken: req.params.token } });
    if (!row) throw new HttpError(404, "Lien de signature invalide");
    if (row.status === "cancelled") throw new HttpError(410, "Cette demande de signature a été annulée");
    if (row.status === "signed") throw new HttpError(400, "Ce document est déjà signé");

    const b = req.body as RequestOtpBody;
    const phone = (b.phone || "").trim();
    if (!phone) throw new HttpError(400, "Numéro de téléphone requis pour recevoir le code de confirmation");

    const code = String(crypto.randomInt(100000, 1000000)); // 6 chiffres
    const otpCodeHash = await bcrypt.hash(code, 10);

    await prisma.crmSignatureRequest.update({
      where: { id: row.id },
      data: {
        signerFirstname: (b.firstname || row.signerFirstname).trim(),
        signerLastname: (b.lastname || row.signerLastname).trim(),
        signerEmail: (b.email || row.signerEmail).trim().toLowerCase(),
        signerPhone: phone,
        otpCodeHash,
        otpExpiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
        otpAttempts: 0,
      },
    });

    try {
      await sendChannelRaw(null, "sms", phone, `Sesame Technology — votre code de signature : ${code} (valable ${OTP_TTL_MINUTES} min)`);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, "Échec de l'envoi du SMS — réessayez");
    }
    res.json({ ok: true });
  })
);

interface VerifyOtpBody {
  code?: string;
}

/** POST /wa/crmSignature/public/:token/verifyOtp — vérifie le code et signe. */
crmSignatureRouter.post(
  "/crmSignature/public/:token/verifyOtp",
  asyncHandler(async (req, res) => {
    const row = await prisma.crmSignatureRequest.findUnique({ where: { signToken: req.params.token } });
    if (!row) throw new HttpError(404, "Lien de signature invalide");
    if (row.status === "signed") throw new HttpError(400, "Ce document est déjà signé");
    if (!row.otpCodeHash || !row.otpExpiresAt) throw new HttpError(400, "Aucun code en attente — redemandez un code");
    if (row.otpExpiresAt < new Date()) throw new HttpError(400, "Code expiré — redemandez un code");
    if (row.otpAttempts >= OTP_MAX_ATTEMPTS) throw new HttpError(429, "Trop de tentatives — redemandez un nouveau code");

    const code = ((req.body as VerifyOtpBody).code || "").trim();
    const ok = code ? await bcrypt.compare(code, row.otpCodeHash) : false;
    if (!ok) {
      await prisma.crmSignatureRequest.update({ where: { id: row.id }, data: { otpAttempts: { increment: 1 } } });
      throw new HttpError(400, "Code incorrect");
    }

    const updated = await prisma.crmSignatureRequest.update({
      where: { id: row.id },
      data: {
        status: "signed",
        signedAt: new Date(),
        signerIp: req.ip,
        signerUserAgent: req.headers["user-agent"] || null,
        otpCodeHash: null,
        otpExpiresAt: null,
      },
    });
    res.json({ ok: true, signedAt: updated.signedAt });
  })
);
