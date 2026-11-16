# MCVault

MCVault est une application desktop Windows permettant d’organiser, classer
et retrouver des sauvegardes locales de modpacks Minecraft.

## Fonctionnalités prévues

- Import de sauvegardes sous forme de dossier ou d’archive ZIP
- Déplacement des sauvegardes vers un dossier géré par l’application
- Bibliothèque de modpacks et de sauvegardes
- Statuts : En cours, En pause, Terminé, Abandonné
- Recherche et filtres
- Notes, tags et captures d’écran
- Historique des sauvegardes
- Détection des doublons et des anciennes versions
- Ouverture de l’emplacement réel d’une sauvegarde dans l’Explorateur Windows

## Technologies

- Electron
- JavaScript
- HTML
- CSS
- Node.js

## Installation

```bash
npm install
npm start
```

## Important

MCVault ne restaure pas automatiquement les mondes et ne modifie pas les
fichiers du launcher. Toute suppression ou restauration reste manuelle.