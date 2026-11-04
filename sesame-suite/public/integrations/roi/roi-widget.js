(function (root) {
  'use strict';

  const VERSION = '1.0.0';
  // 04/11/2026 — "désactiver une option ne change pas le résultat" :
  // roi-widget.js est chargé via un simple <script src>, sans paramètre de
  // version, et roi-engine.js est ensuite injecté dynamiquement à un
  // chemin fixe — les deux restent tels quels en cache navigateur d'une
  // visite à l'autre tant que l'URL ne change pas. Un ASSET_VERSION bumpé
  // à chaque modification de l'un des deux fichiers force un rechargement
  // réel au lieu de servir une copie en cache obsolète.
  const ASSET_VERSION = '3';
  const scriptUrl = document.currentScript && document.currentScript.src
    ? document.currentScript.src
    : 'https://sesame-technology.fr/integrations/roi/roi-widget.js';
  const engineUrl = new URL('../../roi-engine.js', scriptUrl).href + '?v=' + ASSET_VERSION;
  let enginePromise;

  function ensureEngine() {
    if (root.SesameROI && typeof root.SesameROI.calculate === 'function') return Promise.resolve(root.SesameROI);
    if (enginePromise) return enginePromise;
    enginePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = engineUrl;
      script.async = true;
      script.onload = () => root.SesameROI ? resolve(root.SesameROI) : reject(new Error('SesameROI indisponible.'));
      script.onerror = () => reject(new Error('Chargement roi-engine.js impossible.'));
      document.head.appendChild(script);
    });
    return enginePromise;
  }

  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const boolean = (value, fallback) => value == null ? fallback : !['false', '0', 'no'].includes(String(value).toLowerCase());
  const format = (value, digits = 0) => new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(Number(value) || 0);

  // Pictogrammes "équivalent temps plein" (04/11/2026) — un bonhomme plein
  // par unité entière, un bonhomme partiellement rempli (clip-path CSS)
  // pour la fraction. Plafonné à 6 silhouettes pleines pour rester lisible
  // sur des ETP élevés (parc important) — pas de case "+N" au-delà, 6
  // pleines suffisent à transmettre "beaucoup" sans encombrer la carte.
  function fteIconsHtml(value) {
    const v = Math.max(0, Number(value) || 0);
    const floor = Math.min(6, Math.floor(v));
    const frac = Math.floor(v) < 6 ? v - Math.floor(v) : 0;
    let html = '';
    for (let i = 0; i < floor; i++) html += '<svg class="fte-ic" viewBox="0 0 24 32"><use href="#fte-person" fill="var(--sesame-roi-primary)"/></svg>';
    if (frac > 0.02) {
      const pct = Math.round(frac * 100);
      html += `<span class="fte-partial" style="--frac:${pct}%"><svg viewBox="0 0 24 32"><use href="#fte-person" fill="var(--sesame-roi-border)"/></svg><svg viewBox="0 0 24 32" class="fte-fill"><use href="#fte-person" fill="var(--sesame-roi-primary)"/></svg></span>`;
    } else if (!floor) {
      html = '<svg class="fte-ic" viewBox="0 0 24 32"><use href="#fte-person" fill="var(--sesame-roi-border)"/></svg>';
    }
    return html;
  }

  const styles = `
    :host {
      --sesame-roi-primary: #a40b3d;
      --sesame-roi-primary-contrast: #ffffff;
      --sesame-roi-accent: #1a6b47;
      --sesame-roi-background: #f7f8fa;
      --sesame-roi-surface: #ffffff;
      --sesame-roi-text: #17202b;
      --sesame-roi-muted: #647080;
      --sesame-roi-border: #dce1e7;
      --sesame-roi-radius: 20px;
      --sesame-roi-font: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: block;
      color: var(--sesame-roi-text);
      font-family: var(--sesame-roi-font);
    }
    * { box-sizing: border-box; }
    .shell { padding: clamp(14px, 2.5vw, 24px); border: 1px solid var(--sesame-roi-border); border-radius: var(--sesame-roi-radius); background: var(--sesame-roi-background); }
    .heading { margin-bottom: 14px; }
    .eyebrow { margin: 0 0 4px; color: var(--sesame-roi-primary); font-size: 11px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
    h2 { margin: 0; font-size: clamp(19px, 3.5vw, 26px); line-height: 1.1; }
    .intro { max-width: 760px; margin: 6px 0 0; color: var(--sesame-roi-muted); line-height: 1.4; font-size: 12.5px; }
    /* 03/11/2026 — "toujours pas terrible" : les paliers @container/@media
       précédents se cassaient parce que .hero/.details sont imbriqués DANS
       .workspace, qui se réduit lui-même déjà en 1 colonne ; un seuil basé
       sur la largeur du widget ENTIER ne correspond plus à la largeur
       réelle, plus étroite, dont .hero/.details disposent une fois dans
       cette colonne. repeat(auto-fit, minmax(...)) s'adapte à la largeur
       réellement reçue par CHAQUE grille, sans seuil à deviner ni ordre
       d'imbrication à suivre — standard et robuste quel que soit le
       conteneur (fenêtre large, colonne étroite, mobile...).  */
    /* 04/11/2026 — "la présentation a des problèmes" : la barre d'options
       vivait DANS .panel, qui ne reçoit que la moitié de la largeur du
       widget (repartie 50/50 avec .results) — 4 pastilles + le champ de
       taux d'occupation n'y tiennent pas, d'où une troncature moche
       (pastille coupée en plein mot) malgré le défilement horizontal.
       Le fieldset sort donc de .panel pour occuper toute la largeur du
       widget (pleine largeur du <form>), seul le reste (champ nombre
       d'accès + résultats) garde la répartition 2 colonnes. */
    .workspace { display: block; min-width: 0; }
    form { min-width: 0; }
    .panel { padding: 14px; border: 1px solid var(--sesame-roi-border); border-radius: calc(var(--sesame-roi-radius) - 4px); background: var(--sesame-roi-surface); }
    .form-body { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-top: 14px; }
    /* nowrap + overflow-x:auto reste le filet de sécurité en mobile très
       étroit (cf. "pas deux lignes en responsive") — mais pleine largeur,
       la rangée tient désormais sur une ligne sans défiler dès le format
       bureau. min-width:0 explicite car <fieldset> a par défaut
       min-inline-size:min-content dans la feuille de style navigateur —
       sans ce reset, un contenu flex nowrap trop large fait exploser la
       largeur du fieldset (et donc de toute la page) au lieu de défiler
       dans sa propre boîte (04/11/2026, régression repérée en testant à
       400px de large). */
    fieldset { display: flex; flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; gap: 6px; margin: 0; padding: 2px 2px 6px; border: 0; min-width: 0; scrollbar-width: thin; }
    legend { width: 100%; margin-bottom: 6px; color: var(--sesame-roi-muted); font-size: 11px; font-weight: 900; letter-spacing: .05em; text-transform: uppercase; }
    .choice { display: flex; align-items: center; gap: 6px; padding: 7px 11px; border: 1px solid var(--sesame-roi-border); border-radius: 999px; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
    .choice:has(input:checked) { border-color: var(--sesame-roi-accent); background: color-mix(in srgb, var(--sesame-roi-accent) 9%, var(--sesame-roi-surface)); }
    .choice b { font-size: 12px; font-weight: 700; }
    input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--sesame-roi-accent); flex-shrink: 0; }
    .choice-field { display: flex; align-items: center; gap: 6px; padding: 6px 11px; border: 1px dashed var(--sesame-roi-border); border-radius: 999px; font-size: 12px; font-weight: 700; color: var(--sesame-roi-muted); white-space: nowrap; flex-shrink: 0; }
    .choice-field input { width: 40px; padding: 4px 5px; border: 1px solid var(--sesame-roi-border); border-radius: 6px; background: var(--sesame-roi-surface); color: var(--sesame-roi-text); font: inherit; text-align: center; }
    .help, .assumptions { color: var(--sesame-roi-muted); }
    .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 12px; align-items: end; }
    .field { display: grid; gap: 5px; font-size: 12.5px; font-weight: 800; }
    .help { grid-column: 1 / -1; }
    input[type="number"] { width: 100%; padding: 10px; border: 1px solid var(--sesame-roi-border); border-radius: 9px; background: var(--sesame-roi-surface); color: var(--sesame-roi-text); font: inherit; }
    input[readonly] { background: var(--sesame-roi-background); color: var(--sesame-roi-muted); cursor: not-allowed; }
    .help { margin: 0; font-size: 11px; line-height: 1.4; }
    .results { display: grid; gap: 10px; }
    .hero { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
    .metric { min-width: 0; padding: 10px; border: 1px solid var(--sesame-roi-border); border-radius: 12px; background: var(--sesame-roi-surface); }
    .metric small { font-size: 11px; color: var(--sesame-roi-muted); font-weight: 800; }
    .metric strong { display: block; margin-top: 3px; color: var(--sesame-roi-primary); font-size: clamp(17px, 4vw, 26px); line-height: 1; }
    .metric span { font-size: 11px; color: var(--sesame-roi-muted); }
    .fte-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
    .fte-icons { display: flex; gap: 2px; flex-shrink: 0; }
    .fte-ic { width: 15px; height: 20px; display: block; }
    .fte-partial { position: relative; width: 15px; height: 20px; display: inline-block; }
    .fte-partial svg { position: absolute; inset: 0; width: 15px; height: 20px; }
    .fte-partial .fte-fill { clip-path: inset(0 calc(100% - var(--frac)) 0 0); }
    .metric-fte strong { margin-top: 0; }
    .details { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
    .detail { display: flex; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: 10px; background: color-mix(in srgb, var(--sesame-roi-accent) 7%, var(--sesame-roi-surface)); font-size: 12.5px; }
    .detail b { color: var(--sesame-roi-accent); }
    .assumptions { margin: 0; padding: 10px 12px; border-left: 3px solid var(--sesame-roi-primary); border-radius: 8px; background: var(--sesame-roi-surface); font-size: 11.5px; line-height: 1.45; }
    .empty { padding: 20px; text-align: center; color: var(--sesame-roi-muted); }
    .error { padding: 16px; border: 1px solid #b42318; border-radius: 12px; color: #b42318; background: #fff4f2; }
    [hidden] { display: none !important; }
  `;

  class SesameRoiCalculator extends HTMLElement {
    static get observedAttributes() {
      return ['access-count', 'access-occupancy', 'include-access', 'include-eco', 'eco-room-count'];
    }

    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._config = null;
      this._ready = false;
    }

    connectedCallback() {
      this.mount();
    }

    attributeChangedCallback() {
      if (this._ready) this.applyInitialValues();
    }

    set config(value) {
      this._config = value && typeof value === 'object' ? value : null;
      if (this._ready) this.applyInitialValues();
    }

    get config() {
      return this._config || {};
    }

    async mount() {
      this.shadowRoot.innerHTML = `<style>${styles}</style><div class="shell"><p class="help">Chargement du calculateur…</p></div>`;
      try {
        this.engine = await ensureEngine();
        this.render();
        this._ready = true;
        this.applyInitialValues();
      } catch (error) {
        this.shadowRoot.innerHTML = `<style>${styles}</style><div class="error">${error.message}</div>`;
      }
    }

    render() {
      this.shadowRoot.innerHTML = `
        <style>${styles}</style>
        <section class="shell">
          <svg width="0" height="0" style="position:absolute" aria-hidden="true">
            <symbol id="fte-person" viewBox="0 0 24 32">
              <circle cx="12" cy="7" r="6"/>
              <path d="M2 30 C2 19 6 15 12 15 C18 15 22 19 22 30 Z"/>
            </symbol>
          </svg>
          <header class="heading">
            <p class="eyebrow">Simulation indicative</p>
            <h2>Calculateur ROI Sesame</h2>
          </header>
          <div class="workspace">
            <form novalidate>
              <fieldset>
                <legend>Options incluses</legend>
                <label class="choice" title="Arrivée digitale, ménage et serviettes"><input name="includeEco" type="checkbox"><b>Check-in Éco Responsable</b></label>
                <label class="choice" title="6 min/séjour accepté"><input name="identity" type="checkbox"><b>Contrôle d’identité</b></label>
                <label class="choice" title="4 min/séjour accepté"><input name="tax" type="checkbox"><b>Taxe de séjour</b></label>
                <label class="choice" title="33 min/séjour accepté + impact environnemental"><input name="cleaning" type="checkbox"><b>Ménage</b></label>
                <label class="choice-field" title="Contrôle d’accès toujours inclus — cœur du produit">Occupation accès<input name="accessOccupancyPercent" type="number" min="0" max="100" step="1">%</label>
              </fieldset>
              <div class="form-body">
                <div class="panel">
                  <div class="fields">
                    <label class="field">Nombre d’accès / chambres<input name="roomCount" type="number" readonly aria-readonly="true"></label>
                    <input type="hidden" name="accessCount"><input type="hidden" name="ecoRoomCount">
                    <p class="help">Contrôle d’accès toujours inclus. Hypothèses : 2 utilisations/jour, 5 min gagnées (accès) · 80 % d’occupation, 25 % d’acceptation, séjour moyen 3 nuits (éco).</p>
                  </div>
                </div>
                <section class="results" aria-live="polite">
                  <div class="hero">
                    <div class="metric"><small>Temps gagné</small><strong data-output="annualHours">0</strong><span>h/an</span></div>
                    <div class="metric"><small>Jours-homme</small><strong data-output="staffDays">0</strong><span>jours/an</span></div>
                    <div class="metric metric-fte"><small>Équivalent temps plein</small><div class="fte-row"><div class="fte-icons" data-fte-icons aria-hidden="true"></div><div><strong data-output="fte">0,00</strong><span>ETP</span></div></div></div>
                  </div>
                  <div class="details">
                    <div class="detail"><span>Opérations</span><b data-output="annualOperations">0</b></div>
                    <div class="detail"><span>Temps mensuel</span><b><span data-output="monthlyHours">0</span> h/mois</b></div>
                    <div class="detail"><span>Temps accès</span><b><span data-output="automationAnnualHours">0</span> h/an</b></div>
                    <div class="detail"><span>Temps Éco</span><b><span data-output="ecoAnnualHours">0</span> h/an</b></div>
                    <div class="detail"><span>Eau économisée</span><b data-output="waterSavedLiters">—</b></div>
                    <div class="detail"><span>CO₂e évité</span><b data-output="co2SavedKg">—</b></div>
                  </div>
                  <p class="assumptions" data-note></p>
                  <p class="empty" data-empty hidden>Sélectionnez au moins une gamme.</p>
                </section>
              </div>
            </form>
          </div>
        </section>`;
      this.form = this.shadowRoot.querySelector('form');
      this.form.addEventListener('input', () => this.calculate());
      this.form.addEventListener('change', () => this.calculate());
    }

    applyInitialValues() {
      if (!this.form) return;
      const config = this.config;
      const value = (name, attribute, fallback) => config[name] ?? this.getAttribute(attribute) ?? fallback;
      this.form.elements.includeEco.checked = boolean(value('includeEco', 'include-eco', false), false);
      // Un seul champ affiché (non modifiable) pour le nombre d’accès/chambres
      // — demande client 03/11/2026, il apparaissait deux fois (accessCount
      // ET ecoRoomCount, mêmes champs numériques séparés). Les deux entrées
      // cachées restent alimentées avec la même valeur pour le moteur de
      // calcul, qui continue d’attendre ces deux noms distincts.
      const room = number(value('accessCount', 'access-count', value('ecoRoomCount', 'eco-room-count', 50)), 50);
      this.form.elements.roomCount.value = room;
      this.form.elements.accessCount.value = room;
      this.form.elements.ecoRoomCount.value = room;
      this.form.elements.accessOccupancyPercent.value = number(value('accessOccupancyPercent', 'access-occupancy', 70), 70);
      const options = config.ecoOptions || {};
      this.form.elements.identity.checked = boolean(options.identity, true);
      this.form.elements.tax.checked = boolean(options.tax, true);
      this.form.elements.cleaning.checked = boolean(options.cleaning, true);
      this.calculate();
    }

    getInputs() {
      const fields = this.form.elements;
      return {
        accessCount: number(fields.accessCount.value, 50),
        accessOccupancyPercent: number(fields.accessOccupancyPercent.value, 70),
        usesPerDay: 2,
        minutesPerUse: 5,
        // Contrôle d'accès retiré des options cochables (04/11/2026,
        // demande client) — toujours inclus, cœur du produit, plus la peine
        // de le proposer en bascule. "Boutique" retirée aussi (pas offerte).
        includeAccess: true,
        includeEco: fields.includeEco.checked,
        ecoRoomCount: number(fields.ecoRoomCount.value, 50),
        ecoOptions: {
          identity: fields.identity.checked,
          tax: fields.tax.checked,
          cleaning: fields.cleaning.checked
        }
      };
    }

    calculate() {
      if (!this.engine || !this.form) return null;
      const inputs = this.getInputs();
      const result = this.engine.calculate(inputs);
      this.result = result;
      const output = (name, value) => { this.shadowRoot.querySelector(`[data-output="${name}"]`).textContent = value; };
      output('annualHours', format(result.annualHours));
      output('staffDays', format(result.staffDays));
      output('fte', format(result.fte, 2));
      const fteHolder = this.shadowRoot.querySelector('[data-fte-icons]');
      if (fteHolder) fteHolder.innerHTML = fteIconsHtml(result.fte);
      output('annualOperations', format(result.annualOperations));
      output('automationAnnualHours', format(result.automationAnnualHours));
      output('ecoAnnualHours', format(result.ecoAnnualHours));
      output('monthlyHours', format(result.monthlyHours));
      output('waterSavedLiters', inputs.includeEco && inputs.ecoOptions.cleaning ? `${format(result.waterSavedLiters)} L/an` : '—');
      output('co2SavedKg', inputs.includeEco && inputs.ecoOptions.cleaning ? `${format(result.co2SavedKg, 1)} kg/an` : '—');
      const selected = [inputs.includeAccess ? 'contrôles d’accès' : '', inputs.includeEco ? 'Check-in Éco Responsable' : ''].filter(Boolean).join(' + ');
      const options = Object.entries(inputs.ecoOptions).filter(([, enabled]) => enabled).map(([key]) => ({ identity:'identité', tax:'taxe', shop:'boutique', cleaning:'ménage' }[key])).join(', ') || 'aucune';
      this.shadowRoot.querySelector('[data-note]').textContent = selected
        ? `Base : ${selected}. Accès : ${result.accessCount} points à ${result.accessOccupancyPercent} %, 2 utilisations/jour, 5 min gagnées. Éco : ${result.ecoRoomCount} chambres, 80 % d’occupation, 25 % d’acceptation, séjour moyen 3 nuits, options ${options}. Estimation indicative.`
        : 'Sélectionnez au moins une gamme.';
      this.shadowRoot.querySelector('[data-empty]').hidden = Boolean(selected);
      this.dispatchEvent(new CustomEvent('sesame-roi-change', {
        bubbles: true,
        composed: true,
        detail: { version: VERSION, inputs, result }
      }));
      return result;
    }

    toJSON() {
      return { version: VERSION, inputs: this.getInputs(), result: this.result || this.calculate() };
    }
  }

  if (!customElements.get('sesame-roi-calculator')) customElements.define('sesame-roi-calculator', SesameRoiCalculator);
  root.SesameROIIntegration = { version: VERSION, element: 'sesame-roi-calculator', engineUrl, ensureEngine };
})(window);
