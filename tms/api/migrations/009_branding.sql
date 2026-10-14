-- Identité visuelle de l'organisme : logo (interface + documents) et préférences de couleurs.
CREATE TABLE tenant_branding (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  logo_png bytea,                                   -- interface (transparence conservée)
  logo_jpeg bytea,                                  -- documents PDF (fond blanc)
  logo_width int, logo_height int,
  accent_color text CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  sidebar_color text CHECK (sidebar_color ~ '^#[0-9a-fA-F]{6}$'),
  doc_color text CHECK (doc_color ~ '^#[0-9a-fA-F]{6}$'),
  theme text NOT NULL DEFAULT 'auto' CHECK (theme IN ('auto','light','dark')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(logo_png) <= 600000 AND octet_length(logo_jpeg) <= 600000)
);
SELECT enable_tenant_rls('tenant_branding');
