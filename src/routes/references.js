// src/routes/references.js
// Endpoint générique de comparaison à une population de référence — un seul endpoint réutilisable
// par n'importe quel test (SmartBoard, réglette, futurs tests), au lieu d'une route par test.
// Toute la logique de "est-ce que cette comparaison a un sens" est déjà tranchée dans
// referenceMappings.js (requiresGripType, conversion, note) : cette route ne fait qu'appliquer ce
// qui a été décidé, elle ne décide rien elle-même.
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { REFERENCE_MAPPINGS } = require('../lib/referenceMappings');
const { REFERENCE_DATASETS, loadDataset } = require('../lib/referenceDatasets');
const referenceStats = require('../lib/referenceStats');

router.use(requireAuth);

// GET /api/references/table?mapping=smartboard_ratio&ircra=20&gender=male&value=7.8&gripType=semi_arque
router.get('/table', (req, res) => {
  try {
    const mappingKey = req.query.mapping;
    const mapping = REFERENCE_MAPPINGS[mappingKey];
    if (!mapping) return res.json({ available: false, reason: 'no_mapping' });

    // Ne jamais comparer silencieusement si la préhension du test ne correspond pas à celle du
    // dataset (retour utilisateur : la conversion d'unité ne garantit pas la comparabilité).
    if (mapping.requiresGripType && req.query.gripType !== mapping.requiresGripType) {
      return res.json({ available: false, reason: 'grip_mismatch' });
    }

    const ircraTarget = parseInt(req.query.ircra, 10);
    const gender = req.query.gender || null;
    const value = parseFloat(req.query.value);
    if (!Number.isFinite(ircraTarget) || !gender || !Number.isFinite(value)) {
      return res.status(400).json({ error: 'ircra, gender et value sont requis' });
    }

    const dataset = REFERENCE_DATASETS[mapping.datasetId];
    if (!dataset) return res.json({ available: false, reason: 'unknown_dataset' });

    const data = loadDataset(mapping.datasetId);
    const { sample, window, n } = referenceStats.selectReferenceSample(data, ircraTarget, { gender, mode: 'same_sex' });
    const confidence = referenceStats.confidenceTier(n);

    const rawValues = sample.map(r => r[mapping.datasetField]).filter(v => v !== null && v !== undefined);
    const convertedValues = rawValues.map(mapping.convert).sort((a, b) => a - b);
    const table = {
      n: convertedValues.length,
      p10: referenceStats.quantile(convertedValues, 0.10),
      p25: referenceStats.quantile(convertedValues, 0.25),
      p50: referenceStats.quantile(convertedValues, 0.50),
      p75: referenceStats.quantile(convertedValues, 0.75),
      p90: referenceStats.quantile(convertedValues, 0.90)
    };
    const athletePercentile = referenceStats.percentileRank(value, convertedValues);

    res.json({
      available: true,
      unit: mapping.unit,
      table,
      window,
      confidence,
      athlete: { value, percentile: athletePercentile },
      source: { label: dataset.label, year: dataset.year, totalN: dataset.n, population: dataset.population },
      note: mapping.note
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
