export const DB_NAME = 'tripx';
export const DB_VERSION = 2;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (event) => {
            const db = req.result;
            const oldVersion = event.oldVersion;

            // --- V1 stores ---
            if (oldVersion < 1) {
                if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('categories')) db.createObjectStore('categories', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('cashBatches')) {
                    const s = db.createObjectStore('cashBatches', { keyPath: 'id' });
                    s.createIndex('byDate', 'date');
                }
                if (!db.objectStoreNames.contains('fxRates')) {
                    db.createObjectStore('fxRates', { keyPath: 'date' });
                }
                if (!db.objectStoreNames.contains('expenses')) {
                    const s = db.createObjectStore('expenses', { keyPath: 'id' });
                    s.createIndex('byDate', 'date');
                    s.createIndex('byCategory', 'categoryId');
                }
            }

            // --- V2: multi-trip support ---
            if (oldVersion < 2) {
                // Trips store
                if (!db.objectStoreNames.contains('trips')) {
                    db.createObjectStore('trips', { keyPath: 'id' });
                }

                // Add tripId indexes to existing stores
                const txn = req.transaction;

                const expStore = txn.objectStore('expenses');
                if (!expStore.indexNames.contains('byTrip')) {
                    expStore.createIndex('byTrip', 'tripId');
                }

                const catStore = txn.objectStore('categories');
                if (!catStore.indexNames.contains('byTrip')) {
                    catStore.createIndex('byTrip', 'tripId');
                }

                const cashStore = txn.objectStore('cashBatches');
                if (!cashStore.indexNames.contains('byTrip')) {
                    cashStore.createIndex('byTrip', 'tripId');
                }
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function tx(storeNames, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const t = db.transaction(storeNames, mode);
        const stores = storeNames.map(n => t.objectStore(n));
        const res = fn(...stores);
        t.oncomplete = () => resolve(res);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    });
}

export const put = (store, value) => tx([store], 'readwrite', (s) => s.put(value));
export const get = (store, key) => tx([store], 'readonly', (s) => new Promise((res, rej) => {
    const r = s.get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));
export const getAll = (store) => tx([store], 'readonly', (s) => new Promise((res, rej) => {
    const r = s.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));
export const del = (store, key) => tx([store], 'readwrite', (s) => s.delete(key));

export const indexGetAll = (store, indexName) => tx([store], 'readonly', (s) => new Promise((res, rej) => {
    const idx = s.index(indexName);
    const r = idx.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
}));

export const indexGetAllRange = (store, indexName, lower, upper) =>
    tx([store], 'readonly', (s) => new Promise((res, rej) => {
        const idx = s.index(indexName);
        let range = null;
        if (lower && upper) range = IDBKeyRange.bound(lower, upper);
        else if (lower) range = IDBKeyRange.lowerBound(lower);
        else if (upper) range = IDBKeyRange.upperBound(upper);
        const r = idx.getAll(range);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    }));

export const indexGetAllKey = (store, indexName, key) =>
    tx([store], 'readonly', (s) => new Promise((res, rej) => {
        const idx = s.index(indexName);
        const r = idx.getAll(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    }));