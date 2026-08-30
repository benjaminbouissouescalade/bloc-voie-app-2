// src/lib/referenceMappings.js
// Table explicite reliant une métrique de test Digger à un champ d'un dataset de référence externe,
// avec sa conversion d'unité et sa mise en garde. Chaque entrée est relue et décidée à la main —
// jamais générée automatiquement à partir d'une simple correspondance d'unité (retour utilisateur :
// "convertir des unités ne veut pas dire que deux mesures sont comparables").
//
// Un test Digger qui n'a PAS d'entrée ici n'a tout simplement aucun tableau de référence : le
// frontend n'affiche que la progression personnelle (dernier résultat, record, évolution %) —
// jamais de norme inventée (ex. Tractions/Tirage aujourd'hui, faute de dataset académique
// compatible connu).
//
// `requiresGripType` bloque la comparaison si le test n'a pas été fait dans la préhension à
// laquelle correspond le dataset — évite d'afficher une comparaison silencieusement fausse.

const REFERENCE_MAPPINGS = {
  smartboard_ratio: {
    datasetId: 'berta_2024',
    datasetField: 'mvc_kg_kg',
    unit: 'N/kg',
    convert: (kgPerKg) => kgPerKg * 9.81,
    requiresGripType: 'semi_arque',
    note: "Étude Berta et al. 2024 (307 grimpeurs) — force maximale isométrique, une main, préhension semi-arquée. Le SmartBoard peut mesurer dans une configuration légèrement différente (dispositif, nombre de mains) : à interpréter comme un repère, pas comme une équivalence stricte."
  },
  edge_hang_pctbw: {
    datasetId: 'berta_2024',
    datasetField: 'mvc_kg_kg',
    unit: '%',
    convert: (kgPerKg) => kgPerKg * 100,
    requiresGripType: 'semi_arque',
    note: "Étude Berta et al. 2024 (307 grimpeurs) — force maximale isométrique, une main, préhension semi-arquée. Le test de suspension sur réglette se fait généralement à deux mains : la comparaison donne un repère, pas une équivalence stricte."
  }
};

module.exports = { REFERENCE_MAPPINGS };
