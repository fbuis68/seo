-- Schéma initial : plateforme (comptes, organisations) + données de tournoi isolées par organisation (RLS).
--
-- Isolation : chaque table de tournoi porte org_id ; le rôle applicatif (sans propriété des tables)
-- ne voit que les lignes de l'organisation positionnée dans app.org_id pour la transaction.
-- Les fonctions SECURITY DEFINER ci-dessous sont les seuls passages contrôlés entre organisations
-- (résolution d'un tournoi par identifiant/slug, jeton QR, tournois d'un joueur).

CREATE OR REPLACE FUNCTION app_org() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION enable_org_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('CREATE POLICY org_isolation ON %s USING (org_id = app_org()) WITH CHECK (org_id = app_org())', tbl);
END $$;

-- ───────────── Plateforme ─────────────
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  phone text,
  birth_year int,                       -- données de mineurs : consentement parental requis si < 15 ans
  guardian_consent_at timestamptz,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','club','pro')),
  branding jsonb NOT NULL DEFAULT '{}',
  retention_months int NOT NULL DEFAULT 36,     -- RGPD : conservation des données personnelles des participants
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

-- Responsable de club (owner/manager) : gère tous les tournois et les organisateurs ; organizer : ses tournois.
CREATE TABLE org_members (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','manager','organizer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- Limitation des requêtes abusives (connexion, inscription, saisie de score).
CREATE TABLE rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  hits int NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

-- ───────────── Tournois (isolés par organisation) ─────────────
CREATE TABLE venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  address text,
  courts jsonb NOT NULL DEFAULT '[]'          -- [{number, name}]
);
SELECT enable_org_rls('venues');

CREATE TABLE tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  discipline text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  venue_name text,
  venue_id uuid REFERENCES venues(id),
  max_participants int NOT NULL CHECK (max_participants BETWEEN 2 AND 2000),
  mode text NOT NULL CHECK (mode IN ('single','double','team')),
  format text NOT NULL CHECK (format IN ('groups','league','knockout','groups_knockout')),
  format_config jsonb NOT NULL DEFAULT '{}',
  scoring jsonb NOT NULL,                     -- règles de score (versionnées via rules_version + audit)
  ranking_rules jsonb NOT NULL DEFAULT '{}',  -- barème + critères de départage
  rules_version int NOT NULL DEFAULT 1,
  courts int NOT NULL DEFAULT 1 CHECK (courts BETWEEN 1 AND 200),
  match_minutes int NOT NULL DEFAULT 30 CHECK (match_minutes BETWEEN 5 AND 600),
  break_minutes int NOT NULL DEFAULT 5,
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  registration jsonb NOT NULL DEFAULT '{}',   -- {open, requireApproval, collectEmail, collectPhone, categories[]}
  referee_mode text NOT NULL DEFAULT 'none' CHECK (referee_mode IN ('none','optional','required')),
  referee_official boolean NOT NULL DEFAULT true,   -- score saisi par l'arbitre directement officiel
  confirmation_hours int NOT NULL DEFAULT 2,         -- délai de confirmation contradictoire
  auto_confirm_on_timeout boolean NOT NULL DEFAULT false,
  branding jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','registration','running','finished','archived')),
  published_at timestamptz,
  generated_at timestamptz,
  draw_seed int,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX tournaments_org ON tournaments(org_id);
SELECT enable_org_rls('tournaments');

-- Rôles par tournoi (un même utilisateur peut être joueur ici, arbitre ailleurs).
CREATE TABLE tournament_roles (
  org_id uuid NOT NULL REFERENCES organizations(id),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('organizer','referee')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, user_id, role)
);
SELECT enable_org_rls('tournament_roles');

-- Participant au tournoi : joueur seul, paire de double ou équipe (Registration + Team).
CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name text NOT NULL,                         -- affichage public (pseudonyme, nom d'équipe ou « Nom1 / Nom2 »)
  club text,
  category text,
  rating numeric,                             -- niveau / classement initial (plus grand = meilleur)
  seed int,                                   -- tête de série (1 = meilleure), calculée ou imposée
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','waitlist','refused','withdrawn','forfeit')),
  waitlist_position int,
  checked_in_at timestamptz,
  source text NOT NULL DEFAULT 'organizer' CHECK (source IN ('organizer','self','import','qr')),
  replaced_by uuid REFERENCES participants(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX participants_t ON participants(tournament_id);
SELECT enable_org_rls('participants');

-- Membres : un pour un joueur seul, deux pour un double, n pour une équipe. Statistiques individuelles conservées.
CREATE TABLE participant_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  position int NOT NULL DEFAULT 1,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text,
  phone text,
  user_id uuid REFERENCES users(id),          -- compte associé (QR, invitation, validation organisateur)
  is_captain boolean NOT NULL DEFAULT false,  -- représentant autorisé à confirmer les scores
  claim_requested_by uuid REFERENCES users(id),
  claim_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pm_participant ON participant_members(participant_id);
CREATE INDEX pm_user ON participant_members(user_id);
-- Un compte ne peut être associé qu'une fois par tournoi.
CREATE UNIQUE INDEX pm_user_tournament ON participant_members(tournament_id, user_id) WHERE user_id IS NOT NULL;
SELECT enable_org_rls('participant_members');

-- Phase : poules, championnat ou élimination directe ; relations explicites entre phases.
CREATE TABLE stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  idx int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('round_robin','knockout')),
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  source_stage_id uuid REFERENCES stages(id),  -- phase dont proviennent les qualifiés
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','running','completed')),
  UNIQUE (tournament_id, idx)
);
SELECT enable_org_rls('stages');

CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  stage_id uuid NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  name text NOT NULL,
  idx int NOT NULL,
  UNIQUE (stage_id, name)
);
SELECT enable_org_rls('groups');

CREATE TABLE group_members (
  org_id uuid NOT NULL REFERENCES organizations(id),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id),
  position int NOT NULL,
  PRIMARY KEY (group_id, participant_id)
);
SELECT enable_org_rls('group_members');

CREATE TABLE matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage_id uuid NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
  key text NOT NULL,                          -- G{poule}-{n} ou R{tour}-{pos} / P3
  round int NOT NULL,
  position int NOT NULL DEFAULT 1,
  leg int NOT NULL DEFAULT 1,
  home_id uuid REFERENCES participants(id),
  away_id uuid REFERENCES participants(id),
  home_source jsonb,                          -- origine de la place (vainqueur de R1-2, 1er poule A…)
  away_source jsonb,
  next_key text, next_slot text,
  loser_next_key text, loser_next_slot text,
  status text NOT NULL DEFAULT 'to_schedule' CHECK (status IN
    ('to_schedule','scheduled','called','in_progress','awaiting_confirmation','disputed','completed','postponed','cancelled','walkover','bye')),
  court int,
  scheduled_at timestamptz,
  schedule_locked boolean NOT NULL DEFAULT false,
  referee_user_id uuid REFERENCES users(id),
  score jsonb,                                -- résultat officiel {sets:[{home,away}]} ou {home,away}
  winner_id uuid REFERENCES participants(id),
  is_draw boolean NOT NULL DEFAULT false,
  outcome text CHECK (outcome IN ('normal','walkover','retired','disqualified','bye')),
  result jsonb,                               -- agrégats officiels : sets/jeux par côté
  penalty_home int NOT NULL DEFAULT 0,
  penalty_away int NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  version int NOT NULL DEFAULT 1,             -- verrou optimiste (modifications concurrentes)
  UNIQUE (stage_id, key)
);
CREATE INDEX matches_t ON matches(tournament_id);
CREATE INDEX matches_home ON matches(home_id);
CREATE INDEX matches_away ON matches(away_id);
SELECT enable_org_rls('matches');

-- Saisie de score proposée (joueur, arbitre, organisateur) et son cycle de validation contradictoire.
CREATE TABLE score_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  submitted_by uuid NOT NULL REFERENCES users(id),
  submitter_role text NOT NULL CHECK (submitter_role IN ('home','away','referee','organizer')),
  score jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','disputed','rejected','superseded','official')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  reason text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ss_match ON score_submissions(match_id);
-- Une seule proposition en attente par rencontre : la seconde saisie simultanée est confrontée à la première.
CREATE UNIQUE INDEX ss_one_pending ON score_submissions(match_id) WHERE status = 'pending';
SELECT enable_org_rls('score_submissions');

-- Jetons QR : aléatoires (256 bits), stockés hachés, expirables et révocables.
CREATE TABLE qr_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('tournament','participant','match')),
  target_id uuid,                              -- participant_members.id ou matches.id
  token_hash text NOT NULL UNIQUE,
  token_hint text NOT NULL,                    -- 4 derniers caractères (identification à l'écran)
  token_plain text,                            -- conservé uniquement pour le QR tournoi (public par nature)
  expires_at timestamptz,
  revoked_at timestamptz,
  used_at timestamptz,                         -- jeton participant : usage unique
  max_uses int,
  uses int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT enable_org_rls('qr_tokens');

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  tournament_id uuid REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  channels text[] NOT NULL DEFAULT '{web}',
  sent_email_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notif_user ON notifications(user_id, created_at DESC);
SELECT enable_org_rls('notifications');

-- Journal : toute action sensible (scores, corrections, tirages, rôles) avec avant/après et motif.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  tournament_id uuid,
  actor_id uuid,
  entity text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  reason text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity ON audit_log(entity_id);
SELECT enable_org_rls('audit_log');
-- Journal non modifiable.
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_immutable'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- ───────────── Passages contrôlés entre organisations ─────────────
-- Les tables métier ne sont pas en FORCE RLS : ces fonctions, propriété du propriétaire du schéma, lisent
-- uniquement la clé de routage (organisation) puis l'application rouvre une transaction isolée.
CREATE OR REPLACE FUNCTION route_tournament(p_id uuid) RETURNS TABLE (id uuid, org_id uuid, visibility text, published boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.org_id, t.visibility, t.published_at IS NOT NULL FROM tournaments t WHERE t.id = p_id
$$;
CREATE OR REPLACE FUNCTION route_tournament_slug(p_slug text) RETURNS TABLE (id uuid, org_id uuid, visibility text, published boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.org_id, t.visibility, t.published_at IS NOT NULL FROM tournaments t WHERE t.slug = p_slug
$$;
CREATE OR REPLACE FUNCTION route_match(p_id uuid) RETURNS TABLE (id uuid, org_id uuid, tournament_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, m.org_id, m.tournament_id FROM matches m WHERE m.id = p_id
$$;
CREATE OR REPLACE FUNCTION route_participant(p_id uuid) RETURNS TABLE (id uuid, org_id uuid, tournament_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.org_id, p.tournament_id FROM participants p WHERE p.id = p_id
$$;
CREATE OR REPLACE FUNCTION route_member(p_id uuid) RETURNS TABLE (id uuid, org_id uuid, tournament_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, m.org_id, m.tournament_id FROM participant_members m WHERE m.id = p_id
$$;
CREATE OR REPLACE FUNCTION route_qr(p_hash text) RETURNS TABLE (id uuid, org_id uuid, tournament_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT q.id, q.org_id, q.tournament_id FROM qr_tokens q WHERE q.token_hash = p_hash
$$;
-- Tournois où l'utilisateur est joueur, arbitre ou organisateur (espace « Mes tournois »).
CREATE OR REPLACE FUNCTION route_user_tournaments(p_user uuid) RETURNS TABLE (tournament_id uuid, org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT tournament_id, org_id FROM participant_members WHERE user_id = p_user
  UNION SELECT tournament_id, org_id FROM tournament_roles WHERE user_id = p_user
$$;
CREATE OR REPLACE FUNCTION route_user_notifications(p_user uuid) RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT org_id FROM notifications WHERE user_id = p_user AND read_at IS NULL
$$;
-- Échéances de confirmation dépassées, toutes organisations (tâche périodique).
CREATE OR REPLACE FUNCTION route_expired_submissions() RETURNS TABLE (submission_id uuid, org_id uuid, match_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.org_id, s.match_id FROM score_submissions s WHERE s.status = 'pending' AND s.expires_at < now()
$$;
