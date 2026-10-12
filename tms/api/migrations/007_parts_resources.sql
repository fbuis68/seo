-- Sessions découpées en parties, plusieurs formateurs par créneau, ressources (lieux, salles, matériel).
-- Reprise sans perte des anciennes colonnes slots.room_id / slots.trainer_id et de la table rooms.

-- La migration tourne sous le propriétaire des tables, soumis à la RLS forcée : sans cette levée
-- temporaire, les copies ci-dessous ne verraient aucune ligne existante (perte silencieuse).
ALTER TABLE rooms NO FORCE ROW LEVEL SECURITY;
ALTER TABLE slots NO FORCE ROW LEVEL SECURITY;

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('site','room','equipment')),
  name text NOT NULL,
  category text,                                   -- ex. « Chariot élévateur cat. 3 », « Nacelle 1B »
  location text,                                   -- lieu / site de rattachement
  address text,
  capacity int CHECK (capacity IS NULL OR capacity > 0),
  serial_number text,                              -- matériel : n° de série / immatriculation
  inspection_due_on date,                          -- matériel : prochaine vérification générale périodique (VGP)
  notes text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
INSERT INTO resources(id, tenant_id, kind, name, location, capacity)
  SELECT id, tenant_id, 'room', name, location, capacity FROM rooms;

CREATE TABLE session_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  title text NOT NULL,
  planned_minutes int NOT NULL CHECK (planned_minutes > 0),
  position int NOT NULL DEFAULT 1,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES training_sessions(tenant_id, id)
);

ALTER TABLE slots ADD COLUMN part_id uuid;
ALTER TABLE slots ADD CONSTRAINT slots_part_fk FOREIGN KEY (tenant_id, part_id) REFERENCES session_parts(tenant_id, id);

CREATE TABLE slot_trainers (
  tenant_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  person_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, slot_id, person_id),
  FOREIGN KEY (tenant_id, slot_id) REFERENCES slots(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, person_id) REFERENCES persons(tenant_id, id)
);
CREATE INDEX slot_trainers_person_idx ON slot_trainers (tenant_id, person_id);

CREATE TABLE slot_resources (
  tenant_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, slot_id, resource_id),
  FOREIGN KEY (tenant_id, slot_id) REFERENCES slots(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id)
);
CREATE INDEX slot_resources_res_idx ON slot_resources (tenant_id, resource_id);

INSERT INTO slot_trainers(tenant_id, slot_id, person_id) SELECT tenant_id, id, trainer_id FROM slots WHERE trainer_id IS NOT NULL;
INSERT INTO slot_resources(tenant_id, slot_id, resource_id) SELECT tenant_id, id, room_id FROM slots WHERE room_id IS NOT NULL;

ALTER TABLE slots DROP COLUMN trainer_id;
ALTER TABLE slots DROP COLUMN room_id;
DROP TABLE rooms;
ALTER TABLE slots FORCE ROW LEVEL SECURITY;

SELECT enable_tenant_rls(t) FROM unnest(ARRAY['resources','session_parts','slot_trainers','slot_resources']::regclass[]) AS t;
