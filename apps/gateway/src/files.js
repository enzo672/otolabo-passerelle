// Mode « fichiers » (note firmware d'octobre 2026, pas encore dans le vrai boîtier) :
// le boîtier finalise un CSV toutes les 20 min (P_xxxxxx.CSV) et le garde sur sa carte SD.
// À chaque cycle, pour chaque fichier en attente, dans l'ordre :
//   1. téléchargement, puis contrôle du sha256 annoncé par le boîtier ;
//   2. envoi à l'API, qui répond seulement après commit (stockage durable) ;
//   3. ACK au boîtier, qui renomme le fichier en S_ (synchronisé).
// L'ACK est noté dans .state/acks.json avant d'être envoyé et rejoué tant que le boîtier n'a
// pas répondu : un ACK perdu ou répété est sans effet (idempotent des deux côtés).
// Pas d'outbox ici : tant que l'API est injoignable, les fichiers restent sur la SD.
import { createHash } from 'node:crypto';
import { parseTwaLog, datePastFile, REBOOT_GAP_MS } from '@otolabo/shared';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Heure de fin de chaque fichier, pour dater les lignes écrites sans horloge réglée.
 * Démarrage en cours : fin = début du démarrage + closed_at_uptime_s → 'anchored'.
 * Démarrages précédents : placés à rebours, juste avant le démarrage suivant → 'estimated'.
 * Un fichier récupéré après coupure (closed_at_uptime_s inconnu) est le dernier de son démarrage :
 * on le fait finir après le dernier fichier fermé normalement, à raison d'une ligne ≈ 1 s.
 * @param {{id:number, boot:number, closed_at_uptime_s:number|null, rows:number}[]} files
 * @param {{boot:number, uptime_s:number}} status
 * @returns {Map<number, {endMs:number, source:'anchored'|'estimated'}>}
 */
export function planEndTimes(files, status, now = Date.now()) {
  const plan = new Map();
  const byBoot = new Map();
  for (const f of files) {
    if (!byBoot.has(f.boot)) byBoot.set(f.boot, []);
    byBoot.get(f.boot).push(f);
  }
  let bootStart = now - status.uptime_s * 1000;
  for (const boot of [...byBoot.keys()].sort((a, b) => b - a)) {
    const list = byBoot.get(boot);
    if (boot === status.boot) {
      for (const f of list) {
        plan.set(f.id, { endMs: bootStart + (f.closed_at_uptime_s ?? status.uptime_s) * 1000, source: 'anchored' });
      }
      continue;
    }
    const known = Math.max(0, ...list.map((f) => f.closed_at_uptime_s ?? 0));
    const closed = (f) => f.closed_at_uptime_s ?? known + f.rows;
    const len = Math.max(...list.map(closed));
    const end = bootStart - REBOOT_GAP_MS;
    for (const f of list) plan.set(f.id, { endMs: end - (len - closed(f)) * 1000, source: 'estimated' });
    bootStart = end - len * 1000;
  }
  return plan;
}

/**
 * @param {{ fetch: typeof fetch, postIngest: (item) => Promise<object|'rejected'>,
 *           store: object, gatewayId: string, log: Function, timeoutMs?: number, now?: () => number }} deps
 */
export function createFilesSync({ fetch, postIngest, store, gatewayId, log, timeoutMs = 15_000, now = Date.now }) {
  const base = (device) => device.base.replace(/\/$/, '');
  const get = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
    return res;
  };

  function pendingAcks(deviceId) {
    return store.getAcks()[deviceId] ?? {};
  }
  function setPendingAck(deviceId, seq, sum) {
    const all = store.getAcks();
    all[deviceId] = { ...(all[deviceId] ?? {}) };
    if (sum) all[deviceId][seq] = sum;
    else delete all[deviceId][seq];
    store.setAcks(all);
  }

  // true = ACK pris en compte (ou fichier déjà supprimé) ; false = à rejouer au prochain cycle.
  async function sendAck(device, seq, sum) {
    let res;
    try {
      res = await fetch(`${base(device)}/api/v1/files/${seq}/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha256: sum }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      log(`${device.id} : ACK ${seq} sans réponse (${err.message}), rejoué au prochain cycle`);
      return false;
    }
    if (res.ok || res.status === 404) {
      // 404 : fichier déjà synchronisé puis supprimé par la rétention.
      setPendingAck(device.id, seq, null);
      return true;
    }
    if (res.status === 409) {
      log(`${device.id} : ACK ${seq} refusé (sha256 différent), abandonné`);
      setPendingAck(device.id, seq, null);
      return false;
    }
    log(`${device.id} : ACK ${seq} en erreur (HTTP ${res.status}), rejoué au prochain cycle`);
    return false;
  }

  const heartbeat = (device, body) =>
    postIngest({ token: device.token, body: { device_id: device.id, gateway_id: gatewayId, rows: [], ...body } }).catch(() => {});

  /** @returns {Promise<boolean>} false si l'API est devenue injoignable pendant le cycle */
  return async function syncDeviceFiles(device, apiReachable) {
    // ACK restés sans réponse : d'abord, pour que le boîtier libère ses fichiers au plus tôt.
    for (const [seq, sum] of Object.entries(pendingAcks(device.id))) await sendAck(device, seq, sum);
    if (!apiReachable) return false;

    let status, files;
    try {
      status = await (await get(`${base(device)}/api/v1/status`)).json();
      files = await (await get(`${base(device)}/api/v1/files`)).json();
    } catch (err) {
      log(`${device.id} injoignable : ${err.message}`);
      await heartbeat(device, { status: 'device_unreachable', error: err.message });
      return true;
    }
    const sd = { pending: status.pending, free_bytes: status.free_bytes };
    const waiting = pendingAcks(device.id);
    const todo = files.filter((f) => f.status === 'P' && !waiting[f.id]).sort((a, b) => a.id - b.id);
    if (!todo.length) {
      await heartbeat(device, { status: 'ok', sd });
      return true;
    }
    const plan = planEndTimes(todo, status, now());

    let stored = 0;
    for (const f of todo) {
      let buf;
      try {
        buf = Buffer.from(await (await get(`${base(device)}/api/v1/files/${f.id}`)).arrayBuffer());
      } catch (err) {
        // Téléchargement interrompu : le fichier reste en attente sur la SD.
        log(`${device.id} : ${f.name} non téléchargé (${err.message})`);
        continue;
      }
      const sum = sha256(buf);
      if (sum !== f.sha256) {
        log(`${device.id} : ${f.name} incomplet ou modifié (sha256 différent), retenté au prochain cycle`);
        continue;
      }

      const parsed = parseTwaLog(buf.toString('utf8'), { defaultDeviceId: device.id });
      const issues = [...parsed.issues];
      if (parsed.consumedBytes < buf.length) issues.push({ line: 0, reason: 'truncated_line', raw: f.name });
      const unreadable = parsed.issues.filter((i) => i.line > 0).length;
      if (parsed.rows.length + unreadable !== f.rows) {
        issues.push({ line: 0, reason: 'row_count_mismatch', raw: `${f.rows} annoncée(s), ${parsed.rows.length} lue(s)` });
      }
      const rows = datePastFile(parsed, plan.get(f.id));
      const estimated = rows.filter((r) => r.ts_source === 'estimated').length;
      if (estimated) issues.push({ line: 0, reason: 'estimated_timestamps', raw: `${estimated} ligne(s)` });
      const own = rows.filter((r) => r.device_id === device.id);
      if (own.length !== rows.length) issues.push({ line: 0, reason: 'foreign_device_rows', raw: `${rows.length - own.length} ligne(s)` });
      const starts = parsed.events.filter((e) => e.type === 'system_start');
      const boots = starts.filter((e, i) => i === 0 || e.line !== starts[i - 1].line + 1).length;

      let result;
      try {
        result = await postIngest({
          token: device.token,
          body: {
            device_id: device.id,
            gateway_id: gatewayId,
            status: 'ok',
            boots,
            unit: parsed.unit,
            issues: issues.slice(0, 50),
            rows: own,
            file: { seq: f.id, sha256: sum, row_count: own.length },
            sd,
          },
        });
      } catch (err) {
        log(`${device.id} : API injoignable (${err.message}), ${f.name} reste sur la SD`);
        return false;
      }
      if (result === 'rejected' || !['stored', 'duplicate'].includes(result?.file_status)) {
        log(`${device.id} : ${f.name} refusé par l'API, pas d'ACK`);
        continue;
      }
      // Stockage confirmé : ACK noté avant envoi, rejoué si le boîtier ne répond pas.
      setPendingAck(device.id, f.id, sum);
      await sendAck(device, f.id, sum);
      stored += 1;
      log(`${device.id} : ${f.name} ${result.file_status === 'duplicate' ? 'déjà reçu' : `stocké (${result.inserted} lecture(s))`}`);
    }
    log(`${device.id} : ${stored}/${todo.length} fichier(s) synchronisé(s)`);
    return true;
  };
}
