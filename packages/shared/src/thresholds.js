// Seuils par défaut du brief Phase 1. Ils ne servent qu'à initialiser la base :
// en fonctionnement, le jeu actif est lu en base et modifiable depuis le tableau de bord.
export const DEFAULT_THRESHOLDS = {
  metric: 'twa_db', // champ comparé aux seuils (twa_db | lmax_db)
  warning_db: 85,
  critical_db: 100,
  max_db: 140, // au-delà : toujours Critical, mais la lecture est aussi signalée comme aberrante
};

export const LEVELS = ['normal', 'warning', 'critical'];

export function levelRank(level) {
  return LEVELS.indexOf(level);
}

export function classify(value, t) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'unknown';
  const v = Number(value);
  if (v >= Number(t.critical_db)) return 'critical';
  if (v >= Number(t.warning_db)) return 'warning';
  return 'normal';
}

export function classifyReading(reading, t) {
  return classify(reading[t.metric], t);
}

export function validateThresholds(t) {
  const errors = [];
  if (!['twa_db', 'lmax_db'].includes(t.metric)) errors.push('metric must be twa_db or lmax_db');
  for (const k of ['warning_db', 'critical_db', 'max_db']) {
    if (!Number.isFinite(Number(t[k]))) errors.push(`${k} must be a number`);
  }
  if (!(Number(t.warning_db) < Number(t.critical_db) && Number(t.critical_db) < Number(t.max_db))) {
    errors.push('thresholds must satisfy warning_db < critical_db < max_db');
  }
  return errors;
}
