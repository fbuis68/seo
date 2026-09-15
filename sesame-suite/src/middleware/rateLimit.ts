import rateLimit from "express-rate-limit";

/**
 * Limite le rythme des tentatives sur les endpoints d'authentification
 * (mot de passe, code de réservation) — sans ça, rien n'empêchait un
 * script d'essayer des milliers de combinaisons par minute (force brute sur
 * /wa/login/login, ou énumération de codes de réservation sur
 * /api/auth/guest-login) — cf. audit sécurité du 15/09/2026. 20 tentatives
 * / 15 min / IP : large marge pour un utilisateur légitime qui se trompe
 * plusieurs fois, mais rend une attaque automatisée impraticable.
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives — réessayez dans quelques minutes." },
});
