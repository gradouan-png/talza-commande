// Service de commande talza : compte les audits payés aujourd'hui et ouvre le paiement Stripe tant qu'il reste de la place.
// Gauthier, 23/11/2026 09h33-09h35 : « on a limiter à combien d'audit par jour dispo ? preciser que audit dispo le
// lendemain si stock out », « un truc dynamique », « construit compteur ».
//
//   GET /dispo      → { restants, limite, places_lancement, lancement, prix } (lu par le site pour le compteur)
//   GET /commander  → crée une page de paiement Stripe et y redirige ; complet → retour sur talza.io/#complet
//
// Aucun secret ici : tout vient de l'environnement (réglages Render). Aucune dépendance : Node 18+ et fetch.
//   STRIPE_CLE        clé RESTREINTE (rk_live_…) : Checkout Sessions en écriture, rien d'autre
//   PRIX_LANCEMENT    price_… à 19 € TTC
//   PRIX_NORMAL       price_… à 49 € TTC (facultatif : sans lui, plus de vente après le lancement)
//   FIN_LANCEMENT     2026-11-29T23:59:59+01:00
//   PLACES_LANCEMENT  20   (total au prix de lancement)
//   PAR_JOUR          5    (audits par jour, minuit à minuit, heure de Madrid)
//   SITE              https://talza.io
import http from "node:http";
import crypto from "node:crypto";

const E = process.env;
const CLE = E.STRIPE_CLE;
const SITE = (E.SITE || "https://talza.io").replace(/\/$/, "");
const PAR_JOUR = +(E.PAR_JOUR || 5);
const PLACES_LANCEMENT = +(E.PLACES_LANCEMENT || 20);
const FIN_LANCEMENT = Date.parse(E.FIN_LANCEMENT || "2026-11-29T23:59:59+01:00");
const DEBUT_LANCEMENT = Date.parse(E.DEBUT_LANCEMENT || "2026-11-23T00:00:00+01:00");
const ZONE = "Europe/Madrid";

if (!CLE || !E.PRIX_LANCEMENT) { console.error("STRIPE_CLE et PRIX_LANCEMENT sont obligatoires"); process.exit(1); }

async function stripe(chemin, corps) {
  const r = await fetch((E.STRIPE_API || "https://api.stripe.com/v1/") + chemin, {
    method: corps ? "POST" : "GET",
    headers: { Authorization: "Bearer " + CLE, ...(corps ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: corps ? new URLSearchParams(corps) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Stripe " + r.status + " : " + (j.error && j.error.message));
  return j;
}

// Minuit à Madrid, en secondes Unix (on cherche l'heure UTC où il est 00:00 à Madrid aujourd'hui).
function minuitMadrid(t = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  const ecoule = (+p.hour * 3600 + +p.minute * 60 + +p.second) * 1000;
  return Math.floor((t - ecoule) / 1000);
}

// Paiements réussis depuis `depuis` (secondes). Seules les sessions complètes ET payées comptent : une page de paiement
// ouverte puis abandonnée ne prend pas de place (sinon n'importe qui bloquerait la journée en ouvrant cinq pages).
async function payes(depuis, filtre = () => true) {
  let n = 0, apres = null;
  for (let tour = 0; tour < 10; tour++) {
    const q = new URLSearchParams({ status: "complete", limit: "100", "created[gte]": String(depuis) });
    if (apres) q.set("starting_after", apres);
    const j = await stripe("checkout/sessions?" + q);
    for (const s of j.data) if (s.payment_status === "paid" && filtre(s) && !/@(grapperagency\.com|talza\.io)$/i.test(s.customer_details?.email || "")) n++;   // un achat test de la maison ne prend pas de place
    if (!j.has_more || !j.data.length) break;
    apres = j.data[j.data.length - 1].id;
  }
  return n;
}

let cache = { t: 0, v: null };

/* ─── Tableau de bord (Gauthier, 23/11 11h52 : « go tableau de bord ») : clics sur « Commander » (sessions de paiement
   créées), ventes, chiffre d'affaires, abandons, par jour. Lecture seule de Stripe ; protégé par un mot de passe
   (TABLEAU_MDP, réglage Render) vérifié AVANT toute lecture ; sans ce réglage, la page n'existe pas. */
const jourMadrid = (sec) => new Intl.DateTimeFormat("fr-CA", { timeZone: ZONE }).format(new Date(sec * 1000));
async function sessionsDepuis(depuis) {
  const toutes = []; let apres = null;
  for (let tour = 0; tour < 20; tour++) {
    const q = new URLSearchParams({ limit: "100", "created[gte]": String(depuis) });
    if (apres) q.set("starting_after", apres);
    const j = await stripe("checkout/sessions?" + q);
    toutes.push(...j.data);
    if (!j.has_more || !j.data.length) break;
    apres = j.data[j.data.length - 1].id;
  }
  return toutes;
}
function autorise(req) {
  const mdp = E.TABLEAU_MDP || "";
  if (mdp.length < 12) return false;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const recu = Buffer.from(Buffer.from(m[1], "base64").toString("utf8").split(":").slice(1).join(":"));
  const attendu = Buffer.from(mdp);
  return recu.length === attendu.length && crypto.timingSafeEqual(recu, attendu);
}
/* Chiffres de prospection poussés par l'outil du Mac mini toutes les 10 minutes (compteurs seulement, aucun nom).
   Gardés en mémoire : après un redémarrage, le prochain envoi du Mac les remet. */
let prospection = null;
/* Visites de la page d'accueil (Gauthier, 23/11 12h20) : chaque chargement de talza.io demande /dispo ; on compte ces
   demandes venues du site, par jour, sans cookie ni adresse IP. Le Mac les reprend à chaque envoi de chiffres et les
   garde (la mémoire d'ici repart de zéro à chaque redémarrage). */
let visites = {};
/* Vues de la page d'exemple talza.io/exemple/ (Gauthier, 23/11 15h27 « go ») : c'est là que mène le lien des mails de
   prospection. Même principe : /vue appelé par la page, compté si l'Origin est le site, repris et gardé par le Mac. */
let vuesExemple = {};
function cleProspectionOk(req) {
  const cle = E.PROSPECTION_CLE || "";
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (cle.length < 32 || !m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(cle);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function recevoirProspection(req, res) {
  if (!cleProspectionOk(req)) { res.writeHead(401); return res.end(); }
  let corps = "";
  for await (const morceau of req) { corps += morceau; if (corps.length > 50_000) { res.writeHead(413); return res.end(); } }
  const d = JSON.parse(corps);
  const n = (v) => Number.isFinite(+v) && +v >= 0 ? Math.floor(+v) : 0;
  const parJour = {};
  for (const [j, v] of Object.entries(d.par_jour || {})) if (/^\d{4}-\d{2}-\d{2}$/.test(j)) parJour[j] = { mails1: n(v.mails1), relances: n(v.relances), reponses: n(v.reponses), rebonds: n(v.rebonds) };
  prospection = { recu: new Date().toISOString(), profils_trouves: n(d.profils_trouves), en_file: n(d.en_file), mails1: n(d.mails1), relances: n(d.relances),
    reponses: n(d.reponses), reponses_apres_relance: n(d.reponses_apres_relance), rebonds: n(d.rebonds), ecartes: n(d.ecartes), sans_reponse: n(d.sans_reponse), par_jour: parJour,
    visites: Object.fromEntries(Object.entries(d.visites || {}).filter(([j]) => /^\d{4}-\d{2}-\d{2}$/.test(j)).map(([j, v]) => [j, n(v)])),
    vues_exemple: Object.fromEntries(Object.entries(d.vues_exemple || {}).filter(([j]) => /^\d{4}-\d{2}-\d{2}$/.test(j)).map(([j, v]) => [j, n(v)])) };
  const aRendre = visites; visites = {};
  const exARendre = vuesExemple; vuesExemple = {};
  for (const [j, v] of Object.entries(exARendre)) prospection.vues_exemple[j] = (prospection.vues_exemple[j] || 0) + v;
  // Les visites rendues au Mac sont déjà comptées ici aussi : sinon le tableau baisse jusqu'au prochain envoi du Mac
  // (2 visites → 1, vu par Gauthier le 23/11 12h57).
  for (const [j, v] of Object.entries(aRendre)) prospection.visites[j] = (prospection.visites[j] || 0) + v;
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ visites: aRendre, vues_exemple: exARendre }));
}
function sectionProspection() {
  const p = prospection;
  if (!p) return '<h2>Prospection</h2><p class="s">Pas encore de chiffres : l\'outil du Mac mini les envoie toutes les 10 minutes.</p>';
  const pc = (a, b) => b ? Math.round(a * 100 / b) + " %" : "—";
  const carte = (v, t) => `<div class="carte"><b>${v}</b><span>${t}</span></div>`;
  const jours = Object.keys(p.par_jour).sort().reverse();
  const lignes = jours.map((j) => { const d = p.par_jour[j]; return `<tr><td>${h(j)}</td><td class="n">${d.mails1}</td><td class="n">${d.relances}</td><td class="n">${d.mails1 + d.relances}</td><td class="n">${d.reponses}</td><td class="n">${d.rebonds}</td></tr>`; }).join("");
  return `<h2>Prospection</h2><p class="s">Chiffres de l'outil d'envoi (mis à jour ${h(new Date(p.recu).toLocaleString("fr-FR", { timeZone: ZONE, timeStyle: "short", dateStyle: "short" }))}).</p>
<div class="cartes">${carte(p.profils_trouves, "profils trouvés")}${carte(p.mails1, "contactées (premier mail)")}${carte(pc(p.mails1, p.profils_trouves), "des profils trouvés contactés")}${carte(p.en_file, "en file, pas encore écrites")}
${carte(p.relances, "relances envoyées")}${carte(p.mails1 + p.relances, "mails envoyés au total")}${carte(p.reponses, "réponses")}${carte(pc(p.reponses, p.mails1), "taux de réponse")}
${carte(p.reponses_apres_relance, "réponses après relance")}${carte(p.rebonds, "rebonds (adresses invalides)")}${carte(pc(p.rebonds, p.mails1), "taux de rebond (à garder sous 3 %)")}${carte(p.sans_reponse, "sans réponse pour l'instant")}</div>
<div class="defile"><table><thead><tr><th>Jour</th><th class="n">Premiers mails</th><th class="n">Relances</th><th class="n">Total</th><th class="n">Réponses</th><th class="n">Rebonds</th></tr></thead><tbody>${lignes || '<tr><td colspan="6">—</td></tr>'}</tbody></table></div>`;
}
const h = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/* Tests exclus du tableau (Gauthier, 23/11 12h46 : « la vente vient de moi ») : adresses de la maison et sessions
   ouvertes avant la mise en vente réelle (essais du 23/11 au matin). */
const INTERNES = /@(grapperagency\.com|talza\.io)$/i;
const DEBUT_REEL = Date.parse(E.DEBUT_REEL || "2026-11-23T11:00:00+01:00") / 1000;
const estTest = (x) => INTERNES.test(x.customer_details?.email || x.customer_email || "") || x.created < DEBUT_REEL;
async function tableau(res) {
  const toutes = await sessionsDepuis(Math.floor(DEBUT_LANCEMENT / 1000));
  const ses = toutes.filter((x) => !estTest(x));
  const nbTests = toutes.length - ses.length;
  const parJour = {};
  for (const x of ses) {
    const j = jourMadrid(x.created), d = (parJour[j] ??= { clics: 0, ventes: 0, ca: 0, abandons: 0 });
    d.clics++;
    if (x.status === "complete" && x.payment_status === "paid") { d.ventes++; d.ca += (x.amount_total || 0) / 100; }
    else if (x.status === "expired") d.abandons++;
  }
  const jours = [...new Set([...Object.keys(parJour), ...Object.keys({ ...(prospection?.visites || {}), ...visites, ...(prospection?.vues_exemple || {}), ...vuesExemple })])].sort().reverse();
  for (const j of jours) parJour[j] ??= { clics: 0, ventes: 0, ca: 0, abandons: 0 };
  const tot = jours.reduce((t, j) => ({ clics: t.clics + parJour[j].clics, ventes: t.ventes + parJour[j].ventes, ca: t.ca + parJour[j].ca }), { clics: 0, ventes: 0, ca: 0 });
  const ventes = ses.filter((x) => x.status === "complete" && x.payment_status === "paid").slice(0, 20).map((x) => {
    const tk = (x.custom_fields || []).find((f) => f.key === "tiktok")?.text?.value || "—";
    return `<tr><td>${h(new Date(x.created * 1000).toLocaleString("fr-FR", { timeZone: ZONE, dateStyle: "short", timeStyle: "short" }))}</td><td>${h(tk)}</td><td class="n">${((x.amount_total || 0) / 100).toFixed(2).replace(".", ",")} €</td></tr>`;
  }).join("") || '<tr><td colspan="3">Aucune vente pour l\'instant.</td></tr>';
  const e = await etat();
  const vis = { ...(prospection?.visites || {}) };
  for (const [j, v] of Object.entries(visites)) vis[j] = (vis[j] || 0) + v;   // pas encore repris par le Mac
  const totVis = Object.values(vis).reduce((a, b) => a + b, 0);
  const vEx = (j) => (prospection?.vues_exemple?.[j] || 0) + (vuesExemple[j] || 0);
  const totEx = [...new Set([...Object.keys(prospection?.vues_exemple || {}), ...Object.keys(vuesExemple)])].reduce((a, j) => a + vEx(j), 0);
  const eur = (v) => v.toFixed(2).replace(".", ",") + " €";
  const lignes = jours.map((j) => { const d = parJour[j]; return `<tr><td>${h(j)}</td><td class="n">${(prospection?.visites?.[j] || 0) + (visites[j] || 0)}</td><td class="n">${vEx(j)}</td><td class="n">${d.clics}</td><td class="n">${d.ventes}</td><td class="n">${d.clics ? Math.round(d.ventes * 100 / d.clics) : 0} %</td><td class="n">${d.abandons}</td><td class="n">${eur(d.ca)}</td></tr>`; }).join("") || '<tr><td colspan="8">Aucun clic pour l\'instant.</td></tr>';
  const page = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>talza · tableau de bord</title>
<style>:root{color-scheme:light dark}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f4fb;color:#1c1340}@media(prefers-color-scheme:dark){body{background:#14121f;color:#ecebf3}.carte,table{background:#1d1a2c!important}td,th{border-color:#34304a!important}}
main{max-width:860px;margin:0 auto;padding:20px 16px}h1{font-size:1.3rem;margin:0 0 4px}p.s{margin:0 0 18px;opacity:.7;font-size:.9rem}.cartes{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:20px}.carte{background:#fff;border-radius:10px;padding:12px 14px}.carte b{display:block;font-size:1.6rem}.carte span{font-size:.85rem;opacity:.75}
h2{font-size:1rem;margin:22px 0 8px}.defile{overflow-x:auto}table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;font-size:.92rem}th,td{padding:8px 10px;border-bottom:1px solid #e6e1f3;text-align:left;white-space:nowrap}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}</style></head><body><main>
<h1>talza · tableau de bord</h1><p class="s">Données Stripe, lues à l'instant${nbTests ? ` (${nbTests} essai${nbTests > 1 ? "s" : ""} de la maison exclu${nbTests > 1 ? "s" : ""} : adresses grapperagency.com ou talza.io, et essais d'avant la mise en vente)` : ""}. Un « clic » = une page de paiement ouverte depuis « Commander mon rapport ». Les visites du site sont dans Cloudflare Web Analytics.</p>
<div class="cartes"><div class="carte"><b>${totVis}</b><span>visites de la page d'accueil</span></div><div class="carte"><b>${totEx}</b><span>vues de l'exemple (lien des mails)</span></div><div class="carte"><b>${totVis ? Math.round(tot.clics * 100 / totVis) : 0} %</b><span>des visites cliquent sur Commander</span></div><div class="carte"><b>${tot.clics}</b><span>clics sur Commander</span></div><div class="carte"><b>${tot.ventes}</b><span>ventes</span></div><div class="carte"><b>${tot.clics ? Math.round(tot.ventes * 100 / tot.clics) : 0} %</b><span>des clics finissent en vente</span></div><div class="carte"><b>${eur(tot.ca)}</b><span>encaissé TTC</span></div><div class="carte"><b>${e.restants}</b><span>rapports encore disponibles aujourd'hui</span></div><div class="carte"><b>${e.lancement ? e.places_lancement : "—"}</b><span>places au prix de lancement</span></div></div>
<h2>Par jour</h2><div class="defile"><table><thead><tr><th>Jour</th><th class="n">Visites</th><th class="n">Vues exemple</th><th class="n">Clics</th><th class="n">Ventes</th><th class="n">Taux</th><th class="n">Abandons</th><th class="n">Encaissé</th></tr></thead><tbody>${lignes}</tbody></table></div>
${sectionProspection()}
<h2>Dernières ventes</h2><div class="defile"><table><thead><tr><th>Date</th><th>TikTok</th><th class="n">Montant</th></tr></thead><tbody>${ventes}</tbody></table></div>
</main></body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
  res.end(page);
}
async function etat() {
  if (cache.v && Date.now() - cache.t < 20000) return cache.v;   // 20 s : le site interroge à chaque visite
  const lancement = Date.now() <= FIN_LANCEMENT;
  const aujourdhui = await payes(minuitMadrid());
  const lancementPris = lancement ? await payes(Math.floor(DEBUT_LANCEMENT / 1000), s => s.amount_total === 1900) : 0;
  const placesLancement = lancement ? Math.max(0, PLACES_LANCEMENT - lancementPris) : 0;
  let restants = Math.max(0, PAR_JOUR - aujourdhui);
  if (lancement) restants = Math.min(restants, placesLancement);
  if (!lancement && !E.PRIX_NORMAL) restants = 0;
  const v = { restants, limite: PAR_JOUR, lancement, places_lancement: placesLancement, prix: lancement ? 19 : 49 };
  cache = { t: Date.now(), v };
  return v;
}

async function commander(res) {
  cache.t = 0;                                   // recompter au moment de la commande, pas sur le cache
  const e = await etat();
  if (e.restants <= 0) return rediriger(res, SITE + "/#complet");
  const prix = e.lancement ? E.PRIX_LANCEMENT : E.PRIX_NORMAL;
  const s = await stripe("checkout/sessions", {
    mode: "payment",
    "line_items[0][price]": prix,
    "line_items[0][quantity]": "1",
    "automatic_tax[enabled]": "true",
    "tax_id_collection[enabled]": "true",
    "invoice_creation[enabled]": "true",
    "custom_fields[0][key]": "tiktok",
    "custom_fields[0][label][type]": "custom",
    "custom_fields[0][label][custom]": "Ton @ TikTok ou lien du profil (compte public)",
    "custom_fields[0][type]": "text",
    "custom_fields[1][key]": "nom",
    "custom_fields[1][label][type]": "custom",
    "custom_fields[1][label][custom]": "Ton prénom et ton nom (pour la facture)",
    "custom_fields[1][type]": "text",
    "custom_text[submit][message]": "Ton rapport TikTok arrive sous 48 h à l'adresse mail que tu donnes ici. Ton compte doit être public.",
    // Rétractation (Gauthier, 23/11 10h07) : sans cette case, une cliente peut demander le remboursement après livraison.
    "consent_collection[terms_of_service]": "required",
    "custom_text[terms_of_service_acceptance][message]": "J'accepte les [conditions de vente](" + SITE + "/conditions/). Je demande que la prestation commence tout de suite et je renonce à mon droit de rétractation une fois le rapport entièrement livré.",
    "metadata[offre]": e.lancement ? "audit-lancement" : "audit",
    success_url: SITE + "/merci/?commande={CHECKOUT_SESSION_ID}",
    cancel_url: SITE + "/",
  });
  return rediriger(res, s.url);
}

function rediriger(res, url) { res.writeHead(303, { Location: url, "Cache-Control": "no-store" }); res.end(); }

http.createServer(async (req, res) => {
  const chemin = new URL(req.url, "http://x").pathname;
  try {
    if (chemin === "/dispo") {
      if (req.headers.origin === SITE) { const j = jourMadrid(Date.now() / 1000); visites[j] = (visites[j] || 0) + 1; }
      const e = await etat();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": SITE, "Cache-Control": "no-store" });
      return res.end(JSON.stringify(e));
    }
    if (chemin === "/vue") {
      if (req.headers.origin === SITE) { const j = jourMadrid(Date.now() / 1000); vuesExemple[j] = (vuesExemple[j] || 0) + 1; }
      res.writeHead(204, { "Access-Control-Allow-Origin": SITE, "Cache-Control": "no-store" });
      return res.end();
    }
    if (chemin === "/commander") return await commander(res);
    if (chemin === "/commande") {
      const id = new URL(req.url, "http://x").searchParams.get("id") || "";
      if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(id)) { res.writeHead(404, { "Access-Control-Allow-Origin": SITE }); return res.end(); }
      const c = await stripe("checkout/sessions/" + id);
      const champ = (c.custom_fields || []).find(f => f.key === "tiktok");
      const tiktok = c.payment_status === "paid" && champ && champ.text ? champ.text.value : "";
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": SITE, "Cache-Control": "no-store" });
      // L'adresse de la commande, rendue à la seule page qui détient l'identifiant de session (Gauthier, 23/11 12h33 :
      // « précise mon mail ») : la cliente vérifie l'adresse où partira son rapport, comme sur le reçu Stripe.
      const email = c.payment_status === "paid" ? (c.customer_details?.email || "") : "";
      return res.end(JSON.stringify({ tiktok, email }));
    }
    if (chemin === "/sante") { res.writeHead(200); return res.end("ok"); }
    if (chemin === "/prospection" && req.method === "POST") return await recevoirProspection(req, res);
    if (chemin === "/tableau") {
      if (!E.TABLEAU_MDP) { res.writeHead(404); return res.end(); }
      if (!autorise(req)) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="talza", charset="UTF-8"', "Cache-Control": "no-store" }); return res.end("Mot de passe requis."); }
      return await tableau(res);
    }
    res.writeHead(404); res.end();
  } catch (err) {
    // Un refus ne renseigne pas : rien de Stripe ne part vers le navigateur ; le détail reste dans le journal Render.
    console.error(new Date().toISOString(), chemin, err.message);
    if (chemin === "/commander") return rediriger(res, SITE + "/#indisponible");
    res.writeHead(503, { "Access-Control-Allow-Origin": SITE }); res.end();
  }
}).listen(+(E.PORT || 3000), () => console.log("talza-commande prêt"));

