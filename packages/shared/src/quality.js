// Contrôles qualité par lecture. On ne supprime jamais une lecture : on la marque,
// et l'API transforme les marqueurs en alertes « boîtier / données ».
export const QUALITY_DEFAULTS = {
  min_plausible_db: 20, // en dessous : micro débranché ou valeur aberrante
  mic_spread_db: 15, // écart toléré entre les deux micros
};

export const FLAG_LABELS = {
  no_signal: 'Micros sans signal',
  missing_twa: 'TWA manquante',
  missing_lmax: 'Lmax manquant',
  missing_mic: 'Valeur micro manquante',
  out_of_range: 'Valeur hors plage plausible',
  twa_above_lmax: 'TWA supérieure au Lmax', // ancien contrôle, gardé pour les alertes existantes
  lmax_dsp_mismatch: 'Lmax supérieur ou égal au pic DSP',
  mic_divergence: 'Écart anormal entre les deux micros',
};

// Marqueurs qui excluent une lecture des niveaux, doses et statuts.
export const EXCLUDED_FLAGS = ['no_signal', 'out_of_range'];

export function qualityFlags(r, thresholds, opts = QUALITY_DEFAULTS) {
  // Micros et Lmax à 0.00 (convertis en null par le parseur) : le boîtier ne mesure rien.
  // La TWA reste alors autour de 3 dB, sans signification : on ne contrôle rien d'autre.
  if (r.mic1_db === null && r.mic2_db === null && r.lmax_db === null) return ['no_signal'];

  const flags = [];
  if (r.twa_db === null) flags.push('missing_twa');
  if (r.lmax_db === null) flags.push('missing_lmax');
  if (r.mic1_db === null || r.mic2_db === null) flags.push('missing_mic');

  // La TWA est une moyenne depuis le démarrage : elle peut être basse au début, on ne
  // contrôle que son maximum. Les niveaux instantanés sont contrôlés dans les deux sens.
  const instant = [r.mic1_db, r.mic2_db, r.lmax_db].filter((v) => v !== null);
  if (
    instant.some((v) => v < opts.min_plausible_db || v > Number(thresholds.max_db)) ||
    (r.twa_db !== null && r.twa_db > Number(thresholds.max_db))
  ) {
    flags.push('out_of_range');
  }

  // DSP = niveau max échantillonné à 96 kHz : il doit dépasser le Lmax (note firmware d'oct. 2026).
  // Contrôle seulement si le boîtier renseigne ses DSP (toujours 0 sur le firmware actuel).
  const peaks = Object.values(r.dsp ?? {}).filter((v) => v !== null && v !== undefined);
  if (r.lmax_db !== null && peaks.length && r.lmax_db >= Math.max(...peaks)) flags.push('lmax_dsp_mismatch');
  if (r.mic1_db !== null && r.mic2_db !== null && Math.abs(r.mic1_db - r.mic2_db) > opts.mic_spread_db) {
    flags.push('mic_divergence');
  }
  return flags;
}

// Niveau instantané : moyenne énergétique des micros présents (null sans signal).
export function instantLevel(r) {
  const mics = [r.mic1_db, r.mic2_db].filter((v) => v !== null && v !== undefined);
  if (!mics.length) return null;
  return 10 * Math.log10(mics.reduce((a, l) => a + 10 ** (l / 10), 0) / mics.length);
}
