/**
 * Lanceur flottant du Copilote IA MCDF - version "une seule ligne a ajouter".
 *
 * Contrairement a launcher.html (qui demande de copier 3 blocs a des
 * endroits differents), ce fichier fait tout lui-meme : il injecte son
 * propre CSS et construit le bouton + le panneau au chargement de la
 * page. L'integration se resume a UNE seule ligne, a ajouter une seule
 * fois dans le gabarit commun de l'appli (juste avant </body>) :
 *
 *   <script src="/launcher-embed.js"></script>
 *
 * (Adapter le chemin "/launcher-embed.js" a l'endroit ou ce fichier est
 * reellement depose dans WebContent/.)
 *
 * Optionnel : definir window.MCDF_CURRENT_ENTITY_ID avant cette balise
 * <script> pour que le lien vers "Generation de rapports" s'ouvre sur la
 * bonne entite. Sans ca, le widget s'ouvre quand meme (juste sans filtre
 * d'entite).
 *
 * Verification que ce script s'est bien execute : dans la console du
 * navigateur, `document.getElementById('ia-launcher-btn')` doit renvoyer
 * l'element (pas null).
 */
(function () {
  if (document.getElementById('ia-launcher-btn')) return; // deja injecte, ne pas dupliquer

  const CSS = `
    #ia-launcher-btn {
      position: fixed; left: 22px; bottom: 22px; z-index: 2147483000;
      display: inline-flex; align-items: center; gap: 8px;
      background: #256abf; color: #ffffff;
      border: none; border-radius: 100px; padding: 13px 20px 13px 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px; font-weight: 600;
      box-shadow: 0 12px 32px rgba(11,11,11,0.18), 0 2px 8px rgba(11,11,11,0.10);
      cursor: pointer; transition: transform 0.15s ease;
    }
    #ia-launcher-btn:hover { transform: translateY(-2px); }
    #ia-launcher-btn svg { width: 20px; height: 20px; flex: none; }
    #ia-launcher-modal {
      position: fixed; inset: 0; z-index: 2147483001;
      display: none; align-items: flex-end; justify-content: flex-start;
      padding: 22px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    #ia-launcher-modal.open { display: flex; }
    #ia-launcher-backdrop { position: absolute; inset: 0; background: rgba(11,11,11,0.28); }
    #ia-launcher-panel {
      position: relative; width: 380px; max-width: calc(100vw - 44px);
      max-height: calc(100vh - 100px);
      background: #fcfcfb; border-radius: 16px; overflow: hidden;
      box-shadow: 0 12px 32px rgba(11,11,11,0.18), 0 2px 8px rgba(11,11,11,0.10);
      display: flex; flex-direction: column; color: #0b0b0b;
      transition: width 0.15s ease, max-height 0.15s ease;
    }
    #ia-launcher-panel.detail {
      width: min(1120px, calc(100vw - 44px));
      height: calc(100vh - 44px);
      max-height: calc(100vh - 44px);
    }
    .ia-l-header { background: #256abf; color: #ffffff; padding: 22px 22px 20px; flex: none; }
    .ia-l-header h2 {
      font-family: Charter, "Iowan Old Style", Georgia, serif; font-weight: 500;
      font-size: 20px; margin: 0 0 4px;
    }
    .ia-l-header p { margin: 0; font-size: 12.5px; opacity: 0.88; }
    .ia-l-back {
      display: none; position: absolute; top: 16px; left: 16px; width: 28px; height: 28px;
      border-radius: 50%; border: none; background: rgba(255,255,255,0.18);
      color: #ffffff; font-size: 17px; cursor: pointer; line-height: 1;
      align-items: center; justify-content: center;
    }
    .ia-l-back:hover { background: rgba(255,255,255,0.28); }
    #ia-launcher-panel.detail .ia-l-back { display: flex; }
    #ia-launcher-panel.detail .ia-l-header { padding-left: 54px; }
    .ia-l-close {
      position: absolute; top: 16px; right: 16px; width: 28px; height: 28px;
      border-radius: 50%; border: none; background: rgba(255,255,255,0.18);
      color: #ffffff; font-size: 15px; cursor: pointer; line-height: 1;
    }
    .ia-l-close:hover { background: rgba(255,255,255,0.28); }
    .ia-l-body { padding: 16px 18px 6px; overflow-y: auto; flex: 1; }
    #ia-launcher-panel.detail .ia-l-body { display: none; }
    .ia-l-detail { display: none; flex: 1; min-height: 0; }
    #ia-launcher-panel.detail .ia-l-detail { display: flex; }
    .ia-l-detail iframe { flex: 1; width: 100%; border: none; display: block; }
    .ia-l-ask {
      display: flex; align-items: center; gap: 8px; background: #f2f1ec;
      border: 1px solid rgba(11,11,11,0.10); border-radius: 10px;
      padding: 10px 12px; margin-bottom: 16px;
    }
    .ia-l-ask input {
      flex: 1; border: none; background: none; outline: none;
      font-size: 13.5px; color: #0b0b0b;
    }
    .ia-l-ask input::placeholder { color: #898781; }
    .ia-l-ask button {
      flex: none; border: none; background: #256abf; color: #ffffff;
      width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .ia-l-ask svg { width: 15px; height: 15px; }
    .ia-l-section-label {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
      color: #898781; font-weight: 600; margin: 0 0 10px;
    }
    .ia-l-cards { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
    .ia-l-card {
      display: flex; align-items: flex-start; gap: 12px; padding: 12px;
      border-radius: 10px; border: 1px solid rgba(11,11,11,0.10);
      text-decoration: none; color: inherit; cursor: pointer; background: #fcfcfb;
    }
    .ia-l-card:hover { background: #f2f1ec; border-color: rgba(11,11,11,0.16); }
    .ia-l-card[aria-disabled="true"] { cursor: default; opacity: 0.62; }
    .ia-l-icon {
      flex: none; width: 34px; height: 34px; border-radius: 9px;
      background: #dbe8f8; color: #256abf; display: flex;
      align-items: center; justify-content: center; font-size: 16px;
    }
    .ia-l-card-body { flex: 1; min-width: 0; }
    .ia-l-card-title {
      display: flex; align-items: center; gap: 8px; margin: 0 0 2px;
      font-weight: 600; font-size: 13.5px; color: #0b0b0b;
    }
    .ia-l-card-desc { margin: 0; font-size: 12px; color: #898781; line-height: 1.4; }
    .ia-l-badge {
      flex: none; font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.03em; padding: 2px 8px; border-radius: 100px;
    }
    .ia-l-badge.ready { background: #dbe8f8; color: #256abf; }
    .ia-l-badge.soon { background: #f5ecd6; color: #b8860b; }
    .ia-l-footer {
      padding: 12px 18px 16px; border-top: 1px solid rgba(11,11,11,0.10);
      font-size: 11px; color: #898781; display: flex; align-items: center; gap: 6px;
    }
    .ia-l-footer .dot { width: 5px; height: 5px; border-radius: 50%; background: #0ca30c; flex: none; }
  `;
  const styleEl = document.createElement('style');
  styleEl.id = 'ia-launcher-styles';
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  const btnHTML = `
    <button id="ia-launcher-btn" type="button" aria-haspopup="dialog">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0-6 6c0 2.2 1.2 4 2.5 5.3.4.4.5.7.5 1.2V17h6v-1.5c0-.5.1-.8.5-1.2C16.8 13 18 11.2 18 9a6 6 0 0 0-6-6Z"/><path d="M9 21h6"/><path d="M10 17v1"/><path d="M14 17v1"/></svg>
      Copilote IA
    </button>
    <div id="ia-launcher-modal" role="dialog" aria-label="Copilote IA MCDF" aria-modal="true">
      <div id="ia-launcher-backdrop"></div>
      <div id="ia-launcher-panel">
        <div class="ia-l-header">
          <button class="ia-l-back" type="button" aria-label="Retour aux modules">\u2039</button>
          <button class="ia-l-close" type="button" aria-label="Fermer">\u2715</button>
          <h2 id="ia-l-title">Copilote IA MCDF</h2>
          <p id="ia-l-subtitle">Posez une question ou choisissez un module ci-dessous.</p>
        </div>
        <div class="ia-l-body">
          <div class="ia-l-ask">
            <input type="text" placeholder="Ex. \u00AB quels devis relancer cette semaine ? \u00BB" id="ia-l-ask-input">
            <button type="button" id="ia-l-ask-btn" aria-label="Envoyer">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
            </button>
          </div>
          <p class="ia-l-section-label">Modules</p>
          <div class="ia-l-cards" id="ia-l-cards"></div>
        </div>
        <div class="ia-l-detail" id="ia-l-detail">
          <iframe id="ia-l-iframe" title="Module Copilote IA"></iframe>
        </div>
        <div class="ia-l-footer"><span class="dot"></span> Lecture seule \u2014 vos donn\u00E9es restent dans MCDF</div>
      </div>
    </div>
  `;
  const wrap = document.createElement('div');
  wrap.id = 'ia-launcher-root';
  wrap.innerHTML = btnHTML;
  document.body.appendChild(wrap);

  const ENTITY_ID = window.MCDF_CURRENT_ENTITY_ID || '';
  const qs = ENTITY_ID ? `?entityId=${encodeURIComponent(ENTITY_ID)}` : '';
  const MODULES = [
    { icon: '\u{1F4AC}', title: 'IA Conversationnelle', desc: 'Dialoguer en langage naturel pour interroger MCDF (v1, questions connues).', ready: true, href: `widget-conversationnel.html${qs}` },
    { icon: '\u2705', title: 'Assistant Qualiopi', desc: 'V\u00E9rifier les indicateurs et les preuves manquantes (v1, mode d\u00E9couverte).', ready: true, href: `widget-qualiopi.html${qs}` },
    { icon: '\u{1F4CA}', title: 'G\u00E9n\u00E9ration de rapports', desc: "Restitutions et KPI en direct (nouveaux clients, CA, devis...).", ready: true, href: `widget-ia.html${qs}` },
    { icon: '\u{1F4E4}', title: 'Envoi de documents', desc: "Envoyer un email \u00E0 des participants d'un dossier \u2014 d\u00E9clenche un vrai envoi.", ready: true, href: `widget-envoi.html${qs}` },
    { icon: '\u{1F50D}', title: 'Recherche intelligente', desc: "Chercher en langage naturel plut\u00F4t qu'avec des filtres.", ready: false, href: null },
  ];
  const panel = document.getElementById('ia-launcher-panel');
  const titleEl = document.getElementById('ia-l-title');
  const subtitleEl = document.getElementById('ia-l-subtitle');
  const iframe = document.getElementById('ia-l-iframe');
  const DEFAULT_TITLE = titleEl.textContent;
  const DEFAULT_SUBTITLE = subtitleEl.textContent;

  function openDetail(m) {
    iframe.src = m.href;
    titleEl.textContent = m.title;
    subtitleEl.textContent = m.desc;
    panel.classList.add('detail');
  }
  function closeDetail() {
    panel.classList.remove('detail');
    iframe.src = 'about:blank';
    titleEl.textContent = DEFAULT_TITLE;
    subtitleEl.textContent = DEFAULT_SUBTITLE;
  }

  const cardsWrap = document.getElementById('ia-l-cards');
  MODULES.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'ia-l-card';
    if (m.ready && m.href) {
      card.addEventListener('click', () => openDetail(m));
    } else {
      card.setAttribute('aria-disabled', 'true');
    }
    card.innerHTML = `
      <div class="ia-l-icon">${m.icon}</div>
      <div class="ia-l-card-body">
        <p class="ia-l-card-title">${m.title}</p>
        <p class="ia-l-card-desc">${m.desc}</p>
      </div>
      <span class="ia-l-badge ${m.ready ? 'ready' : 'soon'}">${m.ready ? 'Disponible' : 'Bient\u00F4t'}</span>
    `;
    cardsWrap.appendChild(card);
  });

  const btn = document.getElementById('ia-launcher-btn');
  const modal = document.getElementById('ia-launcher-modal');
  const backdrop = document.getElementById('ia-launcher-backdrop');
  const closeBtn = document.querySelector('.ia-l-close');
  const backBtn = document.querySelector('.ia-l-back');
  const askInput = document.getElementById('ia-l-ask-input');
  const askBtn = document.getElementById('ia-l-ask-btn');

  function openModal() { modal.classList.add('open'); askInput.focus(); }
  function closeModal() { modal.classList.remove('open'); closeDetail(); }
  btn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  backBtn.addEventListener('click', closeDetail);
  backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function handleAsk() {
    if (!askInput.value.trim()) return;
    askInput.placeholder = 'Bient\u00F4t disponible \u2014 essayez un module ci-dessous en attendant';
    askInput.value = '';
  }
  askBtn.addEventListener('click', handleAsk);
  askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAsk(); });
})();
