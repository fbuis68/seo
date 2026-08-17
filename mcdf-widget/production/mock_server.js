#!/usr/bin/env node
/**
 * Serveur local (Node.js) pour tester widget-ia.html avec des données fictives.
 *
 * Équivalent de mock_server.py, pour ceux qui ont déjà Node.js plutôt que
 * Python. Aucune dépendance externe (pas de npm install) — juste les
 * modules natifs http/fs/path/url.
 *
 * Sert le widget de production **sans le modifier** et répond aux appels
 * `/wa/{entite}/list` avec des données générées en mémoire, dans le même
 * format que la vraie API MCDF (`{"success": true, "root": [...]}`) et
 * avec les mêmes noms de champs (camelCase, `entityId`, dates ISO...).
 *
 * Usage :
 *   node mock_server.js [--port 8000]
 *   puis ouvrir http://localhost:8000/widget-ia.html?entityId=E00000361
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ENTITY_ID = 'E00000361';
const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);

const PRENOMS = [
  'Camille', 'Lucas', 'Manon', 'Hugo', 'Chloé', 'Léo', 'Emma', 'Nathan',
  'Julie', 'Louis', 'Sarah', 'Adam', 'Léa', 'Enzo', 'Inès', 'Raphaël',
  'Zoé', 'Mathis', 'Jade', 'Noah', 'Lina', 'Gabriel', 'Anna', 'Tom',
];
const NOMS = [
  'Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Petit', 'Durand',
  'Leroy', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia',
];
const RAISONS = ['Solutions', 'Groupe', 'Industries', 'Services', 'Consulting', 'Partners'];
const FORMATIONS = [
  'Excel Perfectionnement', "Management d'équipe", 'Gestion de projet',
  'Anglais professionnel', 'SST - Sauveteur Secouriste du Travail',
  'Habilitation électrique', 'Négociation commerciale', 'Excel VBA',
];

function choice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function seq(prefix, n, width = 8) { return prefix + String(n).padStart(width, '0'); }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function minDate(a, b) { return a < b ? a : b; }
function isoWithTime(date) {
  const d = new Date(date);
  d.setHours(randInt(8, 18), randInt(0, 59), randInt(0, 59));
  return d.toISOString();
}

function genData() {
  const startHistory = addDays(TODAY, -730);

  const customers = [];
  let cid = 0;
  let monthCursor = new Date(startHistory.getFullYear(), startHistory.getMonth(), 1);
  while (monthCursor <= TODAY) {
    const isCurrentMonth = monthCursor.getFullYear() === TODAY.getFullYear() && monthCursor.getMonth() === TODAY.getMonth();
    const maxDay = isCurrentMonth ? TODAY.getDate() : 28;
    const n = randInt(1, 4);
    for (let i = 0; i < n; i++) {
      const d = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), randInt(1, maxDay));
      const name = `${choice(NOMS)} ${choice(RAISONS)}`;
      customers.push({ id: seq('C', 61000 + cid), entityId: ENTITY_ID, name, created: isoWithTime(d) });
      cid++;
    }
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
  }

  const trainers = [];
  for (let i = 0; i < 8; i++) {
    trainers.push({ id: seq('A', 118400 + i), name: `${choice(NOMS)} ${choice(PRENOMS)}` });
  }

  const sessions = [];
  let sid = 0;
  let d = new Date(startHistory);
  const sessionsEnd = addDays(TODAY, 30);
  while (d <= sessionsEnd) {
    if (Math.random() < 0.3) {
      const trainer = choice(trainers);
      const daysN = choice([1, 2, 3]);
      const maxi = choice([6, 8, 10, 12]);
      sessions.push({
        id: seq('S', 33600 + sid), entityId: ENTITY_ID,
        name: choice(FORMATIONS), trainerId: trainer.id, trainerName: trainer.name,
        startDate: new Date(d).toISOString(), endDate: addDays(d, daysN - 1).toISOString(),
        days: daysN, dailyRate: 700, numberMini: Math.max(2, maxi - 4), numberMaxi: maxi,
        created: isoWithTime(addDays(d, -randInt(5, 30))),
      });
      sid++;
    }
    d = addDays(d, 1);
  }

  const conventions = [];
  const conventionAttendees = [];
  const invoices = [];
  let convI = 0, attI = 0, invI = 0;

  for (const cust of customers) {
    const n = randInt(1, 3);
    for (let k = 0; k < n; k++) {
      const custCreated = new Date(cust.created);
      const provisional = minDate(addDays(custCreated, randInt(0, 550)), TODAY);
      const age = Math.floor((TODAY - provisional) / 86400000);
      let isConvention = false, signingDate = null, status = 'en_attente';
      if (age >= 10) {
        const r = Math.random();
        if (r < 0.55) { isConvention = true; signingDate = isoWithTime(addDays(provisional, randInt(1, 20))); status = 'signe'; }
        else if (r < 0.75) status = 'refuse';
        else if (r < 0.9) status = 'expire';
      }
      const convId = seq('C', 20300 + convI);
      conventions.push({
        id: convId, entityId: ENTITY_ID,
        name: `Formation ${choice(FORMATIONS)} — ${cust.name}`,
        proposalCode: seq('PR', convI, 5), proposalStatus: status,
        isProposal: true, isConvention,
        provisionalDate: provisional.toISOString(), signingDate,
        created: isoWithTime(provisional),
      });
      convI++;

      if (isConvention) {
        const nbAtt = randInt(1, 6);
        for (let a = 0; a < nbAtt; a++) {
          const created = minDate(addDays(provisional, randInt(0, 20)), TODAY);
          const attendeeId = seq('A', 200000 + attI);
          conventionAttendees.push({
            id: seq('CA', 75400 + attI), entityId: ENTITY_ID,
            conventionId: convId, actorId: attendeeId, attendeeId,
            fullname: `${choice(NOMS)} ${choice(PRENOMS)}`, attendee: true,
            created: isoWithTime(created),
          });
          attI++;
        }
        if (Math.random() > 0.25) {
          const nbInv = randInt(1, 2);
          for (let iv = 0; iv < nbInv; iv++) {
            const billing = minDate(addDays(provisional, randInt(15, 90)), TODAY);
            invoices.push({
              id: `F${String(invI + 1).padStart(5, '0')}`, entityId: ENTITY_ID, conventionId: convId,
              amount: Math.round((800 + Math.random() * (9000 - 800)) * 100) / 100,
              billingDate: billing.toISOString(),
              created: isoWithTime(billing),
            });
            invI++;
          }
        }
      }
    }
  }

  return { customer: customers, convention: conventions, invoice: invoices, conventionAttendee: conventionAttendees, session: sessions };
}

const DATA = genData();
const DIR = __dirname;

let port = 8000;
const portIdx = process.argv.indexOf('--port');
if (portIdx !== -1 && process.argv[portIdx + 1]) port = parseInt(process.argv[portIdx + 1], 10);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  if (p.startsWith('/wa/') && p.endsWith('/list')) {
    const entity = p.split('/')[2];
    const rows = DATA[entity] || [];
    const body = JSON.stringify({ success: true, root: rows });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
    return;
  }

  let filePath = path.join(DIR, p === '/' ? '/widget-ia.html' : p);
  if (!filePath.startsWith(DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const ctype = ext === '.html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': ctype });
    res.end(content);
  });
});

server.listen(port, '127.0.0.1', () => {
  const counts = Object.fromEntries(Object.entries(DATA).map(([k, v]) => [k, v.length]));
  console.log('Données fictives générées :', counts);
  console.log(`→ http://127.0.0.1:${port}/widget-ia.html?entityId=${ENTITY_ID}`);
  console.log('Ctrl+C pour arrêter.');
});
