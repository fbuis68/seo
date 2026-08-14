-- Modèle de données MCDF (prototype v2)
-- Réécrit pour suivre les VRAIS noms d'entités et de champs de l'API MCDF
-- (portal.moncentredeformation.fr / Serigest Premium), découverts par
-- capture réseau (voir mcdf-widget/browser/live-reports.js) : customer,
-- company, actor, convention, conventionAttendee, invoice, session.
--
-- Différences volontaires avec la v1 (schéma inventé) :
--   - stagiaires ET formateurs sont unifiés dans une seule table `actor`,
--     distingués par des indicateurs booléens (attendee/trainer/contact/
--     account_manager/candidate), comme dans le vrai système.
--   - devis, dossiers/conventions ET modèles sont unifiés dans une seule
--     table `convention`, distingués par is_proposal/is_convention.
--   - `customer` (payeur) et `company` (organisation) sont deux tables
--     distinctes, comme dans le vrai système (une company peut exister
--     sans être cliente).
--   - `convention_attendee` est la table de jonction stagiaire<->convention
--     confirmée dans l'API réelle.
--
-- Simplification assumée : `convention_attendee.session_id` n'a PAS été
-- confirmé dans l'API réelle (la vraie jonction session<->convention
-- passe probablement par une entité `conventionTraining` non explorée).
-- Il est ajouté ici pour pouvoir calculer un vrai taux de remplissage
-- dans ce prototype — à corriger dès que cette entité sera confirmée.

PRAGMA foreign_keys = ON;

CREATE TABLE entity (
    id      TEXT PRIMARY KEY,     -- ex: 'E00000361'
    name    TEXT NOT NULL         -- ex: 'DEMO'
);

CREATE TABLE company (
    id              TEXT PRIMARY KEY,   -- ex: 'C00061144'
    entity_id       TEXT NOT NULL REFERENCES entity(id),
    name            TEXT NOT NULL,
    siret           TEXT,
    address         TEXT,
    city            TEXT,
    postal_code     TEXT,
    email           TEXT,
    phone           TEXT,
    created         TEXT NOT NULL,      -- ISO 8601 avec heure, comme l'API réelle
    updated         TEXT
);

CREATE TABLE customer (
    id                  TEXT PRIMARY KEY,   -- ex: 'C00112593'
    entity_id           TEXT NOT NULL REFERENCES entity(id),
    company_id          TEXT REFERENCES company(id),
    name                TEXT NOT NULL,
    type                TEXT,                -- 'company' | 'individual'
    prospect            INTEGER NOT NULL DEFAULT 0,
    financer            INTEGER NOT NULL DEFAULT 0,   -- OPCA / organisme financeur
    status              TEXT,
    email               TEXT,
    city                TEXT,
    account_manager_id  TEXT,
    created             TEXT NOT NULL,
    updated             TEXT
);

CREATE TABLE actor (
    id                  TEXT PRIMARY KEY,   -- ex: 'A00118476' ou 'CA00075408'
    entity_id           TEXT NOT NULL REFERENCES entity(id),
    company_id          TEXT REFERENCES company(id),
    civility            TEXT,
    firstname           TEXT,
    lastname            TEXT,
    fullname            TEXT NOT NULL,
    email               TEXT,
    cell_phone          TEXT,
    attendee            INTEGER NOT NULL DEFAULT 0,   -- stagiaire
    trainer             INTEGER NOT NULL DEFAULT 0,   -- formateur
    contact             INTEGER NOT NULL DEFAULT 0,   -- contact entreprise
    account_manager     INTEGER NOT NULL DEFAULT 0,   -- chargé de compte
    candidate           INTEGER NOT NULL DEFAULT 0,
    activated           INTEGER NOT NULL DEFAULT 1,
    archived            INTEGER NOT NULL DEFAULT 0,
    created             TEXT NOT NULL,
    updated             TEXT
);

CREATE TABLE session (
    id                  TEXT PRIMARY KEY,   -- ex: 'S00033605'
    entity_id           TEXT NOT NULL REFERENCES entity(id),
    name                TEXT NOT NULL,
    code                TEXT,
    discipline_name     TEXT,
    trainer_id          TEXT REFERENCES actor(id),
    trainer_name        TEXT,
    room_name           TEXT,
    start_date          TEXT NOT NULL,
    end_date            TEXT NOT NULL,
    hours               INTEGER,
    days                INTEGER,
    daily_rate          REAL,
    hourly_rate         REAL,
    number_mini         INTEGER,
    number_maxi         INTEGER,
    opened              INTEGER NOT NULL DEFAULT 0,
    activated           INTEGER NOT NULL DEFAULT 1,
    created             TEXT NOT NULL,
    updated             TEXT
);

CREATE TABLE convention (
    id                  TEXT PRIMARY KEY,   -- ex: 'C00020404'
    entity_id           TEXT NOT NULL REFERENCES entity(id),
    name                TEXT NOT NULL,
    code                TEXT,
    proposal_code       TEXT,
    customer_id         TEXT REFERENCES customer(id),
    account_manager_id  TEXT REFERENCES actor(id),
    is_proposal         INTEGER NOT NULL DEFAULT 0,
    is_convention       INTEGER NOT NULL DEFAULT 0,
    proposal_status     TEXT,                -- 'en_attente' | 'signe' | 'refuse' | 'expire'
    convention_status   TEXT,
    provisional_date    TEXT,                -- date d'émission du devis
    signing_date         TEXT,                -- date de signature (NULL si non signé)
    start_date          TEXT,
    end_date            TEXT,
    hours               REAL,
    invoiced             INTEGER NOT NULL DEFAULT 0,
    invoiced_hours       REAL,
    created             TEXT NOT NULL,
    updated             TEXT
);

CREATE TABLE convention_attendee (
    id                  TEXT PRIMARY KEY,   -- ex: 'CA00075408'
    entity_id           TEXT NOT NULL REFERENCES entity(id),
    convention_id       TEXT NOT NULL REFERENCES convention(id),
    actor_id            TEXT NOT NULL REFERENCES actor(id),
    session_id          TEXT REFERENCES session(id),  -- simplification, cf. note en tête de fichier
    created             TEXT NOT NULL       -- date d'inscription
);

CREATE TABLE invoice (
    id                  TEXT PRIMARY KEY,   -- ex: 'F01178'
    entity_id           TEXT NOT NULL REFERENCES entity(id),
    convention_id       TEXT REFERENCES convention(id),
    payer_name          TEXT,
    amount              REAL NOT NULL,       -- montant HT
    ttc_amount          REAL,
    balance             REAL,
    billing_date        TEXT NOT NULL,
    payment_date        TEXT,
    status              TEXT,                -- 'payee' | 'en_attente' | 'retard'
    created             TEXT NOT NULL,
    updated             TEXT
);

CREATE INDEX idx_customer_entity ON customer(entity_id);
CREATE INDEX idx_actor_entity ON actor(entity_id);
CREATE INDEX idx_actor_flags ON actor(attendee, trainer, account_manager);
CREATE INDEX idx_session_entity ON session(entity_id);
CREATE INDEX idx_session_trainer ON session(trainer_id);
CREATE INDEX idx_convention_entity ON convention(entity_id);
CREATE INDEX idx_convention_customer ON convention(customer_id);
CREATE INDEX idx_convention_attendee_convention ON convention_attendee(convention_id);
CREATE INDEX idx_convention_attendee_actor ON convention_attendee(actor_id);
CREATE INDEX idx_convention_attendee_session ON convention_attendee(session_id);
CREATE INDEX idx_invoice_entity ON invoice(entity_id);
CREATE INDEX idx_invoice_convention ON invoice(convention_id);
