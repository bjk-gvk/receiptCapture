// IndexedDB storage, so receipts survive the app being closed mid-trip.
// Photos are stored as ArrayBuffers (most portable across Safari versions).

const DB_NAME = 'receipt-capture';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('receipts', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const addReceipt = (r) => tx('receipts', 'readwrite', (s) => s.add(r));
export const countReceipts = () => tx('receipts', 'readonly', (s) => s.count());
export const deleteReceipt = (id) => tx('receipts', 'readwrite', (s) => s.delete(id));
export const clearReceipts = () => tx('receipts', 'readwrite', (s) => s.clear());
export const getMeta = (key) => tx('meta', 'readonly', (s) => s.get(key));
export const setMeta = (key, value) => tx('meta', 'readwrite', (s) => s.put(value, key));

export async function listReceipts() {
  const all = await tx('receipts', 'readonly', (s) => s.getAll());
  return all.sort((a, b) => a.capturedAt - b.capturedAt);
}

// Read-modify-write in one transaction, so a concurrent delete can't be undone.
export const updateDescription = (id, description) =>
  tx('receipts', 'readwrite', (s) => {
    const req = s.get(id);
    req.onsuccess = () => {
      if (req.result) s.put({ ...req.result, description });
    };
  });
