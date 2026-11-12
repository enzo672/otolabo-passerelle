// Persistance locale de la passerelle (fichiers JSON dans .state/) :
// offsets de lecture par boîtier + outbox des lots non encore acceptés par l'API
// + ACK du mode fichiers pas encore confirmés par le boîtier.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function createStore(dir) {
  mkdirSync(dir, { recursive: true });

  function read(name, fallback) {
    try {
      return JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  // Écriture atomique : une coupure de courant pendant l'écriture ne corrompt pas l'état.
  function write(name, value) {
    const tmp = join(dir, `${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, join(dir, name));
  }

  return {
    getDeviceState: (id) => read('offsets.json', {})[id],
    setDeviceState(id, s) {
      const all = read('offsets.json', {});
      all[id] = s;
      write('offsets.json', all);
    },
    getOutbox: () => read('outbox.json', []),
    setOutbox: (items) => write('outbox.json', items),
    getAcks: () => read('acks.json', {}),
    setAcks: (acks) => write('acks.json', acks),
  };
}
