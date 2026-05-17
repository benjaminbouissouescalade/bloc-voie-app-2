# 🧗 Bloc & Voie — Carnet d'entraînement escalade

Application web complète de suivi d'entraînement escalade avec Coach IA.

---

## Installation sur ton Mac (15 min)

### Étape 1 — Node.js

Ouvre le Terminal et tape :
```bash
node --version
```

Si tu vois `command not found`, installe Node.js :
```bash
# Installe Homebrew si pas encore fait
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Puis Node.js
brew install node
```

---

### Étape 2 — Clé API Anthropic (pour le Coach IA)

1. Va sur **console.anthropic.com**
2. Crée un compte
3. Clique sur **API Keys** → **Create Key**
4. Copie la clé (commence par `sk-ant-...`)
5. Mets 10€ de crédit (largement suffisant pour des mois d'utilisation)

---

### Étape 3 — GitHub (pour déployer sur Railway)

1. Va sur **github.com** et crée un compte si pas encore fait
2. Crée un nouveau repository nommé `bloc-voie-app`
3. Mets-le en **privé** (tes données resteront privées)

---

### Étape 4 — Mettre le projet sur GitHub

Dans le Terminal :
```bash
# Va dans le dossier du projet
cd ~/Downloads/bloc-voie-app   # ou là où tu as mis le dossier

# Initialise Git
git init
git add .
git commit -m "Premier commit — Bloc & Voie"

# Connecte à GitHub (remplace TON-USERNAME par ton pseudo GitHub)
git remote add origin https://github.com/TON-USERNAME/bloc-voie-app.git
git branch -M main
git push -u origin main
```

---

### Étape 5 — Déployer sur Railway

1. Va sur **railway.app**
2. Clique **Login with GitHub**
3. Clique **New Project** → **Deploy from GitHub repo**
4. Sélectionne `bloc-voie-app`
5. Railway détecte automatiquement Node.js et démarre le déploiement

#### Ajouter la base de données PostgreSQL :
1. Dans ton projet Railway → **+ New** → **Database** → **PostgreSQL**
2. Railway crée la base et ajoute automatiquement `DATABASE_URL` aux variables

#### Ajouter ta clé API Anthropic :
1. Dans ton projet Railway → **Variables**
2. Clique **+ New Variable**
3. Nom : `ANTHROPIC_API_KEY`
4. Valeur : ta clé `sk-ant-...`
5. Clique **Add**

#### Ton URL :
Railway te donne une URL du type `bloc-voie-app.railway.app`
→ C'est ton app, accessible partout !

---

### Étape 6 — Tester en local (optionnel)

```bash
# Dans le dossier du projet
cp .env.example .env
# Édite .env et mets ta vraie clé Anthropic + l'URL de la DB Railway

npm install
npm run dev
# Ouvre http://localhost:3000
```

---

## Structure du projet

```
bloc-voie-app/
├── public/
│   └── index.html          ← Toute l'interface (HTML/CSS/JS)
├── src/
│   ├── server.js            ← Serveur Express principal
│   ├── db/
│   │   └── schema.js        ← Schéma PostgreSQL + connexion
│   └── routes/
│       ├── climbers.js      ← API grimpeurs
│       ├── logs.js          ← API séances
│       ├── bank.js          ← API banque de séances
│       └── ai.js            ← Proxy sécurisé → Anthropic
├── .env.example             ← Template variables d'environnement
├── .gitignore               ← Exclut .env et node_modules
└── package.json
```

---

## API disponibles

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/climbers` | Liste les grimpeurs |
| POST | `/api/climbers` | Crée/modifie un grimpeur |
| DELETE | `/api/climbers/:id` | Supprime un grimpeur |
| GET | `/api/logs/:climberId` | Séances d'un grimpeur |
| POST | `/api/logs/:climberId` | Crée/modifie une séance |
| POST | `/api/logs/:climberId/sync` | Sync complète des séances |
| GET | `/api/bank` | Banque de séances |
| POST | `/api/bank` | Ajoute une séance type |
| POST | `/api/bank/sync` | Sync complète de la banque |
| POST | `/api/ai/chat` | Proxy Coach IA (Anthropic) |
| GET | `/api/health` | Health check Railway |

---

## Coûts estimés

| Service | Coût |
|---|---|
| Railway (hébergement + DB) | ~5$/mois (inclus dans le free tier au début) |
| Anthropic API | ~2–10€/mois selon usage du Coach IA |
| **Total** | **~5–15€/mois** |

---

## Mise à jour de l'app

Quand tu veux modifier l'app :
```bash
# Fais tes modifications dans le dossier
git add .
git commit -m "Ma modification"
git push
# Railway redéploie automatiquement en 1–2 min
```
