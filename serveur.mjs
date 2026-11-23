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
    for (const s of j.data) if (s.payment_status === "paid" && filtre(s)) n++;
    if (!j.has_more || !j.data.length) break;
    apres = j.data[j.data.length - 1].id;
  }
  return n;
}

let cache = { t: 0, v: null };
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
    "custom_text[submit][message]": "Ton audit TikTok arrive sous 48 h à l'adresse mail que tu donnes ici. Ton compte doit être public.",
    // Rétractation (Gauthier, 23/11 10h07) : sans cette case, une cliente peut demander le remboursement après livraison.
    "consent_collection[terms_of_service]": "required",
    "custom_text[terms_of_service_acceptance][message]": "J'accepte les [conditions de vente](" + SITE + "/conditions/). Je demande que l'audit commence tout de suite et je renonce à mon droit de rétractation une fois l'audit entièrement livré.",
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
      const e = await etat();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": SITE, "Cache-Control": "no-store" });
      return res.end(JSON.stringify(e));
    }
    if (chemin === "/commander") return await commander(res);
    if (chemin === "/commande") {
      const id = new URL(req.url, "http://x").searchParams.get("id") || "";
      if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(id)) { res.writeHead(404, { "Access-Control-Allow-Origin": SITE }); return res.end(); }
      const c = await stripe("checkout/sessions/" + id);
      const champ = (c.custom_fields || []).find(f => f.key === "tiktok");
      const tiktok = c.payment_status === "paid" && champ && champ.text ? champ.text.value : "";
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": SITE, "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ tiktok }));
    }
    if (chemin === "/sante") { res.writeHead(200); return res.end("ok"); }
    res.writeHead(404); res.end();
  } catch (err) {
    // Un refus ne renseigne pas : rien de Stripe ne part vers le navigateur ; le détail reste dans le journal Render.
    console.error(new Date().toISOString(), chemin, err.message);
    if (chemin === "/commander") return rediriger(res, SITE + "/#indisponible");
    res.writeHead(503, { "Access-Control-Allow-Origin": SITE }); res.end();
  }
}).listen(+(E.PORT || 3000), () => console.log("talza-commande prêt"));

