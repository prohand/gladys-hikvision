# Hikvision pour Gladys Assistant

Reliez vos **caméras IP et enregistreurs Hikvision (NVR / DVR)** à Gladys, **sur votre réseau
local** : images des caméras, détections en temps réel (mouvement, franchissement de ligne,
intrusion, sabotage…), entrées et sorties d'alarme, PTZ, scènes et un widget de tableau de bord.

- **100 % local** : Gladys dialogue directement avec chaque appareil via son ISAPI. Pas de compte
  Hik-Connect, pas de cloud, rien à ouvrir sur votre box.
- **Un enregistreur apporte toutes ses caméras** : ajoutez l'adresse du NVR, pas celle de chaque
  caméra branchée dessus.

## Ce qu'il faut

- Gladys **5.1 ou plus récent**.
- Une caméra ou un enregistreur Hikvision sur le même réseau que Gladys, avec une adresse IP fixe
  (réservation DHCP).
- Un compte utilisateur sur cet appareil (voir ci-dessous).

## 1. Préparer l'appareil

Dans l'interface web de la caméra ou de l'enregistreur :

1. **Créez un utilisateur dédié** : _Configuration > Système > Gestion des utilisateurs > Ajouter_.
   Donnez-lui le rôle **Opérateur**. Évitez `admin` : Gladys n'en a pas besoin.
   - Pour que Gladys puisse activer et désactiver les détections (armer / désarmer), l'utilisateur
     doit avoir le droit de modifier les paramètres (« Paramètres » / configuration à distance).
2. **Activez l'ISAPI** : _Configuration > Réseau > Paramètres avancés > Protocole d'intégration_ —
   cochez **Activer Hikvision-CGI** avec l'authentification **Digest**. Sur les firmwares récents,
   c'est activé par défaut.
3. **Notez le port HTTP** (_Réseau > Paramètres de base > Port_) s'il n'est pas 80.

> **Attention aux mots de passe** : Hikvision bloque le compte (souvent 30 minutes) après quelques
> mauvais mots de passe. L'intégration ne retente donc jamais seule un mot de passe refusé :
> corrigez-le, puis enregistrez à nouveau la configuration (ou appuyez sur **Tester la connexion**).

## 2. Configurer l'intégration

Dans Gladys : _Intégrations > Hikvision > Configuration_.

| Champ                            | Quoi saisir                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adresses                         | Adresse IP de chaque caméra ou enregistreur, séparées par des virgules : `192.168.1.64, 192.168.1.70:8080`. Ajoutez `https://` pour le HTTPS.             |
| Nom d'utilisateur / Mot de passe | Le compte créé ci-dessus. Le même compte sert pour tous les appareils.                                                                                    |
| Vérifier le certificat HTTPS     | Laissez désactivé : les appareils Hikvision ont un certificat auto-signé.                                                                                 |
| Intervalle des images (s)        | Fréquence de rafraîchissement de l'image de chaque caméra dans Gladys (60 s par défaut, 10 s minimum, 0 = seulement quand Gladys la demande).             |
| Qualité des images               | **Flux secondaire** (recommandé). Gladys accepte des images jusqu'à 150 Ko ; le flux principal est réduit en 1280×720, et remplacé s'il reste trop lourd. |
| Durée d'une détection (s)        | Combien de temps une détection reste « active » après le dernier événement de la caméra (10 s par défaut).                                                |
| Intervalle de vérification (s)   | Fréquence de vérification de chaque appareil (60 s par défaut).                                                                                           |
| Journaux détaillés               | À activer pour un diagnostic, puis à désactiver.                                                                                                          |

Enregistrez, puis appuyez sur **Tester la connexion** : une ligne par appareil indique le modèle, le
firmware, les caméras en ligne, les détections trouvées, si les événements arrivent en direct, et
les entrées / sorties d'alarme. En cas de problème, la ligne dit quoi faire.

Ouvrez ensuite l'onglet **Découverte** et créez les appareils voulus.

## 3. Les appareils dans Gladys

**Un appareil par caméra** (une caméra en a un, un enregistreur un par caméra branchée) :

| Fonctionnalité                      | Type                   | Remarques                                                                            |
| ----------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| Image                               | caméra                 | rafraîchie à l'intervalle des images, et à la demande                                |
| Mouvement                           | détecteur de mouvement | toujours présent                                                                     |
| Franchissement de ligne / Intrusion | détecteur de mouvement | si la caméra gère ces détections intelligentes                                       |
| Sabotage                            | sabotage               | si la caméra le gère                                                                 |
| Détection de mouvement / …          | interrupteur           | active ou désactive cette détection **sur la caméra** (armer / désarmer)             |
| PTZ                                 | mouvement caméra       | caméras PTZ uniquement : petits pas horizontaux / verticaux / zoom, toujours arrêtés |
| Preset                              | preset caméra          | caméras PTZ avec des positions enregistrées : la liste vient de la caméra            |

**Un appareil « alarm I/O » par caméra ou enregistreur doté de contacts secs** : chaque **entrée
d'alarme** est une entrée binaire (1 tant qu'elle est en alarme), chaque **sortie d'alarme**
(relais, sirène) est un interrupteur.

Chaque appareil affiche un badge **local** quand il répond, **injoignable** sinon. Un point orange
veut dire que l'appareil répond mais que son flux d'événements n'est pas connecté : les détections
n'arrivent pas.

## 4. Scènes

### Déclencheurs

- **Une caméra Hikvision détecte quelque chose** — filtres : la caméra, l'événement (mouvement,
  franchissement de ligne, intrusion, entrée / sortie de zone, sabotage, visage, changement de
  scène, objet abandonné ou retiré, PIR, perte vidéo, entrée d'alarme) et, pour les événements
  intelligents, la cible (personne ou véhicule). Déclenché une fois par détection, pas à chaque
  répétition de la caméra. Variables : `event_type`, `target`, `device_name`, `channel`,
  `description`.
- **Une caméra Hikvision se déconnecte** / **est de retour** — variables : `device_name` (et
  `reason` à la déconnexion).

Les fonctionnalités de détection (Mouvement, Intrusion…) s'utilisent aussi avec le déclencheur
standard « état d'un appareil ».

### Actions

- **Prendre une image Hikvision** — capture l'image maintenant. Placez-la juste avant l'action
  Gladys « Envoyer une image de caméra » pour recevoir le moment exact de la détection. Sortie :
  `captured`.
- **Armer ou désarmer une détection Hikvision** — active ou désactive une détection (mouvement,
  franchissement de ligne, intrusion, sabotage) d'une caméra. Sorties : `applied`, `enabled`.
- **Envoyer une caméra PTZ Hikvision sur un preset** — numéro du preset tel qu'enregistré sur la
  caméra. Sortie : `moved`.

Exemple : _Quand une intrusion avec la cible « personne » est détectée par la caméra Jardin, et que
personne n'est à la maison → prendre une image → envoyer l'image de la caméra → allumer la sirène
(sortie d'alarme)._

## 5. Widget de tableau de bord

Ajoutez le widget **Hikvision** à un tableau de bord : caméras en ligne, détections des dernières
24 heures, l'image d'une caméra (celle choisie dans les réglages du widget, sinon la dernière à
avoir détecté quelque chose) et la dernière détection de chaque caméra. Boutons : **Instantané**,
**Désarmer** et **Armer** (toutes les détections de toutes les caméras, après confirmation).

## Dépannage

| Problème                                     | Solution                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| « nom d'utilisateur ou mot de passe refusé » | Vérifiez-les dans l'interface web de l'appareil. Si le compte s'est bloqué, attendez environ 30 minutes, puis enregistrez à nouveau la configuration.                       |
| « l'appareil ne répond pas à l'ISAPI »       | Activez le protocole d'intégration (étape 1.2).                                                                                                                             |
| « cet utilisateur n'a pas les droits »       | Donnez-lui le rôle Opérateur, ou le droit de modifier les paramètres.                                                                                                       |
| Aucune détection n'arrive                    | Vérifiez que la détection est activée sur la caméra **et** que « Notifier le centre de surveillance » est coché dans sa méthode de liaison. Activez les journaux détaillés. |
| « l'image dépasse les 150 Ko »               | Baissez la résolution du flux secondaire de la caméra (par ex. 640×360).                                                                                                    |
| Une caméra de l'enregistreur est hors ligne  | Gladys l'affiche injoignable et déclenche « se déconnecte » ; elle revient toute seule.                                                                                     |
| HTTPS refusé                                 | Utilisez `http://` ou décochez « Vérifier le certificat HTTPS » ; vérifiez le port.                                                                                         |

## Vie privée et sécurité

Tout reste entre Gladys et vos appareils, sur votre réseau. Le mot de passe est rangé dans un champ
secret de Gladys et n'est jamais écrit dans les journaux. L'intégration ne garde dans son dossier
`/data` que ce qu'elle a appris des appareils (modèle, numéro de série, canaux), pour qu'un appareil
éteint au démarrage apparaisse quand même comme hors ligne.
