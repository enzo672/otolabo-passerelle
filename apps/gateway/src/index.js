// Passerelle de collecte Otolabo, à faire tourner sur une machine du site (Pi, mini-PC)
// connectée au même Wi-Fi que les boîtiers. À chaque cycle :
//   1. renvoie les lots restés en attente (API injoignable au cycle précédent) ;
//   2. pour chaque boîtier, télécharge twa_log.csv, extrait les nouvelles lignes,
//      les pousse à l'API (ou les met en outbox) ;
//   3. envoie un heartbeat par boîtier, même sans nouvelle ligne, pour que l'API
//      détecte un boîtier ou une passerelle muets.
// Boîtier en `mode: 'files'` (fichiers de 20 min + ACK, voir files.js) : étape 2 remplacée
// par la synchronisation fichier par fichier, sans outbox.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractNewRows, EMPTY_STATE } from '@otolabo/shared';
import { createFilesSync } from './files.js';
import { createStore } from './store.js';

const API_URL = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const GATEWAY_ID = process.env.GATEWAY_ID ?? 'site-demo';
const INTERVAL_S = Number(process.env.SYNC_INTERVAL_SECONDS ?? 30);
// `url` : fichier unique (firmware actuel) ; `mode: 'files'` + `base` : fichiers de 20 min avec ACK.
// Un seul boîtier : DEVICE_ID, DEVICE_URL et DEVICE_TOKEN suffisent (plus simple à écrire dans un .env).
const DEVICES = process.env.GATEWAY_DEVICES
  ? JSON.parse(process.env.GATEWAY_DEVICES)
  : process.env.DEVICE_URL
    ? [{ id: process.env.DEVICE_ID, url: process.env.DEVICE_URL, token: process.env.DEVICE_TOKEN }]
    : [
        process.env.SIM_MODE === 'files'
          ? { id: 'OTO-001', mode: 'files', base: 'http://localhost:4101', token: 'dev-token-OTO-001' }
          : { id: 'OTO-001', url: 'http://localhost:4101/TWA_LOG.CSV', token: 'dev-token-OTO-001' },
      ];
const BATCH_SIZE = 1000;
const OUTBOX_MAX = 2000; // lots ; au-delà on jette les plus anciens (le boîtier garde son CSV)
const FETCH_TIMEOUT_MS = 15_000;

const store = createStore(join(dirname(fileURLToPath(import.meta.url)), '..', '.state'));

function log(...args) {
  console.log(`[gateway ${new Date().toISOString()}]`, ...args);
}

async function postIngest(item) {
  const res = await fetch(`${API_URL}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${item.token}` },
    body: JSON.stringify(item.body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // 4xx = lot refusé (token, format) : le renvoyer ne servira à rien.
  if (res.status >= 400 && res.status < 500) {
    const text = await res.text();
    log(`lot refusé par l'API (${res.status}) pour ${item.body.device_id} :`, text.slice(0, 200));
    return 'rejected';
  }
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function flushOutbox() {
  const pending = store.getOutbox();
  if (!pending.length) return true;
  log(`outbox : ${pending.length} lot(s) en attente`);
  while (pending.length) {
    try {
      await postIngest(pending[0]);
    } catch (err) {
      log(`API toujours injoignable (${err.message}), outbox conservée`);
      store.setOutbox(pending);
      return false;
    }
    pending.shift();
    store.setOutbox(pending);
  }
  log('outbox vidée');
  return true;
}

function enqueue(items) {
  const pending = store.getOutbox().concat(items);
  store.setOutbox(pending.slice(-OUTBOX_MAX));
}

async function syncDevice(device, apiReachable) {
  const prev = store.getDeviceState(device.id) ?? EMPTY_STATE;
  let buf;
  try {
    const res = await fetch(device.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    log(`${device.id} injoignable : ${err.message}`);
    if (apiReachable) {
      await postIngest({
        token: device.token,
        body: { device_id: device.id, gateway_id: GATEWAY_ID, status: 'device_unreachable', error: err.message, rows: [] },
      }).catch(() => {});
    }
    return;
  }

  const { rows, issues, state, reset, boots, unit } = extractNewRows(buf, prev, device.id);
  if (reset) log(`${device.id} : fichier réinitialisé (reboot ?), relecture complète`);
  if (boots) log(`${device.id} : ${boots} redémarrage(s) du boîtier`);

  // Une ligne d'un autre boîtier dans ce fichier serait refusée par l'API (token) : on la signale.
  const own = rows.filter((r) => r.device_id === device.id);
  if (own.length !== rows.length) {
    issues.push({ line: 0, reason: 'foreign_device_rows', raw: `${rows.length - own.length} ligne(s)` });
  }

  const batches = [];
  for (let i = 0; i < Math.max(own.length, 1); i += BATCH_SIZE) {
    batches.push({
      token: device.token,
      body: {
        device_id: device.id,
        gateway_id: GATEWAY_ID,
        status: 'ok',
        reset: reset && i === 0,
        boots: i === 0 ? boots : 0,
        unit,
        issues: i === 0 ? issues.slice(0, 50) : [],
        rows: own.slice(i, i + BATCH_SIZE),
      },
    });
  }

  let queued = 0;
  for (const [i, b] of batches.entries()) {
    if (!apiReachable) {
      // Heartbeat vide inutile en différé ; seules les lectures vont en outbox.
      if (b.body.rows.length) enqueue([b]);
      queued += b.body.rows.length;
      continue;
    }
    try {
      await postIngest(b);
    } catch (err) {
      log(`envoi ${device.id} échoué (${err.message}), mise en outbox`);
      apiReachable = false;
      enqueue(batches.slice(i).filter((x) => x.body.rows.length));
      queued += batches.slice(i).reduce((n, x) => n + x.body.rows.length, 0);
      break;
    }
  }
  // L'offset n'avance qu'une fois les lignes envoyées ou mises en outbox (persistée).
  store.setDeviceState(device.id, state);
  log(`${device.id} : ${own.length} nouvelle(s) ligne(s)${queued ? `, ${queued} en outbox` : ''}${issues.length ? `, ${issues.length} anomalie(s)` : ''}`);
  return apiReachable;
}

const syncDeviceFiles = createFilesSync({ fetch, postIngest, store, gatewayId: GATEWAY_ID, log, timeoutMs: FETCH_TIMEOUT_MS });

let running = false;
async function cycle() {
  // Un cycle lent (boîtier qui ne répond pas) ne doit pas chevaucher le suivant.
  if (running) return log('cycle précédent encore en cours, on saute');
  running = true;
  try {
    let apiReachable = await flushOutbox();
    for (const device of DEVICES) {
      const still = device.mode === 'files' ? await syncDeviceFiles(device, apiReachable) : await syncDevice(device, apiReachable);
      if (still === false) apiReachable = false;
    }
  } finally {
    running = false;
  }
}

log(`démarrage : ${DEVICES.length} boîtier(s), cycle ${INTERVAL_S}s, API ${API_URL}`);
await cycle();
if (!process.argv.includes('--once')) setInterval(() => cycle().catch((e) => log('cycle en erreur :', e)), INTERVAL_S * 1000);
