/**
 * Branchement conditionnel des questionnaires (22/10/2026) — logique
 * partagée entre public/questionnaire.html (révélation progressive des
 * questions au fil des réponses), et les constructeurs admin.html/crm.html
 * (éditeur de branches façon "Branche 1 / Sinon" + schéma en arbre en
 * lecture seule). Port JS volontaire du même algorithme que
 * src/lib/questionnaireBranching.ts (TS, utilisé côté serveur pour valider
 * les champs obligatoires sur le vrai chemin suivi) — pas de build step JS
 * partagé dans ce projet (fichiers statiques), les deux copies doivent
 * rester synchrones à la main si la logique change.
 */
(function(global){
'use strict';

var OPERATORS_BY_TYPE = {
  single: ['equals','not_equals'], select: ['equals','not_equals'],
  multi: ['includes','not_includes'],
  boolean: ['equals'], checkbox: ['equals'],
  number: ['equals','gt','lt','gte','lte'], rating: ['equals','gt','lt','gte','lte'],
  text: ['equals','contains'], shorttext: ['equals','contains'],
};
var OPERATOR_LABELS = {
  equals:'est égal à', not_equals:'est différent de', includes:'contient', not_includes:'ne contient pas',
  gt:'est supérieur à', lt:'est inférieur à', gte:'est supérieur ou égal à', lte:'est inférieur ou égal à',
  contains:'contient le texte',
};

function operatorsForType(type){ return OPERATORS_BY_TYPE[type] || []; }
function operatorLabel(op){ return OPERATOR_LABELS[op] || op; }

/** Branchement possible pour ce type de question ? (file = jamais, pas de valeur comparable simple). */
function canBranch(type){ return !!OPERATORS_BY_TYPE[type]; }

function extractComparable(type, value){
  if(!value) return undefined;
  switch(type){
    case 'single': case 'select': return value.choice;
    case 'multi': return value.choices;
    case 'boolean': return value.value;
    case 'checkbox': return value.checked;
    case 'text': case 'shorttext': return value.text;
    case 'number': return value.number;
    case 'rating': return value.rating;
    default: return undefined;
  }
}

function evalCondition(rule, question, answerValue){
  var actual = extractComparable(question.type, answerValue);
  if(actual === undefined) return false;
  switch(rule.operator){
    case 'equals': return actual === rule.value;
    case 'not_equals': return actual !== rule.value;
    case 'includes': return Array.isArray(actual) && actual.indexOf(rule.value) > -1;
    case 'not_includes': return Array.isArray(actual) && actual.indexOf(rule.value) === -1;
    case 'gt': return typeof actual === 'number' && actual > Number(rule.value);
    case 'lt': return typeof actual === 'number' && actual < Number(rule.value);
    case 'gte': return typeof actual === 'number' && actual >= Number(rule.value);
    case 'lte': return typeof actual === 'number' && actual <= Number(rule.value);
    case 'contains': return typeof actual === 'string' && actual.toLowerCase().indexOf(String(rule.value).toLowerCase()) > -1;
    default: return false;
  }
}

/** Libellé lisible d'une valeur de condition, pour l'affichage (pille façon
 * "EST ÉGAL À 2 jour") — résout la clé d'une option en son libellé. */
function valueLabel(question, value){
  if(question.type==='single' || question.type==='select' || question.type==='multi'){
    var opts = question.options || [];
    var o = opts.filter(function(x){return x.key===value;})[0];
    if(o) return o.label;
  }
  if(question.type==='boolean') return value===true?'Oui':value===false?'Non':'';
  return value==null?'':String(value);
}

/** Chemin réellement suivi compte tenu des réponses déjà données — même
 * algorithme que walkQuestionnairePath (TS). answersByQuestionId: objet
 * {questionId: valueObject}. */
function walkPath(questions, answersByQuestionId){
  var sorted = questions.slice().sort(function(a,b){return a.order-b.order;});
  var byId = {}; sorted.forEach(function(q){ byId[q.id]=q; });
  var path = []; var visited = {};
  var current = sorted[0];
  while(current && !visited[current.id]){
    visited[current.id] = true;
    path.push(current.id);
    var branching = current.branching;
    if(!branching){
      var idx = sorted.indexOf(current);
      current = sorted[idx+1];
      continue;
    }
    var answer = answersByQuestionId[current.id];
    if(!answer) break;
    var matched = null;
    for(var i=0;i<(branching.branches||[]).length;i++){
      if(evalCondition(branching.branches[i], current, answer)){ matched = branching.branches[i]; break; }
    }
    var nextId = matched ? matched.targetQuestionId : branching.elseTargetQuestionId;
    if(nextId === 'END') break;
    if(nextId === null || nextId === undefined){
      var idx2 = sorted.indexOf(current);
      current = sorted[idx2+1];
      continue;
    }
    current = byId[nextId];
  }
  return path;
}

// ── Schéma en arbre (lecture seule) ──
// Construit récursivement un arbre {question, children:[{label,node}]} en
// suivant chaque branche + le "Sinon" ; une question référencée par
// plusieurs chemins est redessinée à chaque occurrence (pas de fusion de
// graphe — simplification assumée, cf. décision du 22/10/2026) ; une boucle
// (branche qui revient en arrière) est coupée avec un nœud "↻ boucle".

function buildTree(byId, ordered, id, guard){
  if(id === 'END' || id == null) return { end: id==='END' };
  if(guard[id]) return { loopTo: id };
  var q = byId[id];
  if(!q) return null;
  var guard2 = Object.assign({}, guard); guard2[id] = true;
  var idx = ordered.indexOf(id);
  var defaultNextId = ordered[idx+1] != null ? ordered[idx+1] : null;
  var children = [];
  var branching = q.branching;
  if(branching && (branching.branches||[]).length){
    branching.branches.forEach(function(b){
      var targetId = b.targetQuestionId === undefined ? null : b.targetQuestionId;
      var node = targetId === 'END' ? {end:true} : targetId ? buildTree(byId, ordered, targetId, guard2) : buildTree(byId, ordered, defaultNextId, guard2);
      children.push({ label: b.label || (operatorLabel(b.operator)+' '+valueLabel(q, b.value)), node: node });
    });
    var elseId = branching.elseTargetQuestionId === undefined ? null : branching.elseTargetQuestionId;
    var elseNode = elseId === 'END' ? {end:true} : elseId ? buildTree(byId, ordered, elseId, guard2) : buildTree(byId, ordered, defaultNextId, guard2);
    children.push({ label: 'Sinon', node: elseNode, isElse: true });
  } else if(defaultNextId != null){
    children.push({ label: null, node: buildTree(byId, ordered, defaultNextId, guard2) });
  }
  return { question: q, children: children };
}

function subtreeWidth(node){
  if(!node) return 1;
  if(node.end || node.loopTo) return 1;
  if(!node.children || !node.children.length) return 1;
  var w = 0;
  node.children.forEach(function(c){ w += subtreeWidth(c.node); });
  return Math.max(1, w);
}

var COL_W = 220, ROW_H = 118, BOX_W = 196, BOX_H = 76;

function layout(node, col, row, out){
  if(!node) return;
  var w = subtreeWidth(node);
  var cx = (col + w/2) * COL_W;
  if(node.end){
    out.boxes.push({ x: cx, y: row*ROW_H, end: true });
    return;
  }
  if(node.loopTo){
    out.boxes.push({ x: cx, y: row*ROW_H, loopTo: node.loopTo });
    return;
  }
  out.boxes.push({ x: cx, y: row*ROW_H, question: node.question, id: node.question.id });
  var childCol = col;
  (node.children||[]).forEach(function(c){
    var cw = subtreeWidth(c.node);
    var childCx = (childCol + cw/2) * COL_W;
    out.edges.push({ x1: cx, y1: row*ROW_H + BOX_H, x2: childCx, y2: (row+1)*ROW_H, label: c.label, isElse: c.isElse });
    layout(c.node, childCol, row+1, out);
    childCol += cw;
  });
}

function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

var TYPE_ICON = { single:'◉', select:'▾', multi:'☑', boolean:'⊙', text:'✎', shorttext:'✎', number:'#', checkbox:'☑', rating:'★', file:'📎' };

/** Rend le schéma en arbre (lecture seule) dans containerEl, pour la liste
 * `questions` entière (pas un seul chemin — toutes les branches possibles).
 * Aucune dépendance externe : SVG pour les traits, divs pour les boîtes. */
function renderDiagram(containerEl, questions){
  if(!questions || !questions.length){ containerEl.innerHTML = '<div style="padding:20px;color:#888;font-size:13px">Aucune question.</div>'; return; }
  var ordered = questions.slice().sort(function(a,b){return a.order-b.order;}).map(function(q){return q.id;});
  var byId = {}; questions.forEach(function(q){ byId[q.id] = q; });
  var tree = buildTree(byId, ordered, ordered[0], {});
  var out = { boxes: [], edges: [] };
  layout(tree, 0, 0, out);

  var maxX = 0, maxY = 0;
  out.boxes.forEach(function(b){ if(b.x+BOX_W/2>maxX) maxX=b.x+BOX_W/2; if(b.y+BOX_H>maxY) maxY=b.y+BOX_H; });
  var svgParts = out.edges.map(function(e){
    var midY = (e.y1+e.y2)/2;
    var path = 'M'+e.x1+','+e.y1+' C'+e.x1+','+midY+' '+e.x2+','+midY+' '+e.x2+','+e.y2;
    var stroke = e.isElse ? '#b8b0c8' : '#8a5cf6';
    var dash = e.isElse ? ' stroke-dasharray="4 3"' : '';
    var label = e.label ? '<text x="'+((e.x1+e.x2)/2)+'" y="'+(midY-4)+'" text-anchor="middle" font-size="10" fill="#6b5b95" style="paint-order:stroke;stroke:#fff;stroke-width:3px">'+esc(e.label)+'</text>' : '';
    return '<path d="'+path+'" fill="none" stroke="'+stroke+'" stroke-width="1.6"'+dash+'/>'+label;
  }).join('');

  var boxesHtml = out.boxes.map(function(b){
    var left = (b.x - BOX_W/2), top = b.y;
    if(b.end){
      return '<div style="position:absolute;left:'+left+'px;top:'+top+'px;width:'+BOX_W+'px;height:40px;border:1.5px solid #d9534f;border-radius:20px;background:#fff5f5;color:#c0392b;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center">Fin du questionnaire</div>';
    }
    if(b.loopTo){
      return '<div style="position:absolute;left:'+left+'px;top:'+top+'px;width:'+BOX_W+'px;height:40px;border:1.5px dashed #c9a227;border-radius:10px;background:#fffbea;color:#8a6d00;font-size:11px;display:flex;align-items:center;justify-content:center">↻ retour à une question déjà passée</div>';
    }
    var q = b.question;
    var branchBadge = (q.branching && (q.branching.branches||[]).length) ? '<span style="position:absolute;top:-8px;right:8px;background:#8a5cf6;color:#fff;font-size:9px;padding:2px 6px;border-radius:8px">branche</span>' : '';
    return '<div style="position:absolute;left:'+left+'px;top:'+top+'px;width:'+BOX_W+'px;min-height:'+BOX_H+'px;border:1px solid #e2dfd9;border-radius:10px;background:#fff;padding:8px 10px;box-shadow:0 1px 3px rgba(0,0,0,.06)">'
      + branchBadge
      + '<div style="font-size:9px;color:#8a5cf6;font-weight:700;letter-spacing:.03em;text-transform:uppercase">'+(TYPE_ICON[q.type]||'?')+' '+esc(q.type)+'</div>'
      + '<div style="font-size:12px;font-weight:500;margin-top:3px;line-height:1.3;max-height:2.6em;overflow:hidden">'+esc(q.label)+'</div>'
      + '</div>';
  }).join('');

  containerEl.innerHTML =
    '<div style="position:relative;overflow:auto;border:1px solid #e2dfd9;border-radius:10px;background:repeating-linear-gradient(0deg,#fafaf8,#fafaf8 1px,transparent 1px,transparent 24px),repeating-linear-gradient(90deg,#fafaf8,#fafaf8 1px,transparent 1px,transparent 24px);max-height:640px">'
    + '<div style="position:relative;width:'+(maxX+40)+'px;height:'+(maxY+20)+'px;margin:20px">'
    + '<svg width="'+(maxX+40)+'" height="'+(maxY+20)+'" style="position:absolute;left:0;top:0;pointer-events:none">'+svgParts+'</svg>'
    + boxesHtml
    + '</div></div>';
}

global.QuestionnaireFlow = {
  operatorsForType: operatorsForType,
  operatorLabel: operatorLabel,
  canBranch: canBranch,
  evalCondition: evalCondition,
  valueLabel: valueLabel,
  walkPath: walkPath,
  renderDiagram: renderDiagram,
};
})(window);
