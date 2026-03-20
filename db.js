export const DB_NAME = 'tripx';
export const DB_VERSION = 5;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onblocked = () => {
            alert('Database update blocked — please close other TripX tabs and reload.');
        };
        req.onupgradeneeded = () => {
            const db = req.result;

            // Ensure current stores + indexes exist (idempotent)
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'id' });
            }

            if (!db.objectStoreNames.contains('categories')) {
                const s = db.createObjectStore('categories', { keyPath: 'id' });
                if (!s.indexNames.contains('byTrip')) s.createIndex('byTrip', 'tripId');
            } else {
                const s = req.transaction.objectStore('categories');
                if (!s.indexNames.contains('byTrip')) s.createIndex('byTrip', 'tripId');
            }

            if (!db.objectStoreNames.contains('cashBatches')) {
                const s = db.createObjectStore('cashBatches', { keyPath: 'id' });
                if (!s.indexNames.contains('byDate')) s.createIndex('byDate', 'date');
                if (!s.indexNames.contains('byTrip')) s.createIndex('byTrip', 'tripId');
                if (!s.indexNames.contains('byCurrency')) s.createIndex('byCurrency', 'currency');
            } else {
                const s = req.transaction.objectStore('cashBatches');
                if (!s.indexNames.contains('byDate')) s.createIndex('byDate', 'date');
                if (!s.indexNames.contains('byTrip')) s.createIndex('byTrip', 'tripId');
                if (!s.indexNames.contains('byCurrency')) s.createIndex('byCurrency', 'currency');
            }

            if (!db.objectStoreNames.contains('fxRates')) {
                db.createObjectStore('fxRates', { keyPath: 'date' });
            }

            if (!db.objectStoreNames.contains('expenses')) {
                const s = db.createObjectStore('expenses', { keyPath: 'id' });
                if (!s.indexNames.contains('byDate')) s.createIndex('byDate', 'date');
                if (!s.indexNames.contains('byCategory')) s.createIndex('byCategory', 'categoryId');
                if (!s.indexNames.contains('byTrip')) s.createIndex('byTrip', 'tripId');
            } else {
                const s = req.transaction.objectStore('expenses');
                if (!s.indexNames.contains('byDate')) s.createIndex('byDate', 'date');
                if (!s.indexNames.contains('byCategory')) s.createIndex('byCategory', 'categoryId');
                if (!s.indexNames.contains('byTrip')) s.createIndex('byTrip', 'tripId');
            }

            if (!db.objectStoreNames.contains('trips')) {
                db.createObjectStore('trips', { keyPath: 'id' });
            }

            // Photo store: one photo per expense, keyed by expense id
            if (!db.objectStoreNames.contains('photos')) {
                db.createObjectStore('photos', { keyPath: 'expenseId' });
            }

            // One-time cleanup for legacy records:
            // Remove old global settings key 'app' if present.
            try {
                const txn = req.transaction;
                if (txn && txn.objectStoreNames.contains('settings')) {
                    const settingsStore = txn.objectStore('settings');
                    // Delete legacy 'app' key (ignore result)
                    settingsStore.delete('app');
                }
            } catch (err) {
                // swallow any errors during cleanup so upgrade still completes
            }

            // Migrate cashBatches: compute remainingCents from actual expense usage
            try {
                const txn = req.transaction;
                const hasExpenses = txn.objectStoreNames.contains('expenses');
                const hasBatches = txn.objectStoreNames.contains('cashBatches');
                if (hasBatches && hasExpenses) {
                    const expStore = txn.objectStore('expenses');
                    const batchStore = txn.objectStore('cashBatches');

                    // First pass: read all expenses to tally usage per cashBatchId
                    const expReq = expStore.getAll();
                    expReq.onsuccess = () => {
                        const expenses = expReq.result || [];
                        // Sum amountLocalCents spent per batch
                        const usageMap = new Map();
                        for (const e of expenses) {
                            if (e.cashBatchId && e.method === 'cash') {
                                usageMap.set(
                                    e.cashBatchId,
                                    (usageMap.get(e.cashBatchId) || 0) + (e.amountLocalCents || 0)
                                );
                            }
                        }

                        // Second pass: update each batch with correct remainingCents
                        const cursorReq = batchStore.openCursor();
                        cursorReq.onsuccess = () => {
                            const cursor = cursorReq.result;
                            if (cursor) {
                                const batch = cursor.value;
                                if (batch.remainingCents === undefined) {
                                    const spent = usageMap.get(batch.id) || 0;
                                    batch.remainingCents = Math.max(0, batch.purchasedAmountCents - spent);
                                    cursor.update(batch);
                                }
                                cursor.continue();
                            }
                        };
                    };
                }
            } catch (err) {
                // swallow migration errors so upgrade still completes
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