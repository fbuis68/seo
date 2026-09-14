/**
 * Widget d'ouverture de ticket support, embarquable sur n'importe quel site
 * externe (site vitrine, prod client…) via une seule balise <script> —
 * aucune dépendance, DOM isolé en Shadow DOM pour ne jamais entrer en
 * conflit avec le CSS de la page hôte (et inversement). Utilise le même
 * endpoint public que public/support.html (POST /wa/ticket/create) :
 * chaque soumission crée un vrai ticket dans le CRM Sesame (/crm, panneau
 * Tickets).
 *
 * Utilisation minimale :
 *   <script src="https://<domaine-sesame-suite>/ticketWidget.js" async></script>
 *
 * Options (attributs data-* sur la balise <script>, tous facultatifs) :
 *   data-api-base   URL de base de l'API si différente de l'origine du
 *                   script (par défaut : déduite de son propre src).
 *   data-label      Texte du bouton flottant (défaut "Support").
 *   data-title      Titre du panneau (défaut "Besoin d'aide ?").
 *   data-color      Couleur d'accent, ex "#8a2b2b" (défaut ci-dessous).
 *   data-position   "bottom-right" (défaut) ou "bottom-left".
 *   data-subject    Pré-remplit le champ Sujet (utile sur une page dédiée,
 *                   ex. data-subject="Question facturation").
 */
(function () {
  var scriptEl = document.currentScript;
  if (!scriptEl) return; // chargé d'une façon qui empêche de retrouver ses propres attributs (rare) — abandon silencieux plutôt qu'une erreur visible sur le site hôte.

  var cfg = {
    apiBase: (scriptEl.getAttribute("data-api-base") || new URL(scriptEl.src, location.href).origin).replace(/\/$/, ""),
    label: scriptEl.getAttribute("data-label") || "Support",
    title: scriptEl.getAttribute("data-title") || "Besoin d'aide ?",
    color: scriptEl.getAttribute("data-color") || "#8a2b2b",
    position: scriptEl.getAttribute("data-position") === "bottom-left" ? "left" : "right",
    subject: scriptEl.getAttribute("data-subject") || "",
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function filesToDataUrls(fileList, cb) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) {
      cb([]);
      return;
    }
    var done = 0;
    var out = new Array(files.length);
    files.forEach(function (f, i) {
      var r = new FileReader();
      r.onload = function (e) {
        out[i] = e.target.result;
        done++;
        if (done === files.length) cb(out);
      };
      r.readAsDataURL(f);
    });
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " o";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " Ko";
    return (bytes / (1024 * 1024)).toFixed(1) + " Mo";
  }

  var MAX_FILES = 5;

  var ICON_CHAT =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  var ICON_CLOSE =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var ICON_CHECK =
    '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#1a6b47" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
  var ICON_UPLOAD =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
  var ICON_PAPERCLIP =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05 12.25 20.24a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.67 3.67 0 0 1 5.19 5.19l-9.2 9.19a1.83 1.83 0 0 1-2.59-2.59l8.49-8.48"/></svg>';
  var ICON_X_SMALL =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  var host = document.createElement("div");
  host.id = "sesame-ticket-widget";
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });

  var side = cfg.position === "left" ? "left" : "right";
  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}" +
    ".stw-bubble{position:fixed;bottom:20px;" +
    side +
    ":20px;z-index:2147483000;display:flex;align-items:center;gap:8px;background:" +
    cfg.color +
    ";color:#fff;border:none;border-radius:999px;padding:13px 18px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.22);transition:transform .15s ease}" +
    ".stw-bubble:hover{transform:translateY(-2px)}" +
    ".stw-panel{position:fixed;bottom:88px;" +
    side +
    ":20px;z-index:2147483000;width:min(380px,calc(100vw - 32px));max-height:min(600px,calc(100vh - 120px));background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden}" +
    ".stw-panel.open{display:flex}" +
    ".stw-head{background:" +
    cfg.color +
    ";color:#fff;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}" +
    ".stw-head h2{margin:0;font-size:16px;font-weight:700}" +
    ".stw-head p{margin:2px 0 0;font-size:12px;opacity:.85}" +
    ".stw-x{background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:8px;padding:6px;cursor:pointer;display:flex;line-height:0}" +
    ".stw-x:hover{background:rgba(255,255,255,.28)}" +
    ".stw-body{padding:16px 18px;overflow-y:auto;flex:1}" +
    ".stw-fi{margin-bottom:12px}" +
    ".stw-fi label{display:block;font-size:12px;color:#666;margin-bottom:4px;font-weight:600}" +
    ".stw-fi input[type=text],.stw-fi input[type=email],.stw-fi textarea{width:100%;font-size:13px;padding:9px 11px;border:1px solid #ddd;border-radius:8px;font-family:inherit;color:#1a1a1a;background:#fff}" +
    ".stw-fi input:focus,.stw-fi textarea:focus{outline:2px solid " +
    cfg.color +
    "44;border-color:" +
    cfg.color +
    "}" +
    ".stw-fi textarea{resize:vertical;min-height:80px}" +
    ".stw-drop{border:1.5px dashed #d5d0c8;border-radius:10px;padding:16px 10px;text-align:center;cursor:pointer;color:#888;transition:border-color .15s ease,background .15s ease}" +
    ".stw-drop svg{display:block;margin:0 auto 6px}" +
    ".stw-drop span{display:block;font-size:12px;line-height:1.4}" +
    ".stw-drop small{display:block;font-size:11px;color:#aaa;margin-top:2px}" +
    ".stw-drop:hover,.stw-drop:focus-visible{border-color:" +
    cfg.color +
    ";outline:none}" +
    ".stw-drop.stw-over{border-color:" +
    cfg.color +
    ";background:" +
    cfg.color +
    "0d}" +
    ".stw-drop.stw-full{opacity:.5;cursor:not-allowed}" +
    ".stw-filelist{margin-top:8px;display:flex;flex-direction:column;gap:6px}" +
    ".stw-file{display:flex;align-items:center;gap:7px;background:#f7f6f3;border:1px solid #ece9e3;border-radius:8px;padding:6px 8px;font-size:12px;color:#444}" +
    ".stw-file svg:first-child{flex-shrink:0;color:" +
    cfg.color +
    "}" +
    ".stw-file-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".stw-file-size{color:#aaa;flex-shrink:0}" +
    ".stw-file-rm{background:none;border:none;color:#999;cursor:pointer;display:flex;padding:2px;flex-shrink:0;border-radius:4px}" +
    ".stw-file-rm:hover{color:#b3261e;background:#b3261e14}" +
    ".stw-file-hint{font-size:11px;color:#aaa;margin-top:4px;display:none}" +
    ".stw-file-hint.stw-show{display:block}" +
    ".stw-fi input[type=file]{width:100%;font-size:12px}" +
    ".stw-err{color:#b3261e;font-size:12px;margin-top:2px;display:none}" +
    ".stw-submit{width:100%;background:" +
    cfg.color +
    ";color:#fff;border:none;border-radius:9px;padding:11px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}" +
    ".stw-submit:disabled{opacity:.5;cursor:not-allowed}" +
    ".stw-ok{text-align:center;padding:20px 6px}" +
    ".stw-ok p{font-size:13px;color:#555;margin:8px 0}" +
    ".stw-link{display:block;margin-top:14px;background:" +
    cfg.color +
    "14;color:" +
    cfg.color +
    ";border-radius:9px;padding:10px;font-size:13px;font-weight:600;text-decoration:none}" +
    ".stw-again{margin-top:14px;background:none;border:1px solid #ddd;border-radius:9px;padding:9px 14px;font-size:13px;cursor:pointer;color:#555;font-family:inherit}" +
    "@media(max-width:480px){.stw-panel{" +
    side +
    ":16px;bottom:84px;width:calc(100vw - 32px)}}" +
    "</style>" +
    '<button class="stw-bubble" type="button" aria-haspopup="dialog" aria-expanded="false">' +
    ICON_CHAT +
    (cfg.label ? "<span>" + esc(cfg.label) + "</span>" : "") +
    "</button>" +
    '<div class="stw-panel" role="dialog" aria-modal="false" aria-label="' +
    esc(cfg.title) +
    '"></div>';

  var bubbleEl = root.querySelector(".stw-bubble");
  var panelEl = root.querySelector(".stw-panel");
  var isOpen = false;
  var selectedFiles = [];

  function dropzoneHtml() {
    return (
      '<div class="stw-fi"><label>Pièces jointes (optionnel)</label>' +
      '<div class="stw-drop" data-drop tabindex="0" role="button" aria-label="Ajouter des fichiers">' +
      ICON_UPLOAD +
      "<span>Cliquez ou glissez-déposez des fichiers ici</span>" +
      "<small>" +
      MAX_FILES +
      " fichiers maximum</small>" +
      "</div>" +
      '<input type="file" data-f="files" accept="image/*,.pdf" multiple hidden>' +
      '<div class="stw-file-hint" data-file-hint></div>' +
      '<div class="stw-filelist" data-filelist></div>' +
      "</div>"
    );
  }

  function renderFileList() {
    var listEl = panelEl.querySelector("[data-filelist]");
    var dropEl = panelEl.querySelector("[data-drop]");
    if (!listEl || !dropEl) return;
    listEl.innerHTML = selectedFiles
      .map(function (f, i) {
        return (
          '<div class="stw-file">' +
          ICON_PAPERCLIP +
          '<span class="stw-file-name">' +
          esc(f.name) +
          "</span>" +
          '<span class="stw-file-size">' +
          formatFileSize(f.size) +
          "</span>" +
          '<button type="button" class="stw-file-rm" data-rm="' +
          i +
          '" aria-label="Retirer">' +
          ICON_X_SMALL +
          "</button>" +
          "</div>"
        );
      })
      .join("");
    dropEl.classList.toggle("stw-full", selectedFiles.length >= MAX_FILES);
    listEl.querySelectorAll("[data-rm]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectedFiles.splice(Number(btn.getAttribute("data-rm")), 1);
        renderFileList();
      });
    });
  }

  function addFiles(newFiles) {
    var hintEl = panelEl.querySelector("[data-file-hint]");
    var room = MAX_FILES - selectedFiles.length;
    var accepted = newFiles.slice(0, Math.max(room, 0));
    selectedFiles = selectedFiles.concat(accepted);
    if (hintEl) {
      if (newFiles.length > accepted.length) {
        hintEl.textContent = MAX_FILES + " fichiers maximum — les fichiers en trop n'ont pas été ajoutés.";
        hintEl.classList.add("stw-show");
      } else {
        hintEl.classList.remove("stw-show");
      }
    }
    renderFileList();
  }

  function wireDropzone() {
    var dropEl = panelEl.querySelector("[data-drop]");
    var inputEl = panelEl.querySelector('[data-f="files"]');
    if (!dropEl || !inputEl) return;
    dropEl.addEventListener("click", function () {
      if (selectedFiles.length < MAX_FILES) inputEl.click();
    });
    dropEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (selectedFiles.length < MAX_FILES) inputEl.click();
      }
    });
    inputEl.addEventListener("change", function () {
      addFiles(Array.prototype.slice.call(inputEl.files || []));
      inputEl.value = "";
    });
    dropEl.addEventListener("dragover", function (e) {
      e.preventDefault();
      dropEl.classList.add("stw-over");
    });
    dropEl.addEventListener("dragleave", function () {
      dropEl.classList.remove("stw-over");
    });
    dropEl.addEventListener("drop", function (e) {
      e.preventDefault();
      dropEl.classList.remove("stw-over");
      addFiles(Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []));
    });
  }

  function renderForm() {
    selectedFiles = [];
    panelEl.innerHTML =
      '<div class="stw-head"><div><h2>' +
      esc(cfg.title) +
      "</h2><p>Nous répondons par email dès que possible.</p></div>" +
      '<button class="stw-x" type="button" data-close aria-label="Fermer">' +
      ICON_CLOSE +
      "</button></div>" +
      '<div class="stw-body">' +
      '<div class="stw-fi"><label>Votre email</label><input type="email" data-f="email" placeholder="vous@exemple.com"></div>' +
      '<div class="stw-fi"><label>Votre nom (optionnel)</label><input type="text" data-f="name" placeholder="Prénom Nom"></div>' +
      '<div class="stw-fi"><label>Sujet</label><input type="text" data-f="subject" value="' +
      esc(cfg.subject) +
      '" placeholder="Résumez votre demande"></div>' +
      '<div class="stw-fi"><label>Message</label><textarea data-f="message" placeholder="Décrivez votre problème ou votre question…"></textarea></div>' +
      dropzoneHtml() +
      '<div class="stw-err" data-err></div>' +
      '<button class="stw-submit" type="button" data-submit>Envoyer</button>' +
      "</div>";
    wireCommon();
    wireDropzone();
    var submitBtn = panelEl.querySelector("[data-submit]");
    submitBtn.addEventListener("click", onSubmit);
    var emailEl = panelEl.querySelector('[data-f="email"]');
    if (emailEl) emailEl.focus();
  }

  function renderSuccess(publicToken, number) {
    var link = cfg.apiBase + "/support?token=" + encodeURIComponent(publicToken);
    panelEl.innerHTML =
      '<div class="stw-head"><div><h2>' +
      esc(cfg.title) +
      "</h2></div>" +
      '<button class="stw-x" type="button" data-close aria-label="Fermer">' +
      ICON_CLOSE +
      "</button></div>" +
      '<div class="stw-body"><div class="stw-ok">' +
      ICON_CHECK +
      "<p><strong>Ticket " +
      esc(number) +
      " envoyé avec succès</strong></p>" +
      "<p>Nous reviendrons vers vous par email dès que possible.</p>" +
      '<a class="stw-link" href="' +
      esc(link) +
      '" target="_blank" rel="noopener">Suivre mon ticket</a>' +
      '<button class="stw-again" type="button" data-again>Envoyer un autre message</button>' +
      "</div></div>";
    wireCommon();
    panelEl.querySelector("[data-again]").addEventListener("click", renderForm);
  }

  function wireCommon() {
    panelEl.querySelector("[data-close]").addEventListener("click", closePanel);
  }

  function onSubmit() {
    var errEl = panelEl.querySelector("[data-err]");
    errEl.style.display = "none";
    var email = panelEl.querySelector('[data-f="email"]').value.trim();
    var name = panelEl.querySelector('[data-f="name"]').value.trim();
    var subject = panelEl.querySelector('[data-f="subject"]').value.trim();
    var message = panelEl.querySelector('[data-f="message"]').value.trim();
    if (!email || email.indexOf("@") === -1) {
      errEl.textContent = "Adresse email valide requise.";
      errEl.style.display = "block";
      return;
    }
    if (!subject) {
      errEl.textContent = "Indiquez un sujet.";
      errEl.style.display = "block";
      return;
    }
    if (!message) {
      errEl.textContent = "Décrivez votre demande.";
      errEl.style.display = "block";
      return;
    }
    var btn = panelEl.querySelector("[data-submit]");
    btn.disabled = true;
    btn.textContent = "Envoi en cours…";
    filesToDataUrls(selectedFiles, function (attachments) {
      fetch(cfg.apiBase + "/wa/ticket/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, name: name, subject: subject, message: message, attachments: attachments }),
      })
        .then(function (r) {
          return r.json().then(function (data) {
            return { ok: r.ok, data: data };
          });
        })
        .then(function (res) {
          if (!res.ok) {
            errEl.textContent = res.data.error || "Erreur lors de l'ouverture du ticket.";
            errEl.style.display = "block";
            btn.disabled = false;
            btn.textContent = "Envoyer";
            return;
          }
          renderSuccess(res.data.publicToken, res.data.number);
        })
        .catch(function () {
          errEl.textContent = "Erreur de connexion au serveur, réessayez.";
          errEl.style.display = "block";
          btn.disabled = false;
          btn.textContent = "Envoyer";
        });
    });
  }

  function openPanel() {
    isOpen = true;
    panelEl.classList.add("open");
    bubbleEl.setAttribute("aria-expanded", "true");
    renderForm();
  }
  function closePanel() {
    isOpen = false;
    panelEl.classList.remove("open");
    bubbleEl.setAttribute("aria-expanded", "false");
  }

  bubbleEl.addEventListener("click", function () {
    if (isOpen) closePanel();
    else openPanel();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen) closePanel();
  });
})();
