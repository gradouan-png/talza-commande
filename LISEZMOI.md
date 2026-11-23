# talza-commande — le compteur d'audits du jour

Service Node sans dépendance (serveur.mjs). Le site appelle `/dispo` pour afficher « Encore N audits disponibles
aujourd'hui » et envoie chaque bouton sur `/commander`, qui ouvre le paiement Stripe ou renvoie sur talza.io/#complet.

## Mise en ligne (Gauthier)
1. Stripe → Développeurs → Clés API → **Créer une clé restreinte** « talza-commande » : **Checkout Sessions : écriture**,
   tout le reste « Aucun ». Copier la clé `rk_live_…` (ne la coller nulle part ailleurs que dans Render).
2. Déposer le dossier `commande/` dans un dépôt GitHub (ex. `talza-commande`).
3. Render → New → **Web Service** → ce dépôt. Nom : `talza-commande` (l'adresse doit être
   https://talza-commande.onrender.com, sinon la changer dans index.html, constante SERVICE et les 7 boutons).
   Build : (vide) · Start : `node serveur.mjs` · Plan : Starter (le gratuit s'endort : 30-50 s d'attente au premier clic).
4. Variables d'environnement :
   STRIPE_CLE=rk_live_…  PRIX_LANCEMENT=price_1UescRJrusG6ri6lG94yYKuB  FIN_LANCEMENT=2026-11-29T23:59:59+01:00
   PLACES_LANCEMENT=20  PAR_JOUR=5  SITE=https://talza.io   (PRIX_NORMAL=price_… du 49 € quand il existera)
5. Vérifier : https://talza-commande.onrender.com/dispo → {"restants":5,…}

## Ce qu'il compte
Paiements Checkout « complets et payés » depuis minuit (heure de Madrid), tous canaux, y compris le lien Stripe direct.
Une page de paiement ouverte puis abandonnée ne prend pas de place. Deux commandes à la même seconde peuvent faire
une 6e : rare, accepté. Service injoignable : le site renvoie sur le lien Stripe direct (sans limite par jour).
Essai local : `faux-stripe.mjs` dans le scratchpad du 23/11 (STRIPE_API=http://localhost:4999/).
