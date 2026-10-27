-- Mot de passe oublié : lien à usage unique, valable 1 heure, seul le hachage du jeton est stocké.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  requested_ip text
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id, created_at DESC);
