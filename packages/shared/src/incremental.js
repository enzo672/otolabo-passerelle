// Lecture incrémentale de twa_log.csv : on ne retraite que ce qui a été ajouté depuis
// le dernier cycle. Le boîtier ne servant qu'un fichier entier (pas de Range garanti),
// on lit tout et on reprend à l'offset mémorisé. Utilisé par la passerelle (qui télécharge
// le fichier) et par l'API (envoi direct du fichier par le boîtier, apps/api/src/services/upload.js).
//
// Horodatage : le firmware actuel n'écrit pas de date, seulement Timestamp(s) = secondes
// depuis le démarrage (horloge non réglée). La passerelle date donc les lignes :
//   - session en cours : début = heure de lecture − elapsed de la dernière ligne
//     (la dernière ligne vient d'être écrite, le boîtier écrit chaque seconde) → 'anchored' ;
//   - session qui continue depuis le cycle précédent : même début mémorisé, pour que les
//     horodatages restent stables d'un cycle à l'autre ;
//   - session terminée entre deux cycles (redémarrage) : début estimé à rebours depuis la
//     session suivante → 'estimated' ;
//   - si un futur firmware écrit une vraie date, elle est utilisée telle quelle → 'device'.
import { createHash } from 'node:crypto';
import { parseTwaLog } from './csv.js';

const TAIL_BYTES = 256;
const DRIFT_TOLERANCE_MS = 30_000; // au-delà, on recale le début de session
export const REBOOT_GAP_MS = 10_000; // durée supposée d'un redémarrage (inconnue)

export const EMPTY_STATE = { offset: 0, tailHash: null, header: null, sessionStart: null, lastElapsed: null };

function tailHash(buf, offset) {
  return createHash('sha1')
    .update(buf.subarray(Math.max(0, offset - TAIL_BYTES), offset))
    .digest('hex');
}

/**
 * @param {Buffer} buf contenu complet du fichier servi par le boîtier
 * @param {object} state état mémorisé (EMPTY_STATE au premier passage)
 * @param {string} deviceId utilisé si le CSV n'a pas de colonne device_id
 * @param {number} [now] heure de lecture (ms), injectable pour les tests
 * @returns {{ rows, issues, state, reset: boolean, boots: number, unit: string|null }}
 *   reset = le fichier ne prolonge plus celui du cycle précédent (remplacé, tronqué) :
 *   on relit tout, la dédup côté API absorbe les lignes déjà reçues.
 */
export function extractNewRows(buf, state, deviceId, now = Date.now()) {
  let { offset, header } = state;
  let sessionStart = state.sessionStart ?? null;
  let lastElapsed = state.lastElapsed ?? null;
  let reset = false;

  if (offset > 0 && (buf.length < offset || tailHash(buf, offset) !== state.tailHash)) {
    offset = 0;
    header = null;
    sessionStart = null;
    lastElapsed = null;
    reset = true;
  }

  // L'offset tombe toujours juste après un \n : la découpe ne coupe pas un caractère UTF-8.
  const parsed = parseTwaLog(buf.subarray(offset).toString('utf8'), { header, defaultDeviceId: deviceId });
  const issues = [...parsed.issues];
  // Le firmware écrit plusieurs lignes « System start » d'affilée pour un seul démarrage.
  const starts = parsed.events.filter((e) => e.type === 'system_start');
  const boots = starts.filter((e, i) => i === 0 || e.line !== starts[i - 1].line + 1).length;

  // Sessions qui ont des mesures sans date absolue, dans l'ordre.
  const bySession = new Map();
  for (const r of parsed.rows) {
    if (r.ts || r.elapsed_s === null) continue;
    if (!bySession.has(r.session)) bySession.set(r.session, []);
    bySession.get(r.session).push(r);
  }
  const indexes = [...bySession.keys()].sort((a, b) => a - b);

  // La première session du morceau prolonge-t-elle celle du cycle précédent ?
  const first = indexes[0];
  const continues =
    first === 0 &&
    !parsed.sessions[0].boot &&
    sessionStart !== null &&
    lastElapsed !== null &&
    bySession.get(0)[0].elapsed_s >= lastElapsed;

  const anchors = new Map(); // session → { start (ms), source }
  for (let k = indexes.length - 1; k >= 0; k--) {
    const idx = indexes[k];
    const rows = bySession.get(idx);
    const last = rows[rows.length - 1].elapsed_s;
    if (k === indexes.length - 1) {
      // Session la plus récente : la dernière ligne vient d'être écrite.
      const fresh = now - last * 1000;
      if (idx === first && continues && Math.abs(fresh - sessionStart) <= DRIFT_TOLERANCE_MS) {
        anchors.set(idx, { start: sessionStart, source: 'anchored' });
      } else {
        if (idx === first && continues) issues.push({ line: 0, reason: 'clock_drift', raw: `${Math.round((fresh - sessionStart) / 1000)} s` });
        anchors.set(idx, { start: fresh, source: 'anchored' });
      }
    } else if (idx === first && continues) {
      anchors.set(idx, { start: sessionStart, source: 'anchored' });
    } else {
      // Session terminée avant la suivante : on remonte depuis le début de la suivante.
      const next = anchors.get(indexes[k + 1]);
      anchors.set(idx, { start: next.start - last * 1000 - REBOOT_GAP_MS, source: 'estimated' });
    }
  }

  let estimated = 0;
  const rows = parsed.rows.map((r) => {
    if (r.ts) return { ...r, ts_source: 'device', session_start: null };
    const a = anchors.get(r.session);
    if (a.source === 'estimated') estimated += 1;
    return {
      ...r,
      ts: new Date(Math.round(a.start + r.elapsed_s * 1000)).toISOString(),
      ts_source: a.source,
      session_start: new Date(Math.round(a.start)).toISOString(),
    };
  });
  if (estimated) issues.push({ line: 0, reason: 'estimated_timestamps', raw: `${estimated} ligne(s)` });

  // État pour le prochain cycle : la session en cours, sauf si un redémarrage vient d'avoir
  // lieu sans mesure derrière (la prochaine ligne ouvrira une nouvelle session).
  const lastIdx = indexes[indexes.length - 1];
  const trailingBoot = parsed.sessions[parsed.sessions.length - 1].boot && !bySession.has(parsed.sessions.length - 1);
  if (lastIdx !== undefined && !trailingBoot) {
    const lastRows = bySession.get(lastIdx);
    sessionStart = anchors.get(lastIdx).start;
    lastElapsed = lastRows[lastRows.length - 1].elapsed_s;
  } else if (boots || trailingBoot) {
    sessionStart = null;
    lastElapsed = null;
  }

  const newOffset = offset + parsed.consumedBytes;
  return {
    rows,
    issues,
    reset,
    boots,
    unit: parsed.unit,
    state: {
      offset: newOffset,
      tailHash: tailHash(buf, newOffset),
      header: parsed.header,
      sessionStart,
      lastElapsed,
    },
  };
}

/**
 * Date les lignes sans date absolue d'un fichier terminé : sa dernière ligne est à `endMs`,
 * les sessions précédentes du fichier (redémarrage au milieu) à rebours → 'estimated'.
 * Les lignes datées par le boîtier sont gardées telles quelles ('device').
 */
export function datePastFile(parsed, { endMs, source }) {
  const lastElapsed = new Map();
  for (const r of parsed.rows) if (!r.ts && r.elapsed_s !== null) lastElapsed.set(r.session, r.elapsed_s);
  const starts = new Map();
  let end = endMs;
  for (const s of [...lastElapsed.keys()].sort((a, b) => b - a)) {
    const start = end - lastElapsed.get(s) * 1000;
    starts.set(s, { start, source: starts.size ? 'estimated' : source });
    end = start - REBOOT_GAP_MS;
  }
  return parsed.rows.map((r) => {
    if (r.ts) return { ...r, ts_source: 'device', session_start: null };
    const a = starts.get(r.session);
    return {
      ...r,
      ts: new Date(Math.round(a.start + r.elapsed_s * 1000)).toISOString(),
      ts_source: a.source,
      session_start: new Date(Math.round(a.start)).toISOString(),
    };
  });
}
