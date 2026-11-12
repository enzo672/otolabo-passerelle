import { buildColumnMap, looksLikeHeader, headerUnit, normalizeHeaderName } from './columns.js';

// Champs où 0.00 signifie « pas de signal » (micros coupés), pas 0 dB.
const ZERO_IS_MISSING = ['mic1_db', 'mic2_db', 'lmax_db', 'crest1_db', 'crest2_db'];

function toNumber(v) {
  if (v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || /^(nan|null|na|-)$/i.test(s)) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function toIsoTimestamp(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  // Epoch en secondes ou millisecondes
  if (/^\d{10}(\.\d+)?$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  const d = new Date(s);
  // Une date avant 2020 vient d'une horloge non réglée (1970) : inutilisable.
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2020 ? null : d.toISOString();
}

// Ligne d'événement du boîtier, ex. « 1970-01-01 00:00:01,System start ».
function asEvent(cells) {
  if (cells.length !== 2 || toNumber(cells[1]) !== null || !cells[1].trim()) return null;
  const name = normalizeHeaderName(cells[1]);
  return { type: name === 'system_start' ? 'system_start' : name, at: cells[0].trim() };
}

/**
 * Parse un morceau de twa_log.csv.
 *
 * - En-têtes répétés (toutes les 60 lignes sur le boîtier) : ignorés.
 * - « <date>,System start » : événement de démarrage, qui ouvre une nouvelle session.
 * - Un Timestamp(s) qui diminue ouvre aussi une nouvelle session (redémarrage sans ligne d'événement).
 * - 0.00 sur les micros, le Lmax, les crest factors et les DSP → null (pas de signal).
 * - Une dernière ligne sans saut de ligne final est partielle : non consommée
 *   (`consumedBytes` s'arrête avant), elle sera relue au cycle suivant.
 *
 * @param {string} text
 * @param {{ header?: string[], defaultDeviceId?: string }} [opts]
 *   header : en-tête connu quand on parse une suite de fichier (lecture incrémentale).
 * @returns {{ rows: object[], sessions: {index:number, boot:boolean}[], events: object[],
 *             issues: object[], consumedBytes: number, header: string[]|null, unit: string|null }}
 *   rows[i].session renvoie à sessions[] ; sessions[k].boot = la session commence par un
 *   redémarrage vu dans ce morceau (sinon la session 0 peut prolonger celle du morceau précédent).
 */
export function parseTwaLog(text, opts = {}) {
  const rows = [];
  const events = [];
  const issues = [];
  let header = opts.header ?? null;
  let cols = header ? buildColumnMap(header) : null;
  const sessions = [{ index: 0, boot: false }];
  let pendingBoot = false;
  let lastElapsed = null;

  const lastNewline = text.lastIndexOf('\n');
  const complete = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
  const consumedBytes = Buffer.byteLength(complete, 'utf8');

  const newSession = () => {
    // Une session vide (deux redémarrages de suite) n'en crée pas une deuxième.
    const cur = sessions[sessions.length - 1];
    if (!rows.some((r) => r.session === cur.index)) {
      cur.boot = true;
      return;
    }
    sessions.push({ index: sessions.length, boot: true });
  };

  complete.split('\n').forEach((rawLine, i) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) return;
    const cells = line.split(',');
    const lineNo = i + 1;

    if (looksLikeHeader(cells)) {
      header = cells;
      cols = buildColumnMap(cells);
      return;
    }
    const ev = asEvent(cells);
    if (ev) {
      events.push({ ...ev, line: lineNo });
      if (ev.type === 'system_start') pendingBoot = true;
      return;
    }
    if (!cols) {
      issues.push({ line: lineNo, reason: 'no_header', raw: line });
      return;
    }
    if (cells.length !== header.length) {
      issues.push({ line: lineNo, reason: 'column_count_mismatch', raw: line });
      return;
    }

    const ts = cols.map.ts !== undefined ? toIsoTimestamp(cells[cols.map.ts]) : null;
    const elapsed = cols.map.elapsed_s !== undefined ? toNumber(cells[cols.map.elapsed_s]) : null;
    if (!ts && elapsed === null) {
      issues.push({ line: lineNo, reason: 'invalid_timestamp', raw: line });
      return;
    }
    const deviceId =
      (cols.map.device_id !== undefined ? cells[cols.map.device_id].trim() : '') || opts.defaultDeviceId;
    if (!deviceId) {
      issues.push({ line: lineNo, reason: 'missing_device_id', raw: line });
      return;
    }

    if (pendingBoot || (elapsed !== null && lastElapsed !== null && elapsed < lastElapsed)) newSession();
    pendingBoot = false;
    lastElapsed = elapsed;

    const row = {
      device_id: deviceId,
      ts,
      elapsed_s: elapsed,
      hms: cols.map.hms !== undefined ? cells[cols.map.hms].trim() : null,
      session: sessions[sessions.length - 1].index,
      dsp: {},
    };
    for (const f of ['mic1_db', 'mic2_db', 'twa_db', 'lmax_db', 'crest1_db', 'crest2_db']) {
      const v = cols.map[f] !== undefined ? toNumber(cells[cols.map[f]]) : null;
      row[f] = ZERO_IS_MISSING.includes(f) && v === 0 ? null : v;
    }
    for (const { name, idx } of cols.dsp) {
      const v = toNumber(cells[idx]);
      row.dsp[name] = v === 0 ? null : v;
    }
    rows.push(row);
  });

  // Redémarrage en fin de morceau, sans mesure derrière : la prochaine session commencera par un boot.
  if (pendingBoot) newSession();

  return { rows, sessions, events, issues, consumedBytes, header, unit: header ? headerUnit(header) : null };
}
