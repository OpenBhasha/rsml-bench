// IndexedDB persistence. One database, two stores:
//   'state' - a single record under key 'project' (the whole project JSON)
//   'audio' - the working audio Blob, keyed 'audio'
//
// Everything the app needs to survive a reload lives here. A tiny promise
// wrapper, no external dependency.

const DB_NAME = "bhashacheck-v2";
const DB_VERSION = 1;
const STATE_STORE = "state";
const AUDIO_STORE = "audio";
const STATE_KEY = "project";

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const result = fn(s);
        t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export async function loadState() {
  try {
    return await tx(STATE_STORE, "readonly", (s) => s.get(STATE_KEY));
  } catch (err) {
    console.warn("[storage] loadState failed", err);
    return undefined;
  }
}

export async function saveState(obj) {
  return tx(STATE_STORE, "readwrite", (s) => s.put(obj, STATE_KEY));
}

// Library edits are kept per video so multiple clips can be recovered independently.
export async function loadLibraryRsml(id) {
  try { return await tx(STATE_STORE, "readonly", (s) => s.get(`${id}:rsml`)); }
  catch (err) { console.warn("[storage] loadLibraryRsml failed", err); return undefined; }
}

export async function saveLibraryRsml(id, text) {
  return tx(STATE_STORE, "readwrite", (s) => s.put({ text, updatedAt: Date.now() }, `${id}:rsml`));
}

export async function putAudio(key, blob) {
  return tx(AUDIO_STORE, "readwrite", (s) => s.put(blob, key));
}

export async function getAudio(key) {
  try {
    return await tx(AUDIO_STORE, "readonly", (s) => s.get(key));
  } catch (err) {
    console.warn("[storage] getAudio failed", err);
    return undefined;
  }
}

export async function deleteAudio(key) {
  return tx(AUDIO_STORE, "readwrite", (s) => s.delete(key));
}

export async function clearAll() {
  if (_dbPromise) {
    try {
      (await _dbPromise).close();
    } catch {}
    _dbPromise = null;
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // another tab holds it open; best effort
  });
}

// Remove obsolete per-video project/audio records. RSML recovery records are retained.
export async function purgeLibraryRecords() {
  const db = await openDB();
  for (const store of [STATE_STORE, AUDIO_STORE]) {
    await new Promise((resolve, reject) => {
      const t = db.transaction(store, "readwrite");
      const req = t.objectStore(store).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (/^[\w-]+:(project|audio)$/.test(String(c.key))) c.delete();
        c.continue();
      };
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error);
    });
  }
}
