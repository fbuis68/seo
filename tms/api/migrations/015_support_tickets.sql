-- Signalements « Signaler un problème » : table éditeur (hors RLS, comme users/tenants),
-- l'accès est filtré par l'application (l'utilisateur voit ses tickets, l'éditeur voit tout).
CREATE SEQUENCE IF NOT EXISTS support_ticket_seq;
CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number int NOT NULL DEFAULT nextval('support_ticket_seq') UNIQUE,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  role text,
  screen text NOT NULL,                      -- chemin de l'écran (/clients…)
  feature text,                              -- fonction concernée (titre de l'écran ou action)
  category text NOT NULL DEFAULT 'bug' CHECK (category IN ('bug','question','evolution')),
  severity text NOT NULL DEFAULT 'normal' CHECK (severity IN ('blocking','normal','minor')),
  message text NOT NULL,
  expected text,
  context jsonb NOT NULL DEFAULT '{}',       -- navigateur, version, dernières erreurs serveur
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','fixed','wont_fix','duplicate')),
  resolution text,
  exported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_user_idx ON support_tickets (user_id, created_at DESC);
