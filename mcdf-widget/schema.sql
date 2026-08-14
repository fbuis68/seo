-- Modèle de données MCDF (prototype)
-- Périmètre couvert : clients (entreprises), stagiaires, formateurs, catalogue de
-- formations, sessions, inscriptions, devis, factures et conventions.
-- Conçu pour SQLite mais reste portable vers PostgreSQL (types simples, pas de
-- fonctionnalités propriétaires).

PRAGMA foreign_keys = ON;

CREATE TABLE clients (
    id              INTEGER PRIMARY KEY,
    nom             TEXT NOT NULL,
    secteur         TEXT,
    ville           TEXT,
    date_creation   TEXT NOT NULL   -- date d'entrée du client au fichier (ISO 8601)
);

CREATE TABLE stagiaires (
    id              INTEGER PRIMARY KEY,
    client_id       INTEGER NOT NULL REFERENCES clients(id),
    nom             TEXT NOT NULL,
    prenom          TEXT NOT NULL,
    email           TEXT,
    date_creation   TEXT NOT NULL   -- date de première apparition dans le fichier
);

CREATE TABLE formateurs (
    id              INTEGER PRIMARY KEY,
    nom             TEXT NOT NULL,
    prenom          TEXT NOT NULL,
    specialite      TEXT,
    tarif_jour      REAL NOT NULL
);

CREATE TABLE formations (
    id              INTEGER PRIMARY KEY,
    titre           TEXT NOT NULL,
    categorie       TEXT,
    duree_heures    INTEGER NOT NULL
);

CREATE TABLE sessions (
    id              INTEGER PRIMARY KEY,
    formation_id    INTEGER NOT NULL REFERENCES formations(id),
    formateur_id    INTEGER NOT NULL REFERENCES formateurs(id),
    salle           TEXT,
    date_debut      TEXT NOT NULL,
    date_fin        TEXT NOT NULL,
    capacite        INTEGER NOT NULL,
    statut          TEXT NOT NULL CHECK (statut IN ('planifiee','confirmee','realisee','annulee'))
);

CREATE TABLE inscriptions (
    id                  INTEGER PRIMARY KEY,
    session_id          INTEGER NOT NULL REFERENCES sessions(id),
    stagiaire_id        INTEGER NOT NULL REFERENCES stagiaires(id),
    date_inscription    TEXT NOT NULL,
    statut              TEXT NOT NULL CHECK (statut IN ('inscrit','present','absent','annule')),
    note_satisfaction   REAL   -- note à chaud sur 5, NULL si pas encore répondu
);

CREATE TABLE devis (
    id              INTEGER PRIMARY KEY,
    client_id       INTEGER NOT NULL REFERENCES clients(id),
    montant         REAL NOT NULL,
    date_creation   TEXT NOT NULL,
    statut          TEXT NOT NULL CHECK (statut IN ('en_attente','signe','refuse','expire')),
    date_reponse    TEXT
);

CREATE TABLE factures (
    id                  INTEGER PRIMARY KEY,
    client_id           INTEGER NOT NULL REFERENCES clients(id),
    session_id          INTEGER REFERENCES sessions(id),
    montant             REAL NOT NULL,
    date_emission       TEXT NOT NULL,
    statut_paiement     TEXT NOT NULL CHECK (statut_paiement IN ('payee','en_attente','retard'))
);

CREATE TABLE conventions (
    id                  INTEGER PRIMARY KEY,
    session_id          INTEGER NOT NULL REFERENCES sessions(id),
    client_id           INTEGER NOT NULL REFERENCES clients(id),
    statut_signature    TEXT NOT NULL CHECK (statut_signature IN ('signee','en_attente','absente')),
    date_signature       TEXT
);

CREATE INDEX idx_stagiaires_client ON stagiaires(client_id);
CREATE INDEX idx_inscriptions_session ON inscriptions(session_id);
CREATE INDEX idx_inscriptions_stagiaire ON inscriptions(stagiaire_id);
CREATE INDEX idx_sessions_dates ON sessions(date_debut, date_fin);
CREATE INDEX idx_devis_client ON devis(client_id);
CREATE INDEX idx_factures_client ON factures(client_id);
