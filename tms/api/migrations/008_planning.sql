-- Module planning : séances avec statuts et versions, disponibilités, fermetures, récurrences,
-- historique, notifications regroupées, événements sortants, paramètres et idempotence.
-- Toutes les tables sont soumises à la RLS forcée ; les reprises de données lèvent temporairement
-- le FORCE (sinon la migration, exécutée hors contexte organisme, ne verrait aucune ligne).

ALTER TABLE slots NO FORCE ROW LEVEL SECURITY;
ALTER TABLE training_sessions NO FORCE ROW LEVEL SECURITY;

-- ─── Séance (table slots) ───────────────────────────────────────────────────
ALTER TABLE slots
  ADD COLUMN status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','published','done','cancelled')),
  ADD COLUMN version int NOT NULL DEFAULT 1,
  ADD COLUMN title text,
  ADD COLUMN modality text NOT NULL DEFAULT 'onsite' CHECK (modality IN ('onsite','remote','hybrid')),
  ADD COLUMN video_url text,
  ADD COLUMN breaks jsonb NOT NULL DEFAULT '[]',          -- [{startsAt, endsAt}] pauses non pédagogiques (UTC)
  ADD COLUMN group_label text,                            -- séance réservée à un groupe de la session
  ADD COLUMN notes text,
  ADD COLUMN cancel_reason text,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN series_id uuid,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN published_snapshot jsonb,                    -- version de référence diffusée
  ADD COLUMN derogation jsonb,                            -- {reason, rules[], by, at}
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE slots sl SET status = CASE
    WHEN ts.status = 'cancelled' THEN 'cancelled'
    WHEN ts.status IN ('completed','archived') THEN 'done'
    WHEN ts.status IN ('planned','confirmed','in_progress') THEN 'published'
    ELSE 'draft' END,
  cancel_reason = CASE WHEN ts.status = 'cancelled' THEN 'Session annulée' END,
  published_at = CASE WHEN ts.status NOT IN ('draft','cancelled') THEN now() END
  FROM training_sessions ts WHERE ts.id = sl.session_id;
UPDATE slots SET derogation = jsonb_build_object('reason', overlap_override_reason, 'rules', jsonb_build_array('overlap'))
 WHERE overlap_override_reason IS NOT NULL;

CREATE INDEX slots_range_idx ON slots (tenant_id, starts_at, ends_at) WHERE status <> 'cancelled';
CREATE INDEX slots_session_idx ON slots (tenant_id, session_id);

-- ─── Session : référence, effectifs, site, responsable, besoins ─────────────
ALTER TABLE training_sessions
  ADD COLUMN reference text,
  ADD COLUMN min_participants int CHECK (min_participants IS NULL OR min_participants >= 0),
  ADD COLUMN site_id uuid,
  ADD COLUMN responsible text,
  ADD COLUMN target_minutes int CHECK (target_minutes IS NULL OR target_minutes > 0),  -- défaut : durée du programme
  ADD COLUMN required_skills text[] NOT NULL DEFAULT '{}',
  ADD COLUMN required_equipment text[] NOT NULL DEFAULT '{}',
  ADD COLUMN color text,
  ADD COLUMN internal_notes text;

ALTER TABLE slots FORCE ROW LEVEL SECURITY;
ALTER TABLE training_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE training_sessions ADD CONSTRAINT training_sessions_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES resources(tenant_id, id);
CREATE UNIQUE INDEX training_sessions_reference_uq ON training_sessions (tenant_id, lower(reference)) WHERE reference IS NOT NULL;

-- Coanimation : intervenant principal ou coanimateur.
ALTER TABLE slot_trainers ADD COLUMN role text NOT NULL DEFAULT 'lead' CHECK (role IN ('lead','co'));

-- ─── Ressources : site, équipements, accessibilité, temps tampon, ouverture ─
ALTER TABLE resources
  ADD COLUMN site_id uuid,
  ADD COLUMN equipment text[] NOT NULL DEFAULT '{}',      -- ex. vidéoprojecteur, quai de chargement
  ADD COLUMN accessible boolean,                          -- accessibilité PMR renseignée
  ADD COLUMN setup_minutes int NOT NULL DEFAULT 0 CHECK (setup_minutes BETWEEN 0 AND 1440),
  ADD COLUMN teardown_minutes int NOT NULL DEFAULT 0 CHECK (teardown_minutes BETWEEN 0 AND 1440),
  ADD COLUMN opening_hours jsonb;                         -- {"1":[["08:00","18:00"]], …} (1 = lundi) ; NULL = sans contrainte
ALTER TABLE resources ADD CONSTRAINT resources_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES resources(tenant_id, id);

-- ─── Inscriptions : dates d'entrée / sortie, groupe ─────────────────────────
ALTER TABLE enrollments
  ADD COLUMN starts_on date,
  ADD COLUMN ends_on date,
  ADD COLUMN group_label text,
  ADD CONSTRAINT enrollments_dates_ck CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on);

-- ─── Participation à une séance : exceptions à la règle « inscrits de la session » ─
CREATE TABLE slot_participants (
  tenant_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('onsite','remote','excluded','to_resolve')),
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, slot_id, enrollment_id),
  FOREIGN KEY (tenant_id, slot_id) REFERENCES slots(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, enrollment_id) REFERENCES enrollments(tenant_id, id)
);

-- ─── Profil formateur ───────────────────────────────────────────────────────
CREATE TABLE trainer_profiles (
  tenant_id uuid NOT NULL,
  person_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'internal' CHECK (status IN ('internal','external')),
  allowed_site_ids uuid[] NOT NULL DEFAULT '{}',          -- vide = tous sites
  working_hours jsonb,                                    -- horaires habituels, même format qu'opening_hours
  max_weekly_minutes int CHECK (max_weekly_minutes IS NULL OR max_weekly_minutes > 0),
  travel_minutes int NOT NULL DEFAULT 0 CHECK (travel_minutes BETWEEN 0 AND 1440),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, person_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id)
);

-- ─── Disponibilités datées (prioritaires sur les horaires hebdomadaires) ────
CREATE TABLE availabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_type text NOT NULL CHECK (owner_type IN ('person','resource')),
  owner_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('unavailable','available')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,                                            -- congé, maintenance… (jamais de donnée médicale)
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected')),
  created_by uuid,
  decided_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX availabilities_owner_idx ON availabilities (tenant_id, owner_id, starts_at);

-- ─── Fermetures (centre entier ou site) et jours fériés ─────────────────────
CREATE TABLE closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  site_id uuid,                                           -- NULL = tout le centre
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES resources(tenant_id, id),
  CHECK (ends_on >= starts_on)
);

-- ─── Séries récurrentes (définies en heure locale) ──────────────────────────
CREATE TABLE planning_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL,
  rule jsonb NOT NULL,                                    -- {days, intervalWeeks, startDate, until|count, startTime, endTime, timezone, exclusions}
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES training_sessions(tenant_id, id)
);
ALTER TABLE slots ADD CONSTRAINT slots_series_fk FOREIGN KEY (tenant_id, series_id) REFERENCES planning_series(tenant_id, id);

-- ─── Journal des modifications (versions et différences) ────────────────────
CREATE TABLE planning_history (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  slot_id uuid NOT NULL,
  session_id uuid NOT NULL,
  version int NOT NULL,
  action text NOT NULL,                                   -- created, updated, moved, published, cancelled…
  actor_user_id uuid,
  at timestamptz NOT NULL DEFAULT now(),
  reason text,
  before jsonb,
  after jsonb,
  changes jsonb NOT NULL DEFAULT '[]',                    -- [{field, from, to}]
  rules jsonb                                             -- règles dérogées / contrôlées
);
CREATE INDEX planning_history_slot_idx ON planning_history (tenant_id, slot_id, id);
CREATE INDEX planning_history_session_idx ON planning_history (tenant_id, session_id, id);

-- ─── Changements à notifier (regroupés par personne, envoyés après commit) ──
CREATE TABLE planning_changes (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  person_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  kind text NOT NULL,                                     -- published, changed, cancelled, assigned, unassigned
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX planning_changes_pending_idx ON planning_changes (tenant_id, person_id) WHERE status IN ('pending','sending');

-- ─── Événements sortants (convocations, portails, émargement, visio) ────────
CREATE TABLE planning_events (
  seq bigserial PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type text NOT NULL,                                     -- slot.created, slot.moved, slot.published, slot.cancelled, slot.updated
  slot_id uuid NOT NULL,
  session_id uuid NOT NULL,
  version int NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);
CREATE INDEX planning_events_tenant_idx ON planning_events (tenant_id, seq);

-- ─── Paramètres du centre ───────────────────────────────────────────────────
CREATE TABLE planning_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  grid_step int NOT NULL DEFAULT 15 CHECK (grid_step IN (5,10,15,30,60)),
  day_start text NOT NULL DEFAULT '07:00',
  day_end text NOT NULL DEFAULT '20:00',
  workdays int[] NOT NULL DEFAULT '{1,2,3,4,5}',
  direct_publish boolean NOT NULL DEFAULT true,           -- petits centres : le planificateur publie
  overlap_derogable boolean NOT NULL DEFAULT false,       -- double réservation bloquante par défaut
  max_daily_minutes int NOT NULL DEFAULT 480,
  default_weekly_minutes int NOT NULL DEFAULT 2100,       -- 35 h : base de charge sans horaires habituels
  short_notice_hours int NOT NULL DEFAULT 48,
  unusual_before text NOT NULL DEFAULT '07:30',
  unusual_after text NOT NULL DEFAULT '19:30',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ─── Idempotence des écritures ──────────────────────────────────────────────
CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL,
  route text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

SELECT enable_tenant_rls(t) FROM unnest(ARRAY['slot_participants','trainer_profiles','availabilities','closures','planning_series',
  'planning_history','planning_changes','planning_events','planning_settings','idempotency_keys']::regclass[]) AS t;

-- ─── Fonctions de calcul partagées (lecture, contrôles, indicateurs) ────────
-- Durée pédagogique = durée totale moins pauses non pédagogiques.
CREATE FUNCTION slot_pedagogical_minutes(p_start timestamptz, p_end timestamptz, p_breaks jsonb) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT (extract(epoch FROM p_end - p_start) / 60
    - coalesce((SELECT sum(extract(epoch FROM (b->>'endsAt')::timestamptz - (b->>'startsAt')::timestamptz) / 60)
                  FROM jsonb_array_elements(p_breaks) b), 0))::int
$$;

-- Site d'une séance : lieu réservé, sinon site de la salle, sinon site de la session.
CREATE FUNCTION slot_site(p_slot uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT r.id FROM slot_resources sr JOIN resources r ON r.id = sr.resource_id WHERE sr.slot_id = p_slot AND r.kind = 'site' ORDER BY r.name LIMIT 1),
    (SELECT r.site_id FROM slot_resources sr JOIN resources r ON r.id = sr.resource_id WHERE sr.slot_id = p_slot AND r.site_id IS NOT NULL ORDER BY r.name LIMIT 1),
    (SELECT ts.site_id FROM slots sl JOIN training_sessions ts ON ts.id = sl.session_id WHERE sl.id = p_slot))
$$;

-- Participants attendus : inscrits actifs de la session (groupe de la séance), corrigés par les exceptions.
-- expected = attendu physiquement ou à distance ; dates_ok = inscription compatible avec la date de séance.
CREATE VIEW slot_expected WITH (security_invoker = true) AS
  SELECT sl.tenant_id, sl.id AS slot_id, sl.session_id, e.id AS enrollment_id, e.person_id,
         coalesce(sp.mode, CASE sl.modality WHEN 'remote' THEN 'remote' ELSE 'onsite' END) AS mode,
         sp.mode IS NOT NULL AS explicit, sp.reason,
         ((e.starts_on IS NULL OR e.starts_on <= (sl.starts_at AT TIME ZONE ts.timezone)::date)
          AND (e.ends_on IS NULL OR e.ends_on >= ((sl.ends_at - interval '1 second') AT TIME ZONE ts.timezone)::date)) AS dates_ok
    FROM slots sl
    JOIN training_sessions ts ON ts.id = sl.session_id
    JOIN enrollments e ON e.session_id = sl.session_id AND e.status <> 'cancelled'
                      AND (sl.group_label IS NULL OR e.group_label = sl.group_label)
    LEFT JOIN slot_participants sp ON sp.slot_id = sl.id AND sp.enrollment_id = e.id;
