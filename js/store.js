// Saves the content pack in the browser (IndexedDB) so players load it once.
const DB_NAME = "dnd-builder";
const STORE = "kv";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}

export const getPack = () => tx("readonly", s => s.get("pack")).catch(() => null);
export const savePack = pack => tx("readwrite", s => s.put(pack, "pack"));
export const removePack = () => tx("readwrite", s => s.delete("pack"));
