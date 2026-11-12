// Correspondance colonnes CSV → champs normalisés.
// Les noms sont comparés après normalisation (casse, espaces et ponctuation ignorés) :
// « TWA(dB SPL) » → « twa_db_spl », « Timestamp(s) » → « timestamp_s ».
//
// Format réel du boîtier (TWA_LOG.CSV, firmware d'octobre 2026) :
//   HMS,Timestamp(s),Mic1_dB_SPL,Mic2_dB_SPL,TWA(dB SPL),Lmax(dB SPL),
//   CrestFactor_Mic1(dB),CrestFactor_Mic2(dB),DSP_0x2038_dB_SPL,DSP_0x2064_dB_SPL
// Les anciens noms (format supposé au démarrage du projet) restent acceptés.
export const COLUMN_ALIASES = {
  // Date absolue : absente du firmware actuel, prise en compte si elle apparaît.
  ts: ['timestamp', 'datetime', 'date_time', 'iso_time', 'timestamp_iso', 'utc', 'time_utc'],
  // Secondes depuis le démarrage du boîtier (repart de 0 à chaque redémarrage).
  elapsed_s: ['timestamp_s', 'elapsed_s', 'uptime_s', 'time_s'],
  // Heure « HH:MM:SS » du boîtier : depuis le démarrage tant que l'horloge n'est pas réglée.
  hms: ['hms', 'time_hms'],
  device_id: ['device_id', 'device', 'deviceid', 'serial'],
  mic1_db: ['mic1_db', 'mic1', 'mic_1', 'mic1_db_spl', 'mic1_dba', 'mic1_db_a'],
  mic2_db: ['mic2_db', 'mic2', 'mic_2', 'mic2_db_spl', 'mic2_dba', 'mic2_db_a'],
  twa_db: ['twa_db', 'twa', 'twa_db_spl', 'twa_dba', 'twa_db_a'],
  lmax_db: ['lmax_db', 'lmax', 'lmax_db_spl', 'lmax_dba', 'lmax_db_a'],
  crest1_db: ['crestfactor_mic1_db', 'crest_factor_mic1_db', 'crest_mic1', 'crest1_db'],
  crest2_db: ['crestfactor_mic2_db', 'crest_factor_mic2_db', 'crest_mic2', 'crest2_db'],
};

// Toute colonne dont le nom commence par un de ces préfixes est rangée dans `dsp`.
export const DSP_PREFIXES = ['dsp_'];

const KNOWN = new Set(Object.values(COLUMN_ALIASES).flat());

export function normalizeHeaderName(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Construit { field → index } + liste des colonnes DSP à partir de la ligne d'en-tête.
export function buildColumnMap(headerCells) {
  const names = headerCells.map(normalizeHeaderName);
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = names.findIndex((n) => aliases.includes(n));
    if (idx !== -1) map[field] = idx;
  }
  const dsp = [];
  names.forEach((n, idx) => {
    if (DSP_PREFIXES.some((p) => n.startsWith(p))) dsp.push({ name: n, idx });
  });
  return { map, dsp, names };
}

// Un en-tête contient au moins 3 noms de colonnes connus.
export function looksLikeHeader(cells) {
  const names = cells.map(normalizeHeaderName);
  return names.filter((n) => KNOWN.has(n) || DSP_PREFIXES.some((p) => n.startsWith(p))).length >= 3;
}

// Unité déclarée dans les en-têtes : 'dba' (pondéré A), 'spl' (non pondéré) ou null.
export function headerUnit(headerCells) {
  const names = headerCells.map(normalizeHeaderName);
  if (names.some((n) => /(^|_)db_?a($|_)|dba/.test(n))) return 'dba';
  if (names.some((n) => n.includes('spl'))) return 'spl';
  return null;
}
