// src/lib/referenceDatasets.js
// Registre des jeux de données de référence externes utilisés dans l'app, avec leurs métadonnées
// de protocole par champ. Ajouter un futur dataset (nouvelle étude, nouveau test) = ajouter une
// entrée ici, sans toucher au moteur de calcul (referenceStats.js) ni à fingerProfile.js.
//
// Les infos de protocole (grip, mains, type de contraction) servent à ÉCRIRE les mises en garde
// affichées à l'utilisateur — elles ne servent jamais à décider automatiquement d'un niveau de
// confiance (retour utilisateur : la comparabilité scientifique est une décision humaine, posée
// explicitement dans src/lib/referenceMappings.js, jamais déduite d'une correspondance d'unité).

const fs = require('fs');
const path = require('path');

const REFERENCE_DATASETS = {
  berta_2024: {
    id: 'berta_2024',
    label: 'Berta et al. 2024',
    year: 2024,
    n: 307,
    population: 'Grimpeurs sportifs, tous niveaux (échelle IRCRA)',
    file: path.join(__dirname, '..', 'data', 'berta2024.json'),
    fieldProtocols: {
      mvc_kg_kg: {
        grip: 'semi_arque', hands: 'one_hand', contraction: 'max_volontaire_isometrique',
        note: 'Force maximale isométrique, une main, préhension semi-arquée.'
      },
      finger_hang_s: {
        grip: 'semi_arque', hands: 'two_hands', contraction: 'suspension_max',
        note: 'Temps de suspension maximal à deux mains, préhension semi-arquée.'
      },
      intermittent_kg_s_kg: {
        grip: 'semi_arque', hands: 'one_hand', contraction: 'intermittent',
        note: 'Endurance intermittente, une main, préhension semi-arquée.'
      },
      continuous_kg_s_kg: {
        grip: 'semi_arque', hands: 'one_hand', contraction: 'continu',
        note: 'Endurance continue, une main, préhension semi-arquée.'
      }
    }
  }
};

const _cache = {};
function loadDataset(datasetId) {
  if (_cache[datasetId]) return _cache[datasetId];
  const ds = REFERENCE_DATASETS[datasetId];
  if (!ds) throw new Error('Dataset de référence inconnu: ' + datasetId);
  const raw = fs.readFileSync(ds.file, 'utf-8');
  const data = JSON.parse(raw);
  _cache[datasetId] = data;
  return data;
}

module.exports = { REFERENCE_DATASETS, loadDataset };
