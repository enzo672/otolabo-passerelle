# Passerelle Otolabo

Petit programme qui lit le fichier `TWA_LOG.CSV` du boîtier Otolabo toutes les 30 secondes et l'envoie au serveur.
L'ordinateur qui le fait tourner doit être **sur le même réseau que le boîtier** et rester allumé (sans mise en veille).

## Installation

1. **Installer Node.js** (version LTS) : https://nodejs.org. Garder les options par défaut.
2. **Télécharger ce dossier** : bouton vert **Code** en haut de cette page → **Download ZIP**, puis dézipper.
3. **Vérifier que l'ordinateur voit le boîtier** : ouvrir `http://IP_DU_BOITIER/TWA_LOG.CSV` dans le navigateur. Des lignes de chiffres doivent s'afficher.
4. **Remplir le fichier `reglages.txt`** du dossier (double-clic pour l'ouvrir dans le Bloc-notes) :
   - remplacer `IP_DU_BOITIER` par l'adresse du boîtier ;
   - remplacer `COLLER_LE_TOKEN_ICI` par le token reçu d'Otolabo ;
   - enregistrer.
5. **Lancer** : double-cliquer sur `lancer-passerelle.bat` (Windows) ou `lancer-passerelle.command` (Mac).

Si tout va bien, cette ligne s'affiche toutes les 30 secondes :

```
OTO-002 : N nouvelle(s) ligne(s)
```

Laisser la fenêtre ouverte. Si on la ferme, rien n'est perdu : relancer suffit, la passerelle reprend où elle s'était arrêtée.

## En cas de problème

| Message | Cause |
|---|---|
| `OTO-002 injoignable` | Mauvaise adresse IP, ou l'ordinateur n'est pas sur le même réseau que le boîtier |
| `lot refusé par l'API (401)` | Le token dans `reglages.txt` est mal recopié |
| `mise en outbox` | Pas d'accès à Internet. Les mesures sont gardées et partiront au retour de la connexion |
| `Node.js n'est pas installé` | Refaire l'étape 1, puis relancer |

Autre chose : envoyer une capture de la fenêtre.
