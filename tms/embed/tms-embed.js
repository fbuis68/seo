/*!
 * Widget de souscription en ligne — tarifs, configurateur de modules et inscription.
 * Intégration sur n'importe quel site (WordPress compris) :
 *
 *   <div data-tms-widget data-api="https://api.votre-domaine.fr" data-show="pricing,modules,signup"></div>
 *   <script src="https://api.votre-domaine.fr/embed/v1/tms-embed.js" defer></script>
 *
 * Attributs : data-api (obligatoire), data-show (pricing|modules|signup, combinables),
 * data-plan (offre présélectionnée), data-interval (month|year), data-accent (#couleur),
 * data-theme (light|dark|auto), data-source (étiquette d'origine), data-title.
 * Événements émis sur l'élément hôte : tms:ready, tms:plan-selected, tms:signup.
 * Aucun montant n'est transmis au serveur : il recalcule tout à partir de l'offre choisie.
 */
(function () {
  'use strict';
  if (window.__tmsEmbedLoaded) return;
  window.__tmsEmbedLoaded = true;

  var scriptSrc = (document.currentScript && document.currentScript.src) || '';
  var defaultApi = scriptSrc ? scriptSrc.replace(/\/embed\/v1\/.*$/, '') : '';

  var LIMIT_LABELS = [
    ['managers', function (v) { return v + (v > 1 ? ' gestionnaires' : ' gestionnaire'); }],
    ['billedClients', function (v) { return v === null ? 'Clients sans quota' : v + ' clients facturés'; }],
    ['learnersPerYear', function (v) { return fmtInt(v) + ' apprenants / an'; }],
    ['activeSessions', function (v) { return v === null ? 'Sessions sans quota' : v + ' sessions actives'; }],
    ['storageBytes', function (v) { return Math.round(v / 1073741824) + ' Go de stockage'; }],
    ['emailsPerMonth', function (v) { return fmtInt(v) + ' emails / mois'; }],
    ['signatureEnvelopesPerMonth', function (v) { return v ? v + ' signatures électroniques / mois' : 'Signature électronique : non incluse'; }],
    ['aiRequestsPerMonth', function (v) { return fmtInt(v) + ' requêtes IA / mois (votre clé)'; }],
  ];

  function fmtInt(n) { return Number(n).toLocaleString('fr-FR'); }
  function fmtEur(cents, decimals) {
    return (cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: decimals ? 2 : 0, maximumFractionDigits: 2 }) + ' €';
  }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (children || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function safeColor(c) { return /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#2457d6'; }

  var CSS = [
    ':host{all:initial;display:block;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);--accent:#2457d6;--bg:#fff;--fg:#14161a;--muted:#5d6470;--line:#e3e6eb;--card:#fff;--soft:#f5f7fa;--ok:#1b7f4b;--err:#b42318}',
    ':host([data-dark]){--bg:#111317;--fg:#eef0f3;--muted:#a5acb8;--line:#2b2f37;--card:#181b20;--soft:#1e2228;--ok:#4cc38a;--err:#ff8a80}',
    '*{box-sizing:border-box}.wrap{background:var(--bg);padding:8px 0;line-height:1.45}',
    'h2{font-size:1.6rem;margin:0 0 4px}h3{font-size:1.15rem;margin:0}p{margin:0}.muted{color:var(--muted);font-size:.92rem}',
    '.head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}',
    '.toggle{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:3px;background:var(--soft)}',
    '.toggle button{border:0;background:transparent;color:var(--fg);padding:6px 14px;border-radius:999px;cursor:pointer;font:inherit;font-size:.9rem}',
    '.toggle button[aria-pressed=true]{background:var(--accent);color:#fff}',
    '.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}',
    '.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:10px;position:relative}',
    '.card.hl{border:2px solid var(--accent)}.card.sel{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 35%,transparent)}',
    '.badge{position:absolute;top:-11px;left:16px;background:var(--accent);color:#fff;font-size:.75rem;padding:2px 10px;border-radius:999px}',
    '.price{font-size:1.9rem;font-weight:700}.price small{font-size:.85rem;font-weight:400;color:var(--muted)}',
    'ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:.92rem}li:before{content:"✓ ";color:var(--ok)}li.no:before{content:"– ";color:var(--muted)}',
    '.btn{appearance:none;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:10px;padding:10px 14px;font:inherit;font-weight:600;cursor:pointer;text-align:center}',
    '.btn.ghost{background:transparent;color:var(--accent)}.btn:disabled{opacity:.6;cursor:not-allowed}',
    '.btn:focus-visible,.toggle button:focus-visible,input:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 50%,transparent);outline-offset:2px}',
    'section{margin-top:28px}.mods{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}',
    '.mod{border:1px solid var(--line);border-radius:12px;padding:12px;background:var(--soft)}.mod h4{margin:0 0 4px;font-size:1rem}',
    '.tag{display:inline-block;font-size:.72rem;border-radius:6px;padding:1px 6px;margin-left:6px;background:var(--line);color:var(--fg)}',
    '.addon{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card)}',
    '.addon input[type=number]{width:60px}.total{display:flex;justify-content:space-between;align-items:baseline;padding:12px;border-radius:10px;background:var(--soft);margin-top:10px;font-weight:600}',
    'form{display:grid;gap:12px;grid-template-columns:1fr 1fr}form .full{grid-column:1/-1}',
    'label{display:flex;flex-direction:column;gap:4px;font-size:.88rem;font-weight:600}',
    'input[type=text],input[type=email],input[type=password],input[type=number]{font:inherit;font-weight:400;padding:9px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);width:100%}',
    '.check{flex-direction:row;align-items:flex-start;gap:8px;font-weight:400}.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}',
    '.msg{padding:10px 12px;border-radius:10px;font-size:.92rem}.msg.ok{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}.msg.err{background:color-mix(in srgb,var(--err) 12%,transparent);color:var(--err)}',
    'a{color:var(--accent)}.foot{margin-top:10px;font-size:.8rem;color:var(--muted)}',
    '@media (max-width:560px){form{grid-template-columns:1fr}.price{font-size:1.6rem}}',
  ].join('\n');

  function Widget(host) {
    this.host = host;
    this.api = (host.getAttribute('data-api') || defaultApi).replace(/\/$/, '');
    this.show = (host.getAttribute('data-show') || 'pricing,modules,signup').split(',').map(function (s) { return s.trim(); });
    this.state = { interval: host.getAttribute('data-interval') === 'year' ? 'year' : 'month', plan: host.getAttribute('data-plan') || null, addons: {}, trial: false };
    this.root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var theme = host.getAttribute('data-theme') || 'auto';
    if (theme === 'dark' || (theme === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches)) host.setAttribute('data-dark', '');
    host.style.setProperty('--accent', safeColor(host.getAttribute('data-accent')));
    var style = el('style'); style.textContent = CSS;
    this.root.appendChild(style);
    this.container = el('div', { class: 'wrap' }, [el('p', { class: 'muted', text: 'Chargement des offres…' })]);
    this.root.appendChild(this.container);
    this.load();
  }

  Widget.prototype.emit = function (name, detail) {
    this.host.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true, composed: true }));
  };

  Widget.prototype.load = function () {
    var self = this;
    fetch(this.api + '/api/v1/public/catalog', { credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (cat) {
        self.cat = cat;
        if (self.state.plan && !cat.plans.some(function (p) { return p.code === self.state.plan; })) self.state.plan = null;
        self.render(); self.emit('tms:ready', { plans: cat.plans.length });
      })
      .catch(function () {
        self.container.textContent = '';
        self.container.appendChild(el('p', { class: 'msg err', role: 'alert', text: 'Les offres sont momentanément indisponibles. Réessayez plus tard.' }));
      });
  };

  Widget.prototype.plan = function (code) { return this.cat.plans.filter(function (p) { return p.code === code; })[0]; };

  Widget.prototype.render = function () {
    var c = this.container; c.textContent = '';
    if (this.show.indexOf('pricing') >= 0) c.appendChild(this.renderPricing());
    if (this.show.indexOf('modules') >= 0) c.appendChild(this.renderModules());
    if (this.show.indexOf('signup') >= 0) c.appendChild(this.renderSignup());
  };

  Widget.prototype.priceOf = function (p) {
    return this.state.interval === 'year' ? p.yearlyPriceCents : p.monthlyPriceCents;
  };

  Widget.prototype.renderPricing = function () {
    var self = this, cat = this.cat;
    var toggle = el('div', { class: 'toggle', role: 'group', 'aria-label': 'Périodicité' }, [
      el('button', { type: 'button', 'aria-pressed': String(self.state.interval === 'month'), onclick: function () { self.state.interval = 'month'; self.render(); }, text: 'Mensuel' }),
      el('button', { type: 'button', 'aria-pressed': String(self.state.interval === 'year'), onclick: function () { self.state.interval = 'year'; self.render(); }, text: 'Annuel · 2 mois offerts' }),
    ]);
    var grid = el('div', { class: 'grid' }, cat.plans.map(function (p) {
      var price = self.priceOf(p);
      var monthlyEq = self.state.interval === 'year' && price ? ' soit ' + fmtEur(Math.round(price / 12), true) + ' HT / mois' : '';
      var limits = LIMIT_LABELS.map(function (l) {
        var v = p.limits[l[0]];
        return el('li', { class: l[0] === 'signatureEnvelopesPerMonth' && !v ? 'no' : '' , text: l[1](v) });
      });
      var selected = self.state.plan === p.code;
      return el('article', { class: 'card' + (p.highlighted ? ' hl' : '') + (selected ? ' sel' : ''), 'aria-label': 'Offre ' + p.name }, [
        p.highlighted ? el('span', { class: 'badge', text: 'Le plus choisi' }) : null,
        el('h3', { text: p.name }), el('p', { class: 'muted', text: p.tagline }),
        el('div', { class: 'price' }, [price ? fmtEur(price) : '0 €', el('small', { text: price ? (self.state.interval === 'year' ? ' HT / an' : ' HT / mois') : ' sans carte bancaire' })]),
        monthlyEq ? el('p', { class: 'muted', text: monthlyEq.trim() }) : null,
        el('ul', null, limits.concat([el('li', { text: p.support })])),
        el('button', { type: 'button', class: 'btn' + (selected ? '' : ' ghost'), 'aria-pressed': String(selected), onclick: function () { self.select(p.code); },
          text: p.code === 'free' ? 'Commencer gratuitement' : selected ? 'Offre sélectionnée' : 'Choisir ' + p.name }),
      ]);
    }));
    return el('section', { 'aria-labelledby': 'tms-pricing-title' }, [
      el('div', { class: 'head' }, [el('div', null, [el('h2', { id: 'tms-pricing-title', text: this.host.getAttribute('data-title') || 'Nos offres' }),
        el('p', { class: 'muted', text: 'Prix HT. Sans engagement en mensuel. ' + (cat.annualRule || '') })]), toggle]),
      grid,
      el('p', { class: 'foot', text: 'Réversibilité incluse dans toutes les offres : export complet de vos données et documents à tout moment.' }),
    ]);
  };

  Widget.prototype.select = function (code) {
    this.state.plan = code;
    if (code === 'free') { this.state.addons = {}; this.state.trial = false; }
    this.emit('tms:plan-selected', { plan: code, interval: this.state.interval });
    this.render();
    var form = this.root.querySelector('#tms-signup');
    if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  Widget.prototype.renderModules = function () {
    var cat = this.cat;
    var includedIn = function (key) {
      var names = cat.plans.filter(function (p) { return p.features.indexOf(key) >= 0; }).map(function (p) { return p.name; });
      return names.length === cat.plans.length ? 'Toutes les offres' : names.length ? names.join(', ') : 'En option';
    };
    return el('section', { 'aria-labelledby': 'tms-mod-title' }, [
      el('h2', { id: 'tms-mod-title', text: 'Une application modulaire' }),
      el('p', { class: 'muted', text: 'Activez les modules dont vous avez besoin ; le socle de gestion reste simple.' }),
      el('div', { class: 'mods', style: 'margin-top:12px' }, cat.modules.map(function (m) {
        return el('div', { class: 'mod' }, [
          el('h4', null, [m.name, m.priority === 'P1' ? el('span', { class: 'tag', text: 'bientôt' }) : null]),
          el('p', { class: 'muted', text: m.description }), el('p', { class: 'muted', style: 'margin-top:6px;font-size:.8rem', text: includedIn(m.key) }),
        ]);
      })),
    ]);
  };

  Widget.prototype.renderAddons = function () {
    var self = this, plan = this.plan(this.state.plan);
    if (!plan || plan.code === 'free') return null;
    var recurring = this.cat.addons.filter(function (a) { return a.recurring; });
    var rows = recurring.map(function (a) {
      var disabled = a.availability === 'coming_soon';
      var checked = !!self.state.addons[a.code];
      var qty = el('input', { type: 'number', min: '1', max: '10', value: String(self.state.addons[a.code] || 1), 'aria-label': 'Quantité ' + a.name,
        disabled: disabled || !checked || !a.perUnit, onchange: function (e) { self.state.addons[a.code] = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)); self.render(); } });
      return el('label', { class: 'addon check' }, [
        el('input', { type: 'checkbox', checked: checked, disabled: disabled, onchange: function (e) { if (e.target.checked) self.state.addons[a.code] = 1; else delete self.state.addons[a.code]; self.render(); } }),
        el('span', { style: 'flex:1' }, [
          el('strong', { text: a.name }), disabled ? el('span', { class: 'tag', text: 'bientôt disponible' }) : a.availability === 'beta' ? el('span', { class: 'tag', text: 'bêta' }) : null,
          el('br'), el('span', { class: 'muted', text: a.description }), el('br'),
          el('span', { class: 'muted', text: fmtEur(a.priceCents, true) + ' HT / mois' + (a.perUnit ? ' / ' + a.perUnit : '') }),
        ]),
        a.perUnit ? qty : null,
      ]);
    });
    var months = this.state.interval === 'year' ? 10 : 1;
    var total = this.priceOf(plan) + recurring.reduce(function (s, a) { return s + (self.state.addons[a.code] ? a.priceCents * self.state.addons[a.code] * months : 0); }, 0);
    var trialAvailable = this.cat.trialDays > 0;
    return el('div', { class: 'full', style: 'display:grid;gap:8px' }, [
      el('strong', { text: 'Options' })].concat(rows).concat([
      el('div', { class: 'total', 'aria-live': 'polite' }, [el('span', { text: 'Total estimé' }), el('span', { text: fmtEur(total, true) + (this.state.interval === 'year' ? ' HT / an' : ' HT / mois') })]),
      trialAvailable ? el('label', { class: 'check' }, [el('input', { type: 'checkbox', checked: this.state.trial, onchange: function (e) { self.state.trial = e.target.checked; } }),
        el('span', { text: 'Démarrer par un essai de ' + this.cat.trialDays + ' jours (moyen de paiement demandé, signatures électroniques non incluses pendant l’essai)' })]) : null,
      el('p', { class: 'muted', text: 'Montant définitif calculé par notre serveur et affiché sur la page de paiement sécurisée. Packs de signatures disponibles ensuite depuis votre espace.' }),
    ]));
  };

  Widget.prototype.renderSignup = function () {
    var self = this, cat = this.cat;
    var plan = this.plan(this.state.plan || 'free');
    var status = el('div', { role: 'status', 'aria-live': 'polite' });
    var planLine = el('p', { class: 'full muted' }, [
      'Offre choisie : ', el('strong', { text: plan.name + (plan.code !== 'free' ? (this.state.interval === 'year' ? ' (annuel)' : ' (mensuel)') : '') }),
      plan.code !== 'free' ? ' — votre espace est créé en Free, puis vous finalisez le paiement sécurisé après confirmation de votre email.' : ' — gratuit, sans carte et sans limite de durée.',
    ]);
    var field = function (label, name, type, attrs) {
      return el('label', attrs && attrs.full ? { class: 'full' } : null, [label, el('input', Object.assign({ name: name, type: type, required: !(attrs && attrs.optional), autocomplete: attrs && attrs.ac }, attrs && attrs.input || {}))]);
    };
    var form = el('form', { id: 'tms-signup', novalidate: true }, [
      planLine,
      field('Nom et prénom', 'fullName', 'text', { ac: 'name', input: { minlength: '2', maxlength: '120' } }),
      field('Email professionnel', 'email', 'email', { ac: 'email' }),
      field('Organisme de formation', 'legalName', 'text', { ac: 'organization', input: { minlength: '2', maxlength: '200' } }),
      field('SIRET (facultatif)', 'siret', 'text', { optional: true, input: { inputmode: 'numeric', pattern: '\\d{14}', maxlength: '14' } }),
      field('Mot de passe (10 caractères min.)', 'password', 'password', { full: true, ac: 'new-password', input: { minlength: '10' } }),
      el('div', { class: 'hp', 'aria-hidden': 'true' }, [el('label', null, ['Site web', el('input', { name: 'website', type: 'text', tabindex: '-1', autocomplete: 'off' })])]),
      this.renderAddons(),
      el('label', { class: 'check full' }, [el('input', { type: 'checkbox', name: 'acceptTerms', required: true }), el('span', null, [
        'J’accepte les ', el('a', { href: cat.legal.terms, target: '_blank', rel: 'noopener', text: 'CGV' }), ', la ',
        el('a', { href: cat.legal.privacy, target: '_blank', rel: 'noopener', text: 'politique de confidentialité' }), ' et l’',
        el('a', { href: cat.legal.dpa, target: '_blank', rel: 'noopener', text: 'accord de sous-traitance' }), '.',
      ])]),
      el('div', { class: 'full' }, [el('button', { type: 'submit', class: 'btn', style: 'width:100%', text: plan.code === 'free' ? 'Créer mon espace gratuit' : 'Créer mon espace et continuer' })]),
      el('div', { class: 'full' }, [status]),
      el('p', { class: 'full foot' }, ['Déjà client ? ', el('a', { href: cat.appUrl + '/login', text: 'Se connecter' })]),
    ]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = form.elements;
      status.textContent = ''; status.className = '';
      var errors = [];
      if (!f.fullName.value.trim() || f.fullName.value.trim().length < 2) errors.push('Indiquez votre nom.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value)) errors.push('Email invalide.');
      if (f.legalName.value.trim().length < 2) errors.push('Indiquez le nom de votre organisme.');
      if (f.siret.value && !/^\d{14}$/.test(f.siret.value.replace(/\s/g, ''))) errors.push('Le SIRET comporte 14 chiffres.');
      if (f.password.value.length < 10) errors.push('Mot de passe : 10 caractères minimum.');
      if (!f.acceptTerms.checked) errors.push('Acceptez les conditions pour continuer.');
      if (errors.length) { status.className = 'msg err'; status.textContent = errors.join(' '); return; }
      var btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      var addons = Object.keys(self.state.addons).map(function (k) { return { code: k, quantity: self.state.addons[k] }; });
      var body = {
        fullName: f.fullName.value.trim(), email: f.email.value.trim(), password: f.password.value,
        organization: { legalName: f.legalName.value.trim(), siret: f.siret.value.replace(/\s/g, '') || undefined },
        acceptTerms: true, plan: plan.code, interval: self.state.interval, addons: plan.code === 'free' ? [] : addons,
        trial: plan.code !== 'free' && self.state.trial, website: f.website.value,
        source: (self.host.getAttribute('data-source') || 'website-embed').slice(0, 60),
      };
      fetch(self.api + '/api/v1/public/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit' })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.body && res.body.message || 'Inscription impossible.');
          form.reset();
          status.className = 'msg ok';
          status.textContent = res.body.message + ' Un email de confirmation vient d’être envoyé à ' + body.email + '.';
          self.emit('tms:signup', { plan: plan.code, interval: self.state.interval, addons: addons.map(function (a) { return a.code; }) });
        })
        .catch(function (err) { status.className = 'msg err'; status.textContent = err.message; })
        .then(function () { btn.disabled = false; });
    });
    return el('section', { 'aria-labelledby': 'tms-signup-title' }, [el('h2', { id: 'tms-signup-title', text: 'Créer votre espace' }), form]);
  };

  function boot() {
    var nodes = document.querySelectorAll('[data-tms-widget]:not([data-tms-ready])');
    for (var i = 0; i < nodes.length; i++) { nodes[i].setAttribute('data-tms-ready', ''); new Widget(nodes[i]); }
  }
  window.TmsEmbed = { boot: boot };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
