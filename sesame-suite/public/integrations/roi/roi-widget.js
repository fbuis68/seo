(function (root) {
  'use strict';

  const VERSION = '1.0.0';
  const scriptUrl = document.currentScript && document.currentScript.src
    ? document.currentScript.src
    : 'https://sesame-technology.fr/integrations/roi/roi-widget.js';
  const engineUrl = new URL('../../roi-engine.js', scriptUrl).href;
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
      /* Repère pour "fait en sorte que le formulaire soit responsive"
         (03/11/2026) : le composant est intégré dans une colonne étroite
         (public/devis-signature.html, .wrap max-width 720px + .card padding
         24px, ~632px dispo) alors que le bloc Media original ci-dessous ne
         réagissait qu'à la largeur de LA FENÊTRE du navigateur, pas à
         l'espace réellement disponible — un écran de bureau large gardait
         donc la mise en page "3 colonnes" même écrasée dans un espace
         étroit (d'où le texte tassé/coupé constaté). container-type fait
         réagir les @container ci-dessous à la largeur RÉELLE du composant. */
      container-type: inline-size;
    }
    * { box-sizing: border-box; }
    .shell { padding: clamp(18px, 3cqi, 32px); border: 1px solid var(--sesame-roi-border); border-radius: var(--sesame-roi-radius); background: var(--sesame-roi-background); }
    .heading { margin-bottom: 22px; }
    .eyebrow { margin: 0 0 6px; color: var(--sesame-roi-primary); font-size: 12px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
    h2 { margin: 0; font-size: clamp(22px, 6cqi, 38px); line-height: 1.1; }
    .intro { max-width: 760px; margin: 10px 0 0; color: var(--sesame-roi-muted); line-height: 1.55; }
    .workspace { display: grid; grid-template-columns: minmax(250px, .72fr) minmax(0, 1.28fr); gap: 20px; }
    .panel { padding: 18px; border: 1px solid var(--sesame-roi-border); border-radius: calc(var(--sesame-roi-radius) - 4px); background: var(--sesame-roi-surface); }
    fieldset { display: grid; gap: 10px; margin: 0 0 18px; padding: 0; border: 0; }
    legend { margin-bottom: 10px; color: var(--sesame-roi-muted); font-size: 12px; font-weight: 900; letter-spacing: .05em; text-transform: uppercase; }
    .choice { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start; padding: 12px; border: 1px solid var(--sesame-roi-border); border-radius: 12px; cursor: pointer; }
    .choice:has(input:checked) { border-color: var(--sesame-roi-accent); background: color-mix(in srgb, var(--sesame-roi-accent) 9%, var(--sesame-roi-surface)); }
    input[type="checkbox"] { width: 19px; height: 19px; margin: 1px 0 0; accent-color: var(--sesame-roi-accent); }
    .choice span { display: grid; gap: 2px; }
    .choice small, .help, .assumptions { color: var(--sesame-roi-muted); }
    .fields { display: grid; gap: 12px; margin-top: 14px; }
    .field { display: grid; gap: 6px; font-size: 13px; font-weight: 800; }
    input[type="number"] { width: 100%; padding: 12px; border: 1px solid var(--sesame-roi-border); border-radius: 10px; background: var(--sesame-roi-surface); color: var(--sesame-roi-text); font: inherit; }
    .eco-options { display: grid; gap: 8px; margin-top: 12px; }
    .eco-options .choice { padding: 10px; }
    .results { display: grid; gap: 16px; }
    .hero { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .metric { min-width: 0; padding: 16px; border: 1px solid var(--sesame-roi-border); border-radius: 14px; background: var(--sesame-roi-surface); }
    .metric strong { display: block; margin-top: 5px; color: var(--sesame-roi-primary); font-size: clamp(20px, 7cqi, 36px); line-height: 1; }
    .metric small { color: var(--sesame-roi-muted); font-weight: 800; }
    .details { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .detail { display: flex; justify-content: space-between; gap: 12px; padding: 12px 14px; border-radius: 11px; background: color-mix(in srgb, var(--sesame-roi-accent) 7%, var(--sesame-roi-surface)); }
    .detail b { color: var(--sesame-roi-accent); }
    .assumptions { margin: 0; padding: 14px; border-left: 4px solid var(--sesame-roi-primary); border-radius: 8px; background: var(--sesame-roi-surface); font-size: 13px; line-height: 1.55; }
    .empty { padding: 28px; text-align: center; color: var(--sesame-roi-muted); }
    .error { padding: 16px; border: 1px solid #b42318; border-radius: 12px; color: #b42318; background: #fff4f2; }
    [hidden] { display: none !important; }
    /* @container (largeur réelle du composant) remplace l'ancien @media
       (largeur de la fenêtre) — seul moyen fiable de rester responsive une
       fois intégré dans une colonne étroite (cf. note sur :host ci-dessus).
       @media gardé juste après comme repli pour un navigateur trop ancien
       pour @container (dégradé silencieux, jamais pire que l'existant). */
    @container (max-width: 760px) {
      .workspace { grid-template-columns: 1fr; }
    }
    @container (max-width: 560px) {
      .hero, .details { grid-template-columns: 1fr; }
    }
    @container (min-width: 561px) and (max-width: 760px) {
      .hero { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 760px) {
      .workspace, .hero, .details { grid-template-columns: 1fr; }
    }
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
          <header class="heading">
            <p class="eyebrow">Simulation indicative</p>
            <h2>Calculateur ROI Sesame</h2>
            <p class="intro">Estime temps opérationnel, jours-homme, équivalent temps plein et impact environnemental selon périmètre choisi.</p>
          </header>
          <div class="workspace">
            <form class="panel" novalidate>
              <fieldset>
                <legend>Gammes incluses</legend>
                <label class="choice"><input name="includeAccess" type="checkbox"><span><b>Contrôles d’accès</b><small>Ouvertures et droits digitalisés</small></span></label>
                <label class="choice"><input name="includeEco" type="checkbox"><span><b>Check-in Éco Responsable</b><small>Arrivée digitale, ménage et serviettes</small></span></label>
              </fieldset>
              <div class="fields" data-access-fields>
                <label class="field">Nombre de points d’accès<input name="accessCount" type="number" min="0" max="5000" step="1"></label>
                <label class="field">Taux d’occupation accès (%)<input name="accessOccupancyPercent" type="number" min="0" max="100" step="1"></label>
                <p class="help">Hypothèse actuelle : 2 utilisations/jour, 5 minutes gagnées.</p>
              </div>
              <div class="fields" data-eco-fields>
                <label class="field">Nombre de chambres<input name="ecoRoomCount" type="number" min="0" max="5000" step="1"></label>
                <div class="eco-options">
                  <label class="choice"><input name="identity" type="checkbox"><span><b>Contrôle d’identité</b><small>6 min/séjour accepté</small></span></label>
                  <label class="choice"><input name="tax" type="checkbox"><span><b>Taxe de séjour</b><small>4 min/séjour accepté</small></span></label>
                  <label class="choice"><input name="shop" type="checkbox"><span><b>Boutique</b><small>4 min/séjour accepté</small></span></label>
                  <label class="choice"><input name="cleaning" type="checkbox"><span><b>Ménage</b><small>33 min/séjour accepté + impact environnemental</small></span></label>
                </div>
                <p class="help">Hypothèses actuelles : 80 % d’occupation, 25 % d’acceptation, séjour moyen 3 nuits.</p>
              </div>
            </form>
            <section class="results" aria-live="polite">
              <div class="hero">
                <div class="metric"><small>Temps gagné</small><strong data-output="annualHours">0</strong><span>h/an</span></div>
                <div class="metric"><small>Jours-homme</small><strong data-output="staffDays">0</strong><span>jours/an</span></div>
                <div class="metric"><small>Équivalent temps plein</small><strong data-output="fte">0,00</strong><span>ETP</span></div>
              </div>
              <div class="details">
                <div class="detail"><span>Opérations estimées</span><b data-output="annualOperations">0</b></div>
                <div class="detail"><span>Temps accès</span><b><span data-output="automationAnnualHours">0</span> h/an</b></div>
                <div class="detail"><span>Temps Éco</span><b><span data-output="ecoAnnualHours">0</span> h/an</b></div>
                <div class="detail"><span>Eau économisée</span><b data-output="waterSavedLiters">—</b></div>
                <div class="detail"><span>CO₂e évité</span><b data-output="co2SavedKg">—</b></div>
                <div class="detail"><span>Temps mensuel</span><b><span data-output="monthlyHours">0</span> h/mois</b></div>
              </div>
              <p class="assumptions" data-note></p>
              <p class="empty" data-empty hidden>Sélectionnez au moins une gamme.</p>
            </section>
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
      this.form.elements.includeAccess.checked = boolean(value('includeAccess', 'include-access', true), true);
      this.form.elements.includeEco.checked = boolean(value('includeEco', 'include-eco', false), false);
      this.form.elements.accessCount.value = number(value('accessCount', 'access-count', 50), 50);
      this.form.elements.accessOccupancyPercent.value = number(value('accessOccupancyPercent', 'access-occupancy', 70), 70);
      this.form.elements.ecoRoomCount.value = number(value('ecoRoomCount', 'eco-room-count', 50), 50);
      const options = config.ecoOptions || {};
      this.form.elements.identity.checked = boolean(options.identity, true);
      this.form.elements.tax.checked = boolean(options.tax, true);
      this.form.elements.shop.checked = boolean(options.shop, true);
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
        includeAccess: fields.includeAccess.checked,
        includeEco: fields.includeEco.checked,
        ecoRoomCount: number(fields.ecoRoomCount.value, 50),
        ecoOptions: {
          identity: fields.identity.checked,
          tax: fields.tax.checked,
          shop: fields.shop.checked,
          cleaning: fields.cleaning.checked
        }
      };
    }

    calculate() {
      if (!this.engine || !this.form) return null;
      const inputs = this.getInputs();
      const result = this.engine.calculate(inputs);
      this.result = result;
      this.shadowRoot.querySelector('[data-access-fields]').hidden = !inputs.includeAccess;
      this.shadowRoot.querySelector('[data-eco-fields]').hidden = !inputs.includeEco;
      const output = (name, value) => { this.shadowRoot.querySelector(`[data-output="${name}"]`).textContent = value; };
      output('annualHours', format(result.annualHours));
      output('staffDays', format(result.staffDays));
      output('fte', format(result.fte, 2));
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
