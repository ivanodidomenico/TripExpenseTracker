import { put, get, getAll, del, indexGetAllRange, indexGetAllKey } from './db.js';
import { APP_VERSION } from './version.js';

// ---------- Money & Rate helpers ----------
const PPM = 1_000_000;

const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => (c / 100).toFixed(2);
const rateToPpm = (rateStr) => Math.round(Number(rateStr) * PPM);
const applyFeePpm = (ppm, feePercent) => Math.round(ppm * (1 + feePercent / 100));
const $ = (sel) => document.querySelector(sel);

// ---------- Date helpers (UTC storage ↔ local display) ----------

/** Returns today's date as a UTC YYYY-MM-DD string (for DB storage / FX lookups). */
const todayUTC = () => new Date().toISOString().slice(0, 10);

/** Returns today's date as a local YYYY-MM-DD string (for UI display / date inputs). */
const todayLocal = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Convert a local YYYY-MM-DD string (from a date input) to a UTC YYYY-MM-DD string.
 * Uses local noon to prevent any UTC offset (max ±14h) from shifting the calendar day.
 */
function localDateToUTC(localDateStr) {
    if (!localDateStr) return null;
    const [y, m, d] = localDateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d, 12, 0, 0);
    return dt.toISOString().slice(0, 10);
}

/**
 * Convert a UTC YYYY-MM-DD string (from the DB) to a local YYYY-MM-DD string for display.
 * Uses UTC noon to prevent any UTC offset (max ±14h) from shifting the calendar day.
 */
function utcDateToLocal(utcDateStr) {
    if (!utcDateStr) return '';
    const dt = new Date(utcDateStr + 'T12:00:00Z');
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// ---------- Photo helpers ----------
const MAX_PHOTO_WIDTH = 1200;
const PHOTO_QUALITY = 0.8;

function readAndResizePhoto(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Failed to read photo file.'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('Failed to decode image.'));
            img.onload = () => {
                let { width, height } = img;
                if (width > MAX_PHOTO_WIDTH) {
                    height = Math.round(height * (MAX_PHOTO_WIDTH / width));
                    width = MAX_PHOTO_WIDTH;
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

async function savePhoto(expenseId, dataUrl) {
    await put('photos', { expenseId, dataUrl });
}

async function getPhoto(expenseId) {
    return await get('photos', expenseId);
}

async function deletePhoto(expenseId) {
    await del('photos', expenseId);
}

// ---------- OCR: currency → Tesseract language mapping ----------
const CURRENCY_LANG_MAP = {
    EUR: ['spa', 'fra', 'deu', 'ita', 'por', 'nld'],
    GBP: ['eng'],
    CAD: ['eng', 'fra'],
    USD: ['eng', 'spa'],
    MXN: ['spa'],
    JPY: ['jpn'],
    CHF: ['deu', 'fra', 'ita'],
    BRL: ['por'],
    SEK: ['swe'],
    NOK: ['nor'],
    DKK: ['dan'],
    PLN: ['pol'],
    CZK: ['ces'],
    TRY: ['tur'],
    THB: ['tha', 'eng'],
    KRW: ['kor'],
    CNY: ['chi_sim'],
    AUD: ['eng'],
    NZD: ['eng'],
    HKD: ['eng', 'chi_sim'],
    SGD: ['eng'],
    INR: ['eng', 'hin'],
    ZAR: ['eng'],
    ILS: ['heb', 'eng'],
    ARS: ['spa'],
    CLP: ['spa'],
    COP: ['spa'],
    PEN: ['spa'],
    HUF: ['hun'],
    RON: ['ron'],
    BGN: ['bul'],
    HRK: ['hrv'],
    ISK: ['isl'],
    MAD: ['fra', 'ara'],
    EGP: ['ara', 'eng'],
};

const MAX_OCR_LANGS = 3;

function getOcrLangs(tripCurrencies, homeCurrency) {
    const langSet = new Set(['eng']);
    for (const cur of [homeCurrency, ...tripCurrencies]) {
        const langs = CURRENCY_LANG_MAP[cur.toUpperCase()];
        if (langs) langs.forEach(l => langSet.add(l));
    }
    // Cap at MAX_OCR_LANGS to keep OCR fast on mobile
    return Array.from(langSet).slice(0, MAX_OCR_LANGS).join('+');
}

// ---------- OCR: receipt text parsing ----------
function parseReceipt(ocrText) {
    const lines = ocrText.split('\n').map(l => l.trim()).filter(Boolean);

    // --- Store / merchant name extraction ---
    const moneyOrDateRe = /[\$€£¥]|\d{1,7}[.,]\d{2}|\d{2}[-/.]\d{2}[-/.]\d{2,4}|\d{4}[-/.]\d{2}[-/.]\d{2}/;
    const noiseRe = /^(tel|phone|fax|www\.|http|address|receipt|tax\s|vat|gst|abn|pos\b|terminal|cashier|server|welcome|thank|gracias|merci|danke)/i;
    let storeName = null;
    for (const line of lines.slice(0, 5)) {
        if (moneyOrDateRe.test(line)) break;
        if (noiseRe.test(line)) continue;
        const cleaned = line.replace(/[^a-zA-Z\u00C0-\u024F\u0400-\u04FF\u3000-\u9FFF\s'&.-]/g, '').trim();
        if (cleaned.length >= 3) {
            storeName = cleaned;
            break;
        }
    }

    // --- Date extraction ---
    const datePatterns = [
        /(\d{4}[-/.]\d{2}[-/.]\d{2})/,
        /(\d{2}[-/.]\d{2}[-/.]\d{4})/,
        /(\d{2}[-/.]\d{2}[-/.]\d{2})(?!\d)/,
    ];
    let dateMatch = null;
    for (const line of lines) {
        for (const pat of datePatterns) {
            const m = line.match(pat);
            if (m) { dateMatch = m[1]; break; }
        }
        if (dateMatch) break;
    }

    let isoDate = null;
    if (dateMatch) {
        const cleaned = dateMatch.replace(/[/.]/g, '-');
        const parts = cleaned.split('-');
        if (parts.length === 3) {
            let [a, b, c] = parts;
            if (a.length === 4) {
                isoDate = `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
            } else if (c.length === 4) {
                isoDate = `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
            } else if (c.length === 2) {
                const year = Number(c) > 50 ? `19${c}` : `20${c}`;
                isoDate = `${year}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
            }
        }
        if (isoDate && isNaN(Date.parse(isoDate))) isoDate = null;
    }

    // --- Total extraction ---
    const moneyPattern = /[\$€£¥]?\s?(\d{1,7}[.,]\d{2})\b/g;
    let totalAmount = null;
    let largestAmount = 0;

    for (const line of lines) {
        const isTotal = /\btotal\b/i.test(line) && !/\bsub\s?total\b/i.test(line);
        if (isTotal) {
            const m = line.match(moneyPattern);
            if (m) {
                const val = parseFloat(m[m.length - 1].replace(/[^\d.,]/g, '').replace(',', '.'));
                if (val > 0) totalAmount = val;
            }
        }
        let match;
        const scanPattern = /[\$€£¥]?\s?(\d{1,7}[.,]\d{2})\b/g;
        while ((match = scanPattern.exec(line)) !== null) {
            const val = parseFloat(match[1].replace(',', '.'));
            if (val > largestAmount) largestAmount = val;
        }
    }

    return {
        date: isoDate || null,
        total: totalAmount || largestAmount || null,
        storeName: storeName || null,
    };
}

// ---------- OCR: run Tesseract on a File ----------
let ocrWorker = null;

async function runOcr(file, langs) {
    if (typeof Tesseract === 'undefined') {
        throw new Error('Tesseract.js not loaded');
    }

    const result = await Tesseract.recognize(file, langs, {
        logger: (info) => {
            if (info.status === 'recognizing text') {
                const pct = Math.round((info.progress || 0) * 100);
                const statusText = document.getElementById('ocrStatusText');
                if (statusText) statusText.textContent = `Scanning receipt… ${pct}%`;
            }
        }
    });

    return result.data.text || '';
}

// ---------- Active trip ----------
let activeTripId = null;

function getActiveTripId() {
    if (!activeTripId) throw new Error('No trip selected. Create or select a trip first.');
    return activeTripId;
}

// ---------- Settings helpers (normalize & loader) ----------
function normalizeSettings(settings) {
    const s = Object.assign({ homeCurrency: 'CAD', ccFeePercent: 2.5 }, settings || {});
    if (Array.isArray(s.tripCurrencies)) {
        // already good
    } else if (s.tripCurrency) {
        s.tripCurrencies = [String(s.tripCurrency).toUpperCase()];
        delete s.tripCurrency;
    } else {
        s.tripCurrencies = ['EUR'];
    }
    s.homeCurrency = String(s.homeCurrency || 'CAD').toUpperCase();
    s.tripCurrencies = s.tripCurrencies.map(c => String(c).toUpperCase()).filter(Boolean);
    if (!s.tripCurrencies.length) s.tripCurrencies = [s.homeCurrency];
    return s;
}

async function loadSettings() {
    const raw = await get('settings', settingsKey());
    return normalizeSettings(raw);
}

// ---------- Trip management ----------
async function listTrips() {
    return await getAll('trips');
}

async function createTrip(name) {
    name = name.trim();
    if (!name) throw new Error('Trip name is required.');
    const id = crypto.randomUUID();
    const trip = { id, name, createdAt: new Date().toISOString() };
    await put('trips', trip);
    await put('settings', { id: `trip:${id}`, homeCurrency: 'CAD', tripCurrencies: ['EUR'], ccFeePercent: 2.5 });
    await put('categories', { id: crypto.randomUUID(), name: 'Meals', tripId: id });
    return trip;
}

async function deleteTrip(tripId) {
    const expenses = await indexGetAllKey('expenses', 'byTrip', tripId);
    for (const e of expenses) {
        // Restore cash batch remaining balance before deleting
        await restoreCashBatchBalance(e);
        await deletePhoto(e.id);
        await del('expenses', e.id);
    }
    const categories = await indexGetAllKey('categories', 'byTrip', tripId);
    for (const c of categories) await del('categories', c.id);
    // Cash batches are global — do NOT delete them when a trip is deleted
    await del('settings', `trip:${tripId}`);
    await del('trips', tripId);
}

async function renameTrip(tripId, newName) {
    newName = newName.trim();
    if (!newName) throw new Error('Trip name is required.');
    const trip = await get('trips', tripId);
    if (!trip) throw new Error('Trip not found.');
    trip.name = newName;
    await put('trips', trip);
}

// ---------- Tab navigation ----------
function initTabs() {
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            buttons.forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`page-${btn.dataset.page}`).classList.add('active');
        });
    });
}

// ---------- Settings ----------
function settingsKey() {
    return `trip:${getActiveTripId()}`;
}

async function ensureDefaults() {
    const trips = await listTrips();
    if (!trips.length) {
        const trip = await createTrip('My Trip');
        activeTripId = trip.id;
    } else {
        const lastTrip = localStorage.getItem('activeTrip');
        if (lastTrip && trips.some(t => t.id === lastTrip)) {
            activeTripId = lastTrip;
        } else {
            activeTripId = trips[0].id;
        }
    }
    localStorage.setItem('activeTrip', activeTripId);
    return await loadSettings();
}

// ---------- FX Rates ----------
async function upsertFxRate(dateStr, currency, ratePpm) {
    const settings = await loadSettings();
    const row = await get('fxRates', dateStr) || { date: dateStr, base: settings.homeCurrency, rates: {} };
    row.rates[currency] = ratePpm;
    await put('fxRates', row);
}

async function getFxRatePpmExact(dateStr, currency) {
    const row = await get('fxRates', dateStr);
    if (row && row.rates[currency]) return row.rates[currency];
    return null;
}

async function getFxRowAtOrBefore(dateStr) {
    const all = await getAll('fxRates');
    if (!all.length) return null;
    all.sort((a, b) => new Date(b.date) - new Date(a.date));
    if (!dateStr) return all[0];
    const target = new Date(dateStr).getTime();
    const row = all.find(r => new Date(r.date).getTime() <= target);
    return row || all[all.length - 1];
}

async function fetchAndCacheRate(dateStr, currency) {
    try {
        const settings = await loadSettings();
        const to = settings.homeCurrency.toUpperCase();
        const from = currency.toUpperCase();
        if (from === to) {
            const effectiveDate = dateStr || todayUTC();
            const ppm = PPM;
            await upsertFxRate(effectiveDate, from, ppm);
            return { ppm, source: 'identity' };
        }
        const datePath = dateStr || 'latest';
        const frankUrl = `https://api.frankfurter.app/${encodeURIComponent(datePath)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
        const res = await fetch(frankUrl);
        if (!res.ok) return null;
        const data = await res.json();
        const rate = (data.rates && data.rates[to]) ?? null;
        if (!rate) return null;
        const effectiveDate = data.date || dateStr;
        const ppm = rateToPpm(String(rate));
        await upsertFxRate(effectiveDate, from, ppm);
        return { ppm, source: 'frankfurter' };
    } catch {
        return null;
    }
}

async function getOrFetchRate(dateStr, currency) {
    currency = currency.toUpperCase();
    const settings = await loadSettings();
    const home = (settings.homeCurrency || '').toUpperCase();
    if (currency === home) return { ppm: PPM, source: 'identity' };
    let ppm = await getFxRatePpmExact(dateStr, currency);
    if (ppm) return { ppm, source: 'frankfurter' };
    const fetched = await fetchAndCacheRate(dateStr, currency);
    if (fetched) return fetched;
    const fxRow = await getFxRowAtOrBefore(dateStr);
    if (fxRow && fxRow.rates[currency]) return { ppm: fxRow.rates[currency], source: 'frankfurter' };
    return null;
}

// ---------- Cash Batches (GLOBAL — available to all trips) ----------

/** List ALL cash batches across all trips. */
async function listAllCashBatches() {
    return await getAll('cashBatches');
}

async function addCashBatch({ date, currency, rateStr, purchasedAmount }) {
    const purchasedAmountCents = toCents(purchasedAmount);
    await put('cashBatches', {
        id: crypto.randomUUID(),
        tripId: getActiveTripId(),
        date,
        currency: currency.toUpperCase(),
        ratePpm: rateToPpm(rateStr),
        purchasedAmountCents,
        remainingCents: purchasedAmountCents,
        note: ''
    });
}

/**
 * Pick the best cash batch for a given date and currency.
 * Searches ALL batches globally (not just current trip).
 * Only considers batches with remaining balance > 0 and date <= expense date.
 * Prefers the most recent batch by date, then the one with the most remaining balance.
 */
async function pickCashBatchFor(dateStr, currency) {
    const batches = await listAllCashBatches();
    const d = new Date(dateStr).getTime();
    const candidates = batches.filter(b =>
        b.currency === currency.toUpperCase() &&
        new Date(b.date).getTime() <= d &&
        (b.remainingCents === undefined || b.remainingCents > 0)
    );
    candidates.sort((a, b) => {
        const dateDiff = new Date(b.date) - new Date(a.date);
        if (dateDiff !== 0) return dateDiff;
        return (b.remainingCents ?? b.purchasedAmountCents) - (a.remainingCents ?? a.purchasedAmountCents);
    });
    return candidates[0] || null;
}

/** Deduct an amount from a cash batch's remaining balance. */
async function deductCashBatch(batchId, amountCents) {
    const batch = await get('cashBatches', batchId);
    if (!batch) return;
    if (batch.remainingCents === undefined) {
        batch.remainingCents = batch.purchasedAmountCents;
    }
    batch.remainingCents = Math.max(0, batch.remainingCents - amountCents);
    await put('cashBatches', batch);
}

/** Restore an amount to a cash batch's remaining balance (on expense delete/update). */
async function restoreCashBatchBalance(expense) {
    if (!expense.cashBatchId || expense.method !== 'cash') return;
    const batch = await get('cashBatches', expense.cashBatchId);
    if (!batch) return;
    if (batch.remainingCents === undefined) {
        batch.remainingCents = batch.purchasedAmountCents;
    }
    batch.remainingCents = Math.min(
        batch.purchasedAmountCents,
        batch.remainingCents + expense.amountLocalCents
    );
    await put('cashBatches', batch);
}

async function deleteCashBatch(batchId) {
    // Check ALL expenses across ALL trips, not just the current one
    const allExpenses = await getAll('expenses');
    const used = allExpenses.some(e => e.cashBatchId === batchId);
    if (used) return false;
    await del('cashBatches', batchId);
    return true;
}

// ---------- Expenses ----------
async function addExpense({ date, currency, method, categoryId, description, amountLocal, photoFile }) {
    const settings = await loadSettings();
    const amountLocalCents = toCents(amountLocal);
    currency = currency.toUpperCase();

    let baseAmountCents = 0;
    let cashBatchId = null;
    let fxRatePpm = null;
    let fxSource = 'frankfurter';

    if (method === 'cash') {
        if (currency === (settings.homeCurrency || '').toUpperCase()) {
            fxRatePpm = PPM;
            fxSource = 'identity';
            baseAmountCents = amountLocalCents;
            cashBatchId = null;
        } else {
            const batch = await pickCashBatchFor(date, currency);
            if (!batch) throw new Error(`No cash batch found for ${currency} on or before ${utcDateToLocal(date)} with sufficient balance. Add a cash batch first.`);
            const remaining = batch.remainingCents ?? batch.purchasedAmountCents;
            if (remaining < amountLocalCents) {
                throw new Error(`Insufficient cash batch balance for ${currency}. Needed: ${fromCents(amountLocalCents)}, available: ${fromCents(remaining)}. Add more cash or use a different batch.`);
            }
            cashBatchId = batch.id;
            fxRatePpm = batch.ratePpm;
            fxSource = 'cashBatch';
            baseAmountCents = Math.round(amountLocalCents * batch.ratePpm / PPM);
            // Deduct from the batch
            await deductCashBatch(batch.id, amountLocalCents);
        }
    } else {
        let result = await getOrFetchRate(date, currency);
        if (!result) {
            if (!navigator.onLine) {
                fxRatePpm = null;
                fxSource = 'pending';
                baseAmountCents = null;
            } else {
                const fetched = await fetchAndCacheRate(date, currency);
                if (fetched) result = fetched;
                else {
                    const fxRow = await getFxRowAtOrBefore(date);
                    if (fxRow && fxRow.rates[currency]) result = { ppm: fxRow.rates[currency], source: 'frankfurter' };
                }
                if (!result) {
                    throw new Error(`Unable to fetch FX rate for ${currency} on ${utcDateToLocal(date)}. Check your internet connection and try again.`);
                }
            }
        }
        if (result) {
            fxRatePpm = result.ppm;
            fxSource = result.source;
            const eff = (fxSource === 'identity')
                ? fxRatePpm
                : applyFeePpm(fxRatePpm, settings.ccFeePercent ?? 2.5);
            baseAmountCents = Math.round(amountLocalCents * eff / PPM);
        }
    }

    const expenseId = crypto.randomUUID();
    await put('expenses', {
        id: expenseId,
        tripId: getActiveTripId(),
        date, currency, method, categoryId, description,
        amountLocalCents, baseAmountCents,
        fxRatePpm, fxSource, cashBatchId
    });

    if (photoFile) {
        try {
            const dataUrl = await readAndResizePhoto(photoFile);
            await savePhoto(expenseId, dataUrl);
        } catch { /* non-fatal */ }
    }

    return expenseId;
}

async function updateExpense(id, { date, currency, method, categoryId, description, amountLocal, photoFile, removePhoto }) {
    const exp = await get('expenses', id);
    if (!exp) throw new Error('Expense not found.');

    // Restore old cash batch balance before recalculating
    await restoreCashBatchBalance(exp);

    exp.date = date;
    exp.currency = currency.toUpperCase();
    exp.method = method;
    exp.categoryId = categoryId;
    exp.description = description;
    exp.amountLocalCents = toCents(amountLocal);

    const settings = await loadSettings();
    let baseAmountCents = null;
    let cashBatchId = null;
    let fxRatePpm = null;
    let fxSource = 'frankfurter';

    if (method === 'cash') {
        if (exp.currency === (settings.homeCurrency || '').toUpperCase()) {
            fxRatePpm = PPM;
            fxSource = 'identity';
            baseAmountCents = exp.amountLocalCents;
            cashBatchId = null;
        } else {
            const batch = await pickCashBatchFor(date, exp.currency);
            if (!batch) throw new Error(`No cash batch found for ${exp.currency} on or before ${utcDateToLocal(date)} with sufficient balance. Add a cash batch first.`);
            const remaining = batch.remainingCents ?? batch.purchasedAmountCents;
            if (remaining < exp.amountLocalCents) {
                throw new Error(`Insufficient cash batch balance for ${exp.currency}. Needed: ${fromCents(exp.amountLocalCents)}, available: ${fromCents(remaining)}.`);
            }
            cashBatchId = batch.id;
            fxRatePpm = batch.ratePpm;
            fxSource = 'cashBatch';
            baseAmountCents = Math.round(exp.amountLocalCents * batch.ratePpm / PPM);
            // Deduct from the batch
            await deductCashBatch(batch.id, exp.amountLocalCents);
        }
    } else {
        let result = await getOrFetchRate(date, exp.currency);
        if (!result) {
            if (!navigator.onLine) {
                fxRatePpm = null;
                fxSource = 'pending';
                baseAmountCents = null;
            } else {
                const fetched = await fetchAndCacheRate(date, exp.currency);
                if (fetched) result = fetched;
                else {
                    const fxRow = await getFxRowAtOrBefore(date);
                    if (fxRow && fxRow.rates[exp.currency]) result = { ppm: fxRow.rates[exp.currency], source: 'frankfurter' };
                }
                if (!result) throw new Error(`Unable to fetch FX rate for ${exp.currency} on ${utcDateToLocal(date)}.`);
            }
        }
        if (result) {
            fxRatePpm = result.ppm;
            fxSource = result.source;
            const eff = (fxSource === 'identity')
                ? fxRatePpm
                : applyFeePpm(fxRatePpm, settings.ccFeePercent ?? 2.5);
            baseAmountCents = Math.round(exp.amountLocalCents * eff / PPM);
        }
    }

    exp.baseAmountCents = baseAmountCents;
    exp.fxRatePpm = fxRatePpm;
    exp.fxSource = fxSource;
    exp.cashBatchId = cashBatchId;
    await put('expenses', exp);

    if (removePhoto) await deletePhoto(id);
    if (photoFile) {
        try {
            const dataUrl = await readAndResizePhoto(photoFile);
            await savePhoto(id, dataUrl);
        } catch { /* non-fatal */ }
    }
}

async function deleteExpense(id) {
    const exp = await get('expenses', id);
    if (exp) {
        // Restore cash batch remaining balance
        await restoreCashBatchBalance(exp);
    }
    await deletePhoto(id);
    await del('expenses', id);
}

// ---------- Queries & conversions ----------
async function getExpensesInRange(startDate, endDate) {
    const tripId = getActiveTripId();
    const allForTrip = await indexGetAllKey('expenses', 'byTrip', tripId);
    if (!startDate && !endDate) return allForTrip;
    return allForTrip.filter(e => {
        if (startDate && e.date < startDate) return false;
        if (endDate && e.date > endDate) return false;
        return true;
    });
}

async function sumBaseCents(expenses) {
    return expenses.reduce((acc, e) => acc + (e.baseAmountCents || 0), 0);
}

async function convertBaseToTargetCents(baseCents, targetCurrency, endDate) {
    const settings = await loadSettings();
    const home = settings.homeCurrency.toUpperCase();
    targetCurrency = targetCurrency.toUpperCase();
    if (targetCurrency === home) return baseCents;
    const result = await getOrFetchRate(endDate || todayUTC(), targetCurrency);
    if (!result) throw new Error(`Unable to fetch FX rate for ${targetCurrency}. Check your internet connection.`);
    const homeToTargetPpm = Math.round(PPM / (result.ppm / PPM));
    return Math.round(baseCents * homeToTargetPpm / PPM);
}

// ---------- Category management ----------
async function listCategories() {
    return await indexGetAllKey('categories', 'byTrip', getActiveTripId());
}

async function countExpensesByCategoryAll() {
    const exps = await indexGetAllKey('expenses', 'byTrip', getActiveTripId());
    const map = new Map();
    for (const e of exps) map.set(e.categoryId, (map.get(e.categoryId) || 0) + 1);
    return map;
}

async function renameCategory(id, newName) {
    newName = newName.trim();
    if (!newName) throw new Error('Name required');
    const cats = await listCategories();
    if (cats.some(c => c.name.toLowerCase() === newName.toLowerCase() && c.id !== id)) throw new Error('A category with that name already exists.');
    const cat = cats.find(c => c.id === id);
    if (!cat) throw new Error('Category not found');
    cat.name = newName;
    await put('categories', cat);
}

async function reassignCategory(oldId, newId) {
    if (oldId === newId) return;
    const affected = await indexGetAllKey('expenses', 'byCategory', oldId);
    for (const e of affected) { e.categoryId = newId; await put('expenses', e); }
}

async function deleteCategoryIfUnused(id) {
    const used = await indexGetAllKey('expenses', 'byCategory', id);
    if (used.length > 0) return false;
    await del('categories', id);
    return true;
}

// ---------- UI state & rendering ----------
function formatRate(fxRatePpm) {
    if (!fxRatePpm) return '—';
    return (fxRatePpm / PPM).toFixed(4);
}

function fxSourceLabel(source) {
    switch (source) {
        case 'frankfurter': return '🌐';
        case 'cashBatch': return '💵';
        case 'pending': return '⏳';
        default: return '🌐';
    }
}

// ---------- Lightbox ----------
function openLightbox(dataUrl) {
    const overlay = document.getElementById('photoLightbox');
    document.getElementById('lightboxImg').src = dataUrl;
    overlay.hidden = false;
}

function closeLightbox() {
    document.getElementById('photoLightbox').hidden = true;
    document.getElementById('lightboxImg').src = '';
}

async function renderTripSelector() {
    const trips = await listTrips();
    const selector = $('#tripSelector');
    selector.innerHTML = trips
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(t => `<option value="${t.id}"${t.id === activeTripId ? ' selected' : ''}>${t.name}</option>`)
        .join('');
    const current = trips.find(t => t.id === activeTripId);
    if (current) document.title = `${current.name} — Trip Expense Tracker`;
}

async function renderLiveRates() {
    const container = document.getElementById('fxRatesChips');
    const bar = document.getElementById('fxRatesBar');
    if (!container || !bar) return;
    try {
        const settings = await loadSettings();
        const home = settings.homeCurrency.toUpperCase();
        const foreign = (settings.tripCurrencies || []).filter(c => c.toUpperCase() !== home);
        if (!foreign.length) {
            bar.hidden = true;
            return;
        }
        bar.hidden = false;
        const chips = [];
        for (const cur of foreign) {
            const result = await getOrFetchRate(todayUTC(), cur);
            if (result) {
                const rate = (result.ppm / PPM).toFixed(4);
                chips.push(`<span class="rate-chip">1 ${cur} = <span class="rate-value">${rate}</span> ${home}</span>`);
            } else {
                chips.push(`<span class="rate-chip" style="opacity:.5">1 ${cur} = <span class="rate-value">—</span> ${home}</span>`);
            }
        }
        container.innerHTML = chips.join('');
    } catch {
        container.innerHTML = '<span class="muted">Unable to load rates</span>';
    }
}

async function render() {
    await renderTripSelector();
    const settings = await loadSettings();

    $('#homeCurrency').value = settings.homeCurrency;
    $('#tripCurrencies').value = settings.tripCurrencies.join(', ');
    $('#ccFee').value = settings.ccFeePercent;

    const tripCurrencies = settings.tripCurrencies && settings.tripCurrencies.length ? settings.tripCurrencies : [settings.homeCurrency];
    const allDisplayCurrencies = Array.from(new Set([settings.homeCurrency, ...tripCurrencies]));

    const currencyEl = document.getElementById('currency');
    const prevCurrency = currencyEl.value;
    currencyEl.innerHTML = allDisplayCurrencies.map(c => `<option value="${c}">${c}</option>`).join('');
    currencyEl.value = allDisplayCurrencies.includes(prevCurrency) ? prevCurrency : allDisplayCurrencies[0];

    const cats = await listCategories();
    const sel = $('#category');
    sel.innerHTML = cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('');

    const cashCurrencyEl = document.getElementById('cashCurrency');
    const prevCash = cashCurrencyEl.value;
    cashCurrencyEl.innerHTML = allDisplayCurrencies.map(c => `<option value="${c}">${c}</option>`).join('');
    cashCurrencyEl.value = allDisplayCurrencies.includes(prevCash) ? prevCash : allDisplayCurrencies[0];

    // Cash batches are GLOBAL — show all batches from all trips with remaining balance
    const allBatches = await listAllCashBatches();
    const trips = await listTrips();
    const tripMap = new Map(trips.map(t => [t.id, t.name]));

    $('#cashBatchesList').innerHTML = allBatches
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map(b => {
            const remaining = b.remainingCents ?? b.purchasedAmountCents;
            const purchased = b.purchasedAmountCents;
            const pctUsed = purchased > 0 ? Math.round((1 - remaining / purchased) * 100) : 0;
            const tripName = tripMap.get(b.tripId) || '(deleted trip)';
            const balanceClass = remaining <= 0 ? 'style="opacity:.5;"' : '';
            return `<li data-id="${b.id}" ${balanceClass}>${utcDateToLocal(b.date)} • ${b.currency} • rate ${(b.ratePpm / PPM).toFixed(4)} • ${fromCents(purchased)} purchased • <strong>${fromCents(remaining)} remaining</strong> (${pctUsed}% used) • <em class="muted">${tripName}</em> <span class="actions"><button class="editCashBtn" type="button">Edit</button> <button class="deleteCashBtn" type="button">Delete</button></span></li>`;
        })
        .join('');

    const summaryEl = document.getElementById('summaryCurrency');
    const prevSummary = summaryEl.value;
    summaryEl.innerHTML = allDisplayCurrencies.map(c => `<option value="${c}">${c}</option>`).join('');
    summaryEl.value = allDisplayCurrencies.includes(prevSummary) ? prevSummary : settings.homeCurrency;

    // Filter inputs are local dates; convert to UTC for DB comparison
    const startDateLocal = $('#startDate').value || null;
    const endDateLocal = $('#endDate').value || null;
    const startDate = localDateToUTC(startDateLocal);
    const endDate = localDateToUTC(endDateLocal);
    const displayCurrency = (summaryEl.value || settings.homeCurrency).toUpperCase();

    const exps = (await getExpensesInRange(startDate, endDate))
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    const catMap = new Map(cats.map(c => [c.id, c.name]));

    // Batch-load photos for visible expenses
    const photoMap = new Map();
    for (const e of exps) {
        const p = await getPhoto(e.id);
        if (p) photoMap.set(e.id, p.dataUrl);
    }

    $('#expensesTbody').innerHTML = exps.length
        ? exps.map(e => {
            const catName = catMap.get(e.categoryId) || '—';
            const rateDisplay = formatRate(e.fxRatePpm);
            const sourceIcon = fxSourceLabel(e.fxSource);
            const baseDisplay = (e.baseAmountCents == null)
                ? `<span class="muted">pending</span>`
                : `${(e.baseAmountCents / 100).toFixed(2)} ${settings.homeCurrency}`;
            const photoUrl = photoMap.get(e.id);
            const photoCell = photoUrl
                ? `<img class="expense-thumb" src="${photoUrl}" alt="Receipt" data-photo-id="${e.id}" />`
                : `<span class="muted">—</span>`;
            return `<tr data-expense-id="${e.id}">
                <td>${utcDateToLocal(e.date)}</td>
                <td>${catName}</td>
                <td>${e.method.toUpperCase()}</td>
                <td>${e.currency} ${(e.amountLocalCents / 100).toFixed(2)}</td>
                <td><span title="${e.fxSource || 'frankfurter'}">${sourceIcon}</span> ${rateDisplay}</td>
                <td>${baseDisplay}</td>
                <td>${e.description || ''}</td>
                <td>${photoCell}</td>
                <td class="actions"><button class="editExpenseBtn" type="button">Edit</button> <button class="deleteExpenseBtn" type="button">Delete</button></td>
            </tr>`;
        }).join('')
        : `<tr><td colspan="9" class="muted">No expenses in this range.</td></tr>`;

    try {
        const totalBase = await sumBaseCents(exps);
        const totalDisplay = await convertBaseToTargetCents(totalBase, displayCurrency, endDate);
        $('#summaryOutput').textContent = `${displayCurrency} ${(totalDisplay / 100).toFixed(2)}`;
    } catch (err) {
        $('#summaryOutput').textContent = err.message;
    }

    await renderCategorySummary(exps, cats, displayCurrency, endDate, settings.homeCurrency);
    await renderCategoryManagement(cats);
    await renderLiveRates();
}

// ---------- Inline expense editor helper ----------
function createSelectHtml(options, selectedValue, valueAttr = 'value') {
    return options.map(opt => {
        const value = opt[valueAttr] ?? opt;
        const label = opt.name ?? opt;
        return `<option value="${String(value)}"${String(value) === String(selectedValue) ? ' selected' : ''}>${label}</option>`;
    }).join('');
}

async function renderCategorySummary(expenses, categories, displayCurrency, endDate, homeCurrency) {
    const catMap = new Map(categories.map(c => [c.id, c.name]));
    const aggregates = new Map();
    for (const e of expenses) {
        const agg = aggregates.get(e.categoryId) || { count: 0, baseCents: 0 };
        agg.count += 1;
        agg.baseCents += (e.baseAmountCents || 0);
        aggregates.set(e.categoryId, agg);
    }

    let rowsHtml = '';
    let grandBase = 0, grandCount = 0;
    for (const [catId, { count, baseCents }] of aggregates) {
        const name = catMap.get(catId) || '(Unknown)';
        const displayCents = await convertBaseToTargetCents(baseCents, displayCurrency, endDate);
        rowsHtml += `<tr><td>${name}</td><td>${count}</td><td>${displayCurrency} ${(displayCents / 100).toFixed(2)}</td></tr>`;
        grandBase += baseCents;
        grandCount += count;
    }
    document.getElementById('categorySummaryBody').innerHTML = rowsHtml || `<tr><td colspan="3" class="muted">No expenses in this range.</td></tr>`;
    document.getElementById('catTotalCount').textContent = String(grandCount);
    try {
        const grandDisplayCents = await convertBaseToTargetCents(grandBase, displayCurrency, endDate);
        document.getElementById('catGrandTotal').textContent = `${displayCurrency} ${(grandDisplayCents / 100).toFixed(2)}`;
    } catch (err) {
        document.getElementById('catGrandTotal').textContent = err.message;
    }
}

async function renderCategoryManagement(categories) {
    const usage = await countExpensesByCategoryAll();
    const tbody = document.getElementById('categoriesTbody');
    if (!categories.length) { tbody.innerHTML = '<tr><td colspan="3" class="muted">No categories yet.</td></tr>'; return; }
    tbody.innerHTML = categories.map(c => {
        const count = usage.get(c.id) || 0;
        const usedBadge = count > 0 ? `<span class=badge>used: ${count}</span>` : '<span class=badge style="background:#efe;color:#141">unused</span>';
        return `<tr data-id="${c.id}"><td>${c.name}</td><td>${usedBadge}</td><td class="actions">
      <button class="renameBtn" type="button">Rename</button>
      <button class="deleteBtn" type="button">Delete</button>
    </td></tr>`;
    }).join('');
}

// ---------- Backup & Restore ----------
async function exportBackup() {
    try {
        const stores = ['trips', 'settings', 'categories', 'cashBatches', 'fxRates', 'expenses', 'photos'];
        const payload = { meta: { exportedAt: new Date().toISOString() }, stores: {} };
        for (const s of stores) payload.stores[s] = await getAll(s);
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tripx-backup-${todayLocal()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        alert('Export failed: ' + (err.message || err));
    }
}

async function importBackupFile(file) {
    if (!file) throw new Error('No file selected.');
    const text = await file.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('Invalid JSON file.'); }
    if (!parsed || typeof parsed !== 'object' || !parsed.stores) throw new Error('Backup format not recognized.');

    const wipe = confirm('Import: Do you want to wipe existing data and replace it with the backup? Click Cancel to merge (existing records will be kept, incoming records will overwrite by id).');

    const storeNames = Object.keys(parsed.stores);
    for (const s of storeNames) {
        if (!Array.isArray(parsed.stores[s])) throw new Error(`Backup store "${s}" is not an array.`);
    }

    const keyFor = (store, item) => {
        if (!item || typeof item !== 'object') return null;
        if (item.id != null) return item.id;
        if (item.expenseId != null) return item.expenseId;
        if (item.date != null) return item.date;
        if (item.key != null) return item.key;
        return null;
    };

    // Stores that must always be wiped in wipe-mode, even if absent from the backup.
    const alwaysWipeStores = ['photos'];

    try {
        if (wipe) {
            for (const s of storeNames) {
                const existing = await getAll(s);
                for (const item of existing) {
                    const key = keyFor(s, item);
                    if (key != null) await del(s, key);
                }
            }
            for (const s of alwaysWipeStores) {
                if (storeNames.includes(s)) continue;
                try {
                    const existing = await getAll(s);
                    for (const item of existing) {
                        const key = keyFor(s, item);
                        if (key != null) await del(s, key);
                    }
                } catch { /* store may not exist in older DB versions */ }
            }
        }

        for (const s of storeNames) {
            for (const it of parsed.stores[s]) await put(s, it);
        }

        // Migrate imported cashBatches: compute remainingCents from expense data
        if (parsed.stores['cashBatches']?.length) {
            const importedExpenses = parsed.stores['expenses'] || [];
            const usageMap = new Map();
            for (const e of importedExpenses) {
                if (e.cashBatchId && e.method === 'cash') {
                    usageMap.set(
                        e.cashBatchId,
                        (usageMap.get(e.cashBatchId) || 0) + (e.amountLocalCents || 0)
                    );
                }
            }
            for (const batch of parsed.stores['cashBatches']) {
                if (batch.remainingCents === undefined) {
                    const spent = usageMap.get(batch.id) || 0;
                    batch.remainingCents = Math.max(0, batch.purchasedAmountCents - spent);
                    await put('cashBatches', batch);
                }
            }
        }

        const importedTrips = parsed.stores['trips'] || [];
        if (importedTrips.length) {
            const trips = await listTrips();
            if (!trips.some(t => t.id === activeTripId)) {
                activeTripId = importedTrips[0].id;
                localStorage.setItem('activeTrip', activeTripId);
            }
        }
        await render();
        alert('Import complete ✓');
    } catch (err) {
        throw new Error('Import failed: ' + (err.message || err));
    }
}

// ---------- Sync pending offline expenses ----------
async function syncPendingExpenses() {
    try {
        const tripId = getActiveTripId();
        const all = await indexGetAllKey('expenses', 'byTrip', tripId);
        const pending = all.filter(e => e.method !== 'cash' && (!e.fxRatePpm || e.fxSource === 'pending' || e.baseAmountCents == null));
        if (!pending.length) return;
        for (const e of pending) {
            try {
                const result = await getOrFetchRate(e.date, e.currency);
                if (!result) continue;
                const settings = await loadSettings();
                const eff = (result.source === 'identity')
                    ? result.ppm
                    : applyFeePpm(result.ppm, settings.ccFeePercent ?? 2.5);
                e.fxRatePpm = result.ppm;
                e.fxSource = result.source;
                e.baseAmountCents = Math.round(e.amountLocalCents * eff / PPM);
                await put('expenses', e);
            } catch { /* ignore per-expense */ }
        }
        await render();
    } catch { /* top-level ignore */ }
}

// ---------- Toast notifications ----------
function showToast(message, type = 'success', duration = 2500) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'toast ' + type + ' show';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.className = 'toast'; }, duration);
}

// ---------- Online/offline indicator ----------
function updateOnlineStatus() {
    const badge = document.getElementById('onlineStatus');
    if (navigator.onLine) {
        badge.textContent = '● Online';
        badge.className = 'status-badge online';
    } else {
        badge.textContent = '● Offline';
        badge.className = 'status-badge offline';
    }
}

// ---------- OCR UI helper ----------
function setOcrStatus(state, text) {
    const el = document.getElementById('ocrStatus');
    const textEl = document.getElementById('ocrStatusText');
    el.hidden = state === 'hidden';
    el.className = 'ocr-status' + (state === 'done' ? ' done' : state === 'error' ? ' error' : '');
    if (text) textEl.textContent = text;
}

// ---------- Excel Export ----------
async function exportToExcel() {
    if (typeof XLSX === 'undefined') {
        alert('Excel library (SheetJS) not loaded. Check your internet connection.');
        return;
    }

    try {
        const settings = await loadSettings();
        const trips = await listTrips();
        const currentTrip = trips.find(t => t.id === activeTripId);
        const tripName = currentTrip?.name || 'Trip';
        const cats = await listCategories();
        const catMap = new Map(cats.map(c => [c.id, c.name]));

        // Respect current filters
        const startDateLocal = $('#startDate').value || null;
        const endDateLocal = $('#endDate').value || null;
        const startDate = localDateToUTC(startDateLocal);
        const endDate = localDateToUTC(endDateLocal);
        const displayCurrency = ($('#summaryCurrency').value || settings.homeCurrency).toUpperCase();

        const expenses = (await getExpensesInRange(startDate, endDate))
            .sort((a, b) => new Date(a.date) - new Date(b.date));

        if (!expenses.length) {
            alert('No expenses to export for the selected date range.');
            return;
        }

        const wb = XLSX.utils.book_new();

        // ── Sheet 1: All Expenses ──
        const expRows = expenses.map(e => ({
            'Date': utcDateToLocal(e.date),
            'Category': catMap.get(e.categoryId) || '(Unknown)',
            'Method': e.method.toUpperCase(),
            'Currency': e.currency,
            'Local Amount': e.amountLocalCents / 100,
            'FX Rate': e.fxRatePpm ? e.fxRatePpm / PPM : null,
            'FX Source': e.fxSource || '',
            [`Home Amount (${settings.homeCurrency})`]: e.baseAmountCents != null ? e.baseAmountCents / 100 : null,
            'Description': e.description || ''
        }));

        const wsExpenses = XLSX.utils.json_to_sheet(expRows);

        wsExpenses['!cols'] = [
            { wch: 12 }, { wch: 16 }, { wch: 10 }, { wch: 10 },
            { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 30 },
        ];

        const numRows = expRows.length;
        for (let r = 1; r <= numRows; r++) {
            const localCell = wsExpenses[XLSX.utils.encode_cell({ r, c: 4 })];
            if (localCell) localCell.z = '#,##0.00';
            const rateCell = wsExpenses[XLSX.utils.encode_cell({ r, c: 5 })];
            if (rateCell) rateCell.z = '0.0000';
            const homeCell = wsExpenses[XLSX.utils.encode_cell({ r, c: 7 })];
            if (homeCell) homeCell.z = '#,##0.00';
        }

        XLSX.utils.book_append_sheet(wb, wsExpenses, 'Expenses');

        // ── Sheet 2: Category Summary ──
        const catAgg = new Map();
        for (const e of expenses) {
            const agg = catAgg.get(e.categoryId) || { name: catMap.get(e.categoryId) || '(Unknown)', count: 0, baseCents: 0 };
            agg.count += 1;
            agg.baseCents += (e.baseAmountCents || 0);
            catAgg.set(e.categoryId, agg);
        }

        const catRows = [];
        let grandTotal = 0;
        for (const [, { name, count, baseCents }] of catAgg) {
            const displayCents = await convertBaseToTargetCents(baseCents, displayCurrency, endDate);
            catRows.push({
                'Category': name,
                'Count': count,
                [`Total (${displayCurrency})`]: displayCents / 100
            });
            grandTotal += displayCents;
        }
        catRows.sort((a, b) => b[`Total (${displayCurrency})`] - a[`Total (${displayCurrency})`]);
        catRows.push({
            'Category': 'GRAND TOTAL',
            'Count': expenses.length,
            [`Total (${displayCurrency})`]: grandTotal / 100
        });

        const wsCatSummary = XLSX.utils.json_to_sheet(catRows);
        wsCatSummary['!cols'] = [{ wch: 20 }, { wch: 8 }, { wch: 18 }];
        for (let r = 1; r <= catRows.length; r++) {
            const cell = wsCatSummary[XLSX.utils.encode_cell({ r, c: 2 })];
            if (cell) cell.z = '#,##0.00';
        }
        XLSX.utils.book_append_sheet(wb, wsCatSummary, 'By Category');

        // ── Sheet 3: Daily Summary ──
        const dailyMap = new Map();
        for (const e of expenses) {
            const day = utcDateToLocal(e.date);
            const agg = dailyMap.get(day) || { count: 0, baseCents: 0 };
            agg.count += 1;
            agg.baseCents += (e.baseAmountCents || 0);
            dailyMap.set(day, agg);
        }
        const dailyRows = [];
        for (const [day, { count, baseCents }] of [...dailyMap.entries()].sort()) {
            const displayCents = await convertBaseToTargetCents(baseCents, displayCurrency, endDate);
            dailyRows.push({
                'Date': day,
                'Count': count,
                [`Total (${displayCurrency})`]: displayCents / 100
            });
        }
        const wsDaily = XLSX.utils.json_to_sheet(dailyRows);
        wsDaily['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 18 }];
        for (let r = 1; r <= dailyRows.length; r++) {
            const cell = wsDaily[XLSX.utils.encode_cell({ r, c: 2 })];
            if (cell) cell.z = '#,##0.00';
        }
        XLSX.utils.book_append_sheet(wb, wsDaily, 'Daily Summary');

        // ── Sheet 4: Payment Method Summary ──
        const methodMap = new Map();
        for (const e of expenses) {
            const m = e.method.toUpperCase();
            const agg = methodMap.get(m) || { count: 0, baseCents: 0 };
            agg.count += 1;
            agg.baseCents += (e.baseAmountCents || 0);
            methodMap.set(m, agg);
        }
        const methodRows = [];
        for (const [method, { count, baseCents }] of methodMap) {
            const displayCents = await convertBaseToTargetCents(baseCents, displayCurrency, endDate);
            methodRows.push({
                'Method': method,
                'Count': count,
                [`Total (${displayCurrency})`]: displayCents / 100
            });
        }
        const wsMethod = XLSX.utils.json_to_sheet(methodRows);
        wsMethod['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 18 }];
        for (let r = 1; r <= methodRows.length; r++) {
            const cell = wsMethod[XLSX.utils.encode_cell({ r, c: 2 })];
            if (cell) cell.z = '#,##0.00';
        }
        XLSX.utils.book_append_sheet(wb, wsMethod, 'By Method');

        // ── Sheet 5: Currency Summary ──
        const curMap = new Map();
        for (const e of expenses) {
            const agg = curMap.get(e.currency) || { count: 0, localCents: 0, baseCents: 0 };
            agg.count += 1;
            agg.localCents += (e.amountLocalCents || 0);
            agg.baseCents += (e.baseAmountCents || 0);
            curMap.set(e.currency, agg);
        }
        const curRows = [];
        for (const [currency, { count, localCents, baseCents }] of curMap) {
            const displayCents = await convertBaseToTargetCents(baseCents, displayCurrency, endDate);
            curRows.push({
                'Currency': currency,
                'Count': count,
                'Local Total': localCents / 100,
                [`Home Total (${displayCurrency})`]: displayCents / 100
            });
        }
        const wsCurrency = XLSX.utils.json_to_sheet(curRows);
        wsCurrency['!cols'] = [{ wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 18 }];
        for (let r = 1; r <= curRows.length; r++) {
            const localCell = wsCurrency[XLSX.utils.encode_cell({ r, c: 2 })];
            if (localCell) localCell.z = '#,##0.00';
            const homeCell = wsCurrency[XLSX.utils.encode_cell({ r, c: 3 })];
            if (homeCell) homeCell.z = '#,##0.00';
        }
        XLSX.utils.book_append_sheet(wb, wsCurrency, 'By Currency');

        // ── Sheet 6: Trip Info ──
        const totalBaseCents = await sumBaseCents(expenses);
        const totalDisplayCents = await convertBaseToTargetCents(totalBaseCents, displayCurrency, endDate);
        const infoData = [
            ['Trip Name', tripName],
            ['Home Currency', settings.homeCurrency],
            ['Trip Currencies', (settings.tripCurrencies || []).join(', ')],
            ['CC Fee %', settings.ccFeePercent],
            ['Display Currency', displayCurrency],
            ['Date Range', `${startDateLocal || '(all)'} — ${endDateLocal || '(all)'}`],
            ['Total Expenses', expenses.length],
            ['Grand Total', totalDisplayCents / 100],
            ['Exported At', new Date().toLocaleString()],
        ];
        const wsInfo = XLSX.utils.aoa_to_sheet(infoData);
        wsInfo['!cols'] = [{ wch: 18 }, { wch: 30 }];
        const totalCell = wsInfo[XLSX.utils.encode_cell({ r: 7, c: 1 })];
        if (totalCell) totalCell.z = '#,##0.00';
        XLSX.utils.book_append_sheet(wb, wsInfo, 'Trip Info');

        // ── Download ──
        const safeTrip = tripName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
        const filename = `${safeTrip}-expenses-${todayLocal()}.xlsx`;
        XLSX.writeFile(wb, filename);
        showToast('Excel exported ✓');
    } catch (err) {
        alert('Excel export failed: ' + (err.message || err));
    }
}

// ---------- Event handlers ----------
document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    await ensureDefaults();

    document.getElementById('date').value = todayLocal();

    // --- Photo preview + OCR on the Add Expense form ---
    document.getElementById('expensePhoto').addEventListener('change', async (e) => {
        const preview = document.getElementById('photoPreview');
        const file = e.target.files && e.target.files[0];
        if (!file) { preview.innerHTML = ''; setOcrStatus('hidden'); return; }
        try {
            const dataUrl = await readAndResizePhoto(file);
            preview.innerHTML = `<img src="${dataUrl}" alt="Preview" title="Click to enlarge" /><button type="button" class="remove-photo" title="Remove photo">✕</button>`;
            preview.querySelector('img').addEventListener('click', () => openLightbox(dataUrl));
            preview.querySelector('.remove-photo').addEventListener('click', () => {
                document.getElementById('expensePhoto').value = '';
                preview.innerHTML = '';
                setOcrStatus('hidden');
            });
        } catch {
            preview.innerHTML = '<span class="muted">Preview failed</span>';
        }

        // Run OCR in background
        if (typeof Tesseract !== 'undefined') {
            try {
                setOcrStatus('scanning', 'Scanning receipt…');
                const settings = await loadSettings();
                const langs = getOcrLangs(settings.tripCurrencies, settings.homeCurrency);
                const ocrText = await runOcr(file, langs);
                const parsed = parseReceipt(ocrText);

                let filled = [];
                if (parsed.date) {
                    document.getElementById('date').value = parsed.date;
                    filled.push('date');
                }
                if (parsed.total) {
                    document.getElementById('amount').value = parsed.total.toFixed(2);
                    filled.push('amount');
                }
                if (parsed.storeName) {
                    const descEl = document.getElementById('description');
                    if (!descEl.value.trim()) {
                        descEl.value = parsed.storeName;
                        filled.push('store name');
                    }
                }

                if (filled.length) {
                    setOcrStatus('done', `✓ Auto-filled ${filled.join(' & ')} — please verify`);
                    showToast(`OCR filled ${filled.join(' & ')}`, 'success', 3000);
                } else {
                    setOcrStatus('error', 'No date or amount detected — fill in manually');
                }
            } catch {
                setOcrStatus('error', 'OCR failed — fill in manually');
            }
        }
    });

    // --- Lightbox ---
    document.getElementById('expensesTbody').addEventListener('click', (e) => {
        if (e.target.classList.contains('expense-thumb')) {
            openLightbox(e.target.src);
        }
    });
    document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
    document.getElementById('photoLightbox').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeLightbox();
    });

    // --- Trip management events ---
    $('#tripSelector').addEventListener('change', async () => {
        activeTripId = $('#tripSelector').value;
        localStorage.setItem('activeTrip', activeTripId);
        const settings = await loadSettings();
        const tripCurrencies = settings.tripCurrencies.length ? settings.tripCurrencies : [settings.homeCurrency];
        document.getElementById('currency').value = tripCurrencies[0];
        document.getElementById('cashCurrency').value = tripCurrencies[0];
        document.getElementById('summaryCurrency').value = settings.homeCurrency;
        await render();
    });

    $('#newTripBtn').addEventListener('click', async () => {
        const name = prompt('New trip name:');
        if (!name || !name.trim()) return;
        try {
            const trip = await createTrip(name);
            activeTripId = trip.id;
            localStorage.setItem('activeTrip', activeTripId);
            const settings = await loadSettings();
            document.getElementById('currency').value = settings.tripCurrencies[0];
            document.getElementById('cashCurrency').value = settings.tripCurrencies[0];
            document.getElementById('summaryCurrency').value = settings.homeCurrency;
            await render();
        } catch (err) { alert(err.message); }
    });

    $('#renameTripBtn').addEventListener('click', async () => {
        const trips = await listTrips();
        const current = trips.find(t => t.id === activeTripId);
        const newName = prompt('Rename trip:', current?.name || '');
        if (!newName || !newName.trim()) return;
        try { await renameTrip(activeTripId, newName); await render(); } catch (err) { alert(err.message); }
    });

    $('#deleteTripBtn').addEventListener('click', async () => {
        const trips = await listTrips();
        if (trips.length <= 1) { alert('You must have at least one trip.'); return; }
        const current = trips.find(t => t.id === activeTripId);
        if (!confirm(`Delete trip "${current?.name}" and ALL its expenses and categories? Cash batches are shared and will be kept. This cannot be undone.`)) return;
        await deleteTrip(activeTripId);
        const remaining = await listTrips();
        activeTripId = remaining[0].id;
        localStorage.setItem('activeTrip', activeTripId);
        const settings = await loadSettings();
        document.getElementById('currency').value = settings.tripCurrencies[0];
        document.getElementById('cashCurrency').value = settings.tripCurrencies[0];
        document.getElementById('summaryCurrency').value = settings.homeCurrency;
        await render();
    });

    // Settings form
    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const rawTrips = document.getElementById('tripCurrencies').value || '';
        const tripCurrencies = Array.from(new Set(
            rawTrips.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
        ));
        await put('settings', {
            id: settingsKey(),
            homeCurrency: document.getElementById('homeCurrency').value.trim().toUpperCase(),
            tripCurrencies,
            ccFeePercent: Number(document.getElementById('ccFee').value)
        });
        showToast('Settings saved ✓');
        await render();
    });

    // Category add
    document.getElementById('addCategory').addEventListener('click', async () => {
        const nameInput = document.getElementById('newCategoryName');
        const name = (nameInput.value || '').trim();
        if (!name) { alert('Enter a category name.'); return; }
        const cats = await listCategories();
        if (cats.some(c => c.name.toLowerCase() === name.toLowerCase())) { alert('A category with that name already exists.'); return; }
        await put('categories', { id: crypto.randomUUID(), name, tripId: getActiveTripId() });
        nameInput.value = '';
        await render();
    });

    // Category management actions (event delegation)
    document.getElementById('categoriesTbody').addEventListener('click', async (e) => {
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        const id = tr.getAttribute('data-id');
        const cats = await listCategories();
        const cat = cats.find(c => c.id === id);
        if (!cat) return;
        if (e.target.classList.contains('renameBtn')) {
            const newName = prompt('New category name:', cat.name);
            if (!newName) return;
            try { await renameCategory(id, newName); await render(); } catch (err) { alert(err.message); }
        }
        if (e.target.classList.contains('deleteBtn')) {
            const usage = await countExpensesByCategoryAll();
            const count = usage.get(id) || 0;
            if (count === 0) {
                if (confirm(`Delete category "${cat.name}"?`)) { await del('categories', id); await render(); }
            } else {
                const otherCats = cats.filter(c => c.id !== id);
                if (!otherCats.length) { alert('Create another category first, then reassign.'); return; }
                const names = otherCats.map(c => c.name).join(', ');
                const targetName = prompt(`Category "${cat.name}" is used in ${count} expense(s).\nType the target category name to reassign to one of:\n${names}`);
                if (!targetName) return;
                const target = otherCats.find(c => c.name.toLowerCase() === targetName.trim().toLowerCase());
                if (!target) { alert('No matching category found. Type the exact target name.'); return; }
                if (!confirm(`Reassign ${count} expense(s) from "${cat.name}" to "${target.name}" and delete "${cat.name}"?`)) return;
                await reassignCategory(id, target.id);
                await del('categories', id);
                await render();
            }
        }
    });

    // Expense table actions (edit/delete) with in-place editor + photo support
    document.getElementById('expensesTbody').addEventListener('click', async (e) => {
        const tr = e.target.closest('tr[data-expense-id]');
        if (!tr) return;
        const id = tr.getAttribute('data-expense-id');

        // Ignore clicks on photo thumbnails (handled by lightbox)
        if (e.target.classList.contains('expense-thumb')) return;

        if (e.target.classList.contains('deleteExpenseBtn')) {
            if (!confirm('Delete this expense?')) return;
            await deleteExpense(id);
            await render();
            return;
        }

        if (e.target.classList.contains('editExpenseBtn')) {
            try {
                const exp = await get('expenses', id);
                if (!exp) return;
                const cats = await listCategories();
                const settings = await loadSettings();
                const allCurrencies = Array.from(new Set([settings.homeCurrency, ...(settings.tripCurrencies || [])]));
                const existingPhoto = await getPhoto(id);
                const originalHtml = tr.innerHTML;

                const categoryOptions = createSelectHtml(cats, exp.categoryId, 'id');
                const currencyOptions = createSelectHtml(allCurrencies, exp.currency);
                const methodOptionsHtml = `<option value="credit"${exp.method === 'credit' ? ' selected' : ''}>Credit</option><option value="cash"${exp.method === 'cash' ? ' selected' : ''}>Cash</option>`;

                const photoEditHtml = existingPhoto
                    ? `<img class="expense-thumb" src="${existingPhoto.dataUrl}" alt="Current" style="pointer-events:none;" />
                       <label class="muted" style="cursor:pointer;">Replace: <input class="edit-photo" type="file" accept="image/*" style="width:7rem;" /></label>
                       <label style="font-size:.78rem;"><input class="edit-remove-photo" type="checkbox" /> Remove</label>`
                    : `<input class="edit-photo" type="file" accept="image/*" style="width:7rem;" />`;

                const localDate = utcDateToLocal(exp.date);

                tr.innerHTML = `
                    <td><input class="edit-date" type="date" value="${localDate}" /></td>
                    <td>
                      <div class="edit-cat-normal">
                        <select class="edit-category">${categoryOptions}</select>
                        <button class="editSplitBtn btn btn-outline btn-sm" type="button" style="margin-top:.25rem;">✂️ Split</button>
                      </div>
                      <div class="edit-split-container" hidden>
                        <div class="edit-split-rows"></div>
                        <div style="display:flex;gap:.5rem;align-items:center;margin-top:.25rem;">
                          <button class="addEditSplitRow btn btn-outline btn-sm" type="button">+ Add</button>
                          <strong class="edit-split-remainder muted" style="font-size:.82rem;">Remaining: 0.00</strong>
                        </div>
                        <div class="edit-split-warning muted" style="color:var(--color-danger, #c00);margin-top:.2rem;font-size:.8rem;"></div>
                        <button class="cancelEditSplit btn btn-ghost btn-sm" type="button" style="margin-top:.25rem;">Cancel split</button>
                      </div>
                    </td>
                    <td><select class="edit-method">${methodOptionsHtml}</select></td>
                    <td>
                      <select class="edit-currency">${currencyOptions}</select>
                      <input class="edit-amount" type="number" step="0.01" style="width:6.5rem; margin-left:.5rem;" value="${(exp.amountLocalCents / 100).toFixed(2)}" />
                    </td>
                    <td class="edit-fx">${formatRate(exp.fxRatePpm)}</td>
                    <td class="edit-base">${exp.baseAmountCents == null ? '<span class="muted">pending</span>' : (exp.baseAmountCents / 100).toFixed(2)}</td>
                    <td><input class="edit-desc" type="text" value="${(exp.description || '').replace(/"/g, '&quot;')}" /></td>
                    <td>${photoEditHtml}</td>
                    <td class="actions">
                      <button class="saveExpenseBtn" type="button">Save</button>
                      <button class="cancelExpenseBtn" type="button">Cancel</button>
                    </td>`;

                const splitContainer = tr.querySelector('.edit-split-container');
                const splitRowsEl = tr.querySelector('.edit-split-rows');
                let isSplitMode = false;

                tr.querySelector('.editSplitBtn').addEventListener('click', () => {
                    isSplitMode = true;
                    tr.querySelector('.edit-cat-normal').hidden = true;
                    splitContainer.hidden = false;
                    const currentCat = tr.querySelector('.edit-category').value;
                    const currentAmount = tr.querySelector('.edit-amount').value || '';
                    splitRowsEl.innerHTML = createEditSplitRowHtml(cats, currentCat, currentAmount);
                    updateEditSplitRemainder(splitContainer, parseFloat(currentAmount) || 0);
                });

                tr.querySelector('.cancelEditSplit').addEventListener('click', () => {
                    isSplitMode = false;
                    splitContainer.hidden = true;
                    tr.querySelector('.edit-cat-normal').hidden = false;
                    splitRowsEl.innerHTML = '';
                });

                tr.querySelector('.addEditSplitRow').addEventListener('click', () => {
                    const totalAmount = parseFloat(tr.querySelector('.edit-amount').value) || 0;
                    const splitTotal = getEditSplitTotal(splitContainer);
                    const remainder = Math.round((totalAmount - splitTotal) * 100) / 100;
                    splitRowsEl.insertAdjacentHTML('beforeend', createEditSplitRowHtml(cats, '', remainder > 0 ? remainder.toFixed(2) : ''));
                    updateEditSplitRemainder(splitContainer, totalAmount);
                });

                splitContainer.addEventListener('click', (ev) => {
                    if (ev.target.classList.contains('removeEditSplitRow')) {
                        ev.target.closest('.edit-split-row').remove();
                        updateEditSplitRemainder(splitContainer, parseFloat(tr.querySelector('.edit-amount').value) || 0);
                    }
                });
                splitContainer.addEventListener('input', (ev) => {
                    if (ev.target.classList.contains('edit-split-amount')) {
                        updateEditSplitRemainder(splitContainer, parseFloat(tr.querySelector('.edit-amount').value) || 0);
                    }
                });

                tr.querySelector('.edit-amount').addEventListener('input', () => {
                    if (isSplitMode) {
                        updateEditSplitRemainder(splitContainer, parseFloat(tr.querySelector('.edit-amount').value) || 0);
                    }
                });

                tr.querySelector('.cancelExpenseBtn').addEventListener('click', () => { tr.innerHTML = originalHtml; });
                tr.querySelector('.saveExpenseBtn').addEventListener('click', async (ev) => {
                    const btn = ev.target;
                    btn.disabled = true;
                    try {
                        const newDateLocal = tr.querySelector('.edit-date').value;
                        const newCategoryId = tr.querySelector('.edit-category').value;
                        const newMethod = tr.querySelector('.edit-method').value;
                        const newCurrency = tr.querySelector('.edit-currency').value;
                        const newAmount = tr.querySelector('.edit-amount').value;
                        const newDesc = tr.querySelector('.edit-desc').value || '';
                        const photoInput = tr.querySelector('.edit-photo');
                        const removeCheckbox = tr.querySelector('.edit-remove-photo');
                        const photoFile = photoInput?.files?.[0] || null;
                        const removePhoto = removeCheckbox?.checked || false;

                        if (!newDateLocal || !newCurrency || !newMethod || isNaN(Number(newAmount))) {
                            alert('Invalid input. Please check date, currency, method, and amount.');
                            btn.disabled = false;
                            return;
                        }

                        const newDateUTC = localDateToUTC(newDateLocal);

                        if (isSplitMode) {
                            const splits = getEditSplitsFromContainer(splitContainer);
                            if (!splits.length) {
                                alert('Add at least one split row with a category and amount.');
                                btn.disabled = false;
                                return;
                            }
                            if (!validateEditSplits(splitContainer, splits, Number(newAmount))) {
                                btn.disabled = false;
                                return;
                            }

                            const origPhoto = await getPhoto(id);

                            await deleteExpense(id);

                            let firstSplitId = null;
                            for (const split of splits) {
                                const splitDesc = splits.length > 1
                                    ? `[split ${Number(newAmount).toFixed(2)}] ${newDesc.trim()}`
                                    : newDesc.trim();

                                const newId = await addExpense({
                                    date: newDateUTC,
                                    currency: newCurrency.trim().toUpperCase(),
                                    method: newMethod.trim().toLowerCase(),
                                    categoryId: split.categoryId,
                                    description: splitDesc,
                                    amountLocal: split.amount.toFixed(2),
                                    photoFile: null
                                });

                                if (!firstSplitId) firstSplitId = newId;
                            }

                            if (firstSplitId) {
                                if (photoFile) {
                                    try {
                                        const dataUrl = await readAndResizePhoto(photoFile);
                                        await savePhoto(firstSplitId, dataUrl);
                                    } catch { /* non-fatal */ }
                                } else if (origPhoto && !removePhoto) {
                                    await savePhoto(firstSplitId, origPhoto.dataUrl);
                                }
                            }

                            showToast(`Split into ${splits.length} expenses ✓`);
                            await render();
                        } else {
                            await updateExpense(id, {
                                date: newDateUTC,
                                currency: newCurrency.trim().toUpperCase(),
                                method: newMethod.trim().toLowerCase(),
                                categoryId: newCategoryId,
                                description: newDesc.trim(),
                                amountLocal: newAmount,
                                photoFile,
                                removePhoto
                            });
                            await render();
                        }
                    } catch (err) {
                        alert('Save failed: ' + (err.message || err));
                        btn.disabled = false;
                    }
                });
            } catch (err) {
                alert('Edit failed: ' + (err.message || err));
            }
        }
    });

    // Cash batch add
    document.getElementById('cashForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const dateLocal = document.getElementById('cashDate').value;
        const currency = document.getElementById('cashCurrency').value.trim().toUpperCase();
        const rateStr = document.getElementById('cashRate').value;
        const purchased = document.getElementById('cashAmount').value;
        await addCashBatch({ date: localDateToUTC(dateLocal), currency, rateStr, purchasedAmount: purchased });
        e.target.reset();
        document.getElementById('cashDate').value = todayLocal();
        await render();
    });

    // Cash batch list actions (edit/delete)
    document.getElementById('cashBatchesList').addEventListener('click', async (e) => {
        const li = e.target.closest('li[data-id]');
        if (!li) return;
        const id = li.getAttribute('data-id');

        if (e.target.classList.contains('deleteCashBtn')) {
            if (!confirm('Delete this cash batch?')) return;
            const ok = await deleteCashBatch(id);
            if (!ok) { alert('Cannot delete this cash batch — one or more expenses across trips reference it. Reassign or delete those expenses first.'); return; }
            await render();
            return;
        }
        if (e.target.classList.contains('editCashBtn')) {
            try {
                const batch = await get('cashBatches', id);
                if (!batch) return;
                const settings = await loadSettings();
                const allCurrencies = Array.from(new Set([settings.homeCurrency, ...(settings.tripCurrencies || [])]));
                const originalHtml = li.innerHTML;
                const currencyOptions = allCurrencies.map(c => `<option value="${c}"${c === batch.currency ? ' selected' : ''}>${c}</option>`).join('');
                const localDate = utcDateToLocal(batch.date);
                li.innerHTML = `
                    <div class="cash-edit-scroll" style="overflow-x:auto;">
                      <div class="cash-edit-row" style="display:inline-flex; gap:.5rem; align-items:center; min-width:560px; padding:.25rem 0;">
                        <input class="edit-cash-date" type="date" value="${localDate}" style="width:9.5rem;" />
                        <select class="edit-cash-currency">${currencyOptions}</select>
                        <input class="edit-cash-rate" type="number" step="0.0001" value="${(batch.ratePpm / PPM).toFixed(6)}" style="width:9.5rem;" />
                        <input class="edit-cash-amount" type="number" step="0.01" value="${(batch.purchasedAmountCents / 100).toFixed(2)}" style="width:6.5rem;" />
                        <span class="actions" style="margin-left:.5rem;">
                          <button class="saveCashBtn" type="button">Save</button>
                          <button class="cancelCashBtn" type="button">Cancel</button>
                        </span>
                      </div>
                    </div>`;
                li.querySelector('.cancelCashBtn').addEventListener('click', () => { li.innerHTML = originalHtml; });
                li.querySelector('.saveCashBtn').addEventListener('click', async (ev) => {
                    const btn = ev.target;
                    btn.disabled = true;
                    try {
                        const newDateLocal = li.querySelector('.edit-cash-date').value;
                        const newCurrency = li.querySelector('.edit-cash-currency').value;
                        const newRate = li.querySelector('.edit-cash-rate').value;
                        const newAmount = li.querySelector('.edit-cash-amount').value;
                        if (!newDateLocal || !newCurrency || isNaN(Number(newRate)) || isNaN(Number(newAmount))) {
                            alert('Invalid input. Please check date, currency, rate, and amount.');
                            btn.disabled = false;
                            return;
                        }
                        const newPurchasedCents = toCents(newAmount);
                        const oldPurchasedCents = batch.purchasedAmountCents;
                        const oldRemaining = batch.remainingCents ?? oldPurchasedCents;
                        // Adjust remaining proportionally: remaining += (newPurchased - oldPurchased)
                        const newRemaining = Math.max(0, oldRemaining + (newPurchasedCents - oldPurchasedCents));

                        batch.date = localDateToUTC(newDateLocal);
                        batch.currency = newCurrency.trim().toUpperCase();
                        batch.ratePpm = rateToPpm(newRate);
                        batch.purchasedAmountCents = newPurchasedCents;
                        batch.remainingCents = Math.min(newPurchasedCents, newRemaining);
                        await put('cashBatches', batch);
                        await render();
                    } catch (err) {
                        alert('Save failed: ' + (err.message || err));
                        btn.disabled = false;
                    }
                });
            } catch (err) {
                alert('Edit failed: ' + (err.message || err));
            }
            return;
        }
    });

    // --- Split toggle & live remainder ---
    document.getElementById('splitToggle').addEventListener('change', async (e) => {
        const container = document.getElementById('splitContainer');
        const splitRows = document.getElementById('splitRows');
        container.hidden = !e.target.checked;
        if (e.target.checked && splitRows.children.length === 0) {
            const cats = await listCategories();
            const selectedCat = document.getElementById('category').value;
            const totalAmount = parseFloat(document.getElementById('amount').value) || 0;
            splitRows.innerHTML = createSplitRowHtml(cats, selectedCat, totalAmount > 0 ? totalAmount.toFixed(2) : '');
            updateSplitRemainder();
        }
    });

    document.getElementById('addSplitRow').addEventListener('click', async () => {
        const cats = await listCategories();
        const remainder = getRemainder();
        const splitRows = document.getElementById('splitRows');
        splitRows.insertAdjacentHTML('beforeend', createSplitRowHtml(cats, '', remainder > 0 ? remainder.toFixed(2) : ''));
        updateSplitRemainder();
    });

    document.getElementById('splitRows').addEventListener('input', (e) => {
        if (e.target.classList.contains('split-amount')) updateSplitRemainder();
    });

    document.getElementById('splitRows').addEventListener('click', (e) => {
        if (e.target.classList.contains('removeSplitRow')) {
            e.target.closest('.split-row').remove();
            updateSplitRemainder();
        }
    });

    document.getElementById('amount').addEventListener('input', () => {
        if (document.getElementById('splitToggle').checked) updateSplitRemainder();
    });

    // Expense add
    document.getElementById('expenseForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const dateLocal = document.getElementById('date').value;
        const currency = document.getElementById('currency').value.trim().toUpperCase();
        const method = document.getElementById('method').value;
        const categoryId = document.getElementById('category').value;
        const description = document.getElementById('description').value.trim();
        const amountLocal = document.getElementById('amount').value;
        const photoInput = document.getElementById('expensePhoto');
        const photoFile = photoInput.files && photoInput.files[0] ? photoInput.files[0] : null;
        const isSplit = document.getElementById('splitToggle').checked;

        try {
            const dateUTC = localDateToUTC(dateLocal);

            if (isSplit) {
                const splits = getSplitsFromForm();
                if (!splits.length) {
                    alert('Add at least one split row with a category and amount.');
                    return;
                }
                if (!validateSplits(splits, Number(amountLocal))) return;

                let isFirst = true;
                for (const split of splits) {
                    await addExpense({
                        date: dateUTC,
                        currency,
                        method,
                        categoryId: split.categoryId,
                        description: splits.length > 1
                            ? `[split ${Number(amountLocal).toFixed(2)}] ${description}`
                            : description,
                        amountLocal: split.amount.toFixed(2),
                        photoFile: isFirst ? photoFile : null
                    });
                    isFirst = false;
                }
                showToast(`${splits.length} split expenses added ✓`);
            } else {
                await addExpense({ date: dateUTC, currency, method, categoryId, description, amountLocal, photoFile });
                showToast('Expense added ✓');
            }

            e.target.reset();
            document.getElementById('date').value = todayLocal();
            const settings = await loadSettings();
            document.getElementById('currency').value = settings.tripCurrencies[0];
            document.getElementById('photoPreview').innerHTML = '';
            document.getElementById('splitContainer').hidden = true;
            document.getElementById('splitRows').innerHTML = '';
            document.getElementById('splitWarning').textContent = '';
            document.getElementById('splitRemainder').textContent = 'Remaining: 0.00';
            setOcrStatus('hidden');
            await render();
        } catch (err) {
            alert(err.message);
        }
    });

    // Filters
    document.getElementById('filterForm').addEventListener('submit', async (e) => { e.preventDefault(); await render(); });
    document.getElementById('resetFilters').addEventListener('click', async () => { document.getElementById('startDate').value = ''; document.getElementById('endDate').value = ''; await render(); });

    // Display currency change
    document.getElementById('summaryCurrency').addEventListener('change', render);

    // Excel export
    document.getElementById('exportExcelBtn').addEventListener('click', exportToExcel);

    // Backup/Restore handlers
    document.getElementById('exportBackupBtn').addEventListener('click', exportBackup);
    document.getElementById('importBackupBtn').addEventListener('click', async () => {
        const fileEl = document.getElementById('importFile');
        const file = fileEl.files && fileEl.files[0];
        if (!file) { alert('Select a JSON backup file to import.'); return; }
        try { await importBackupFile(file); } catch (err) { alert(err.message); }
    });
    document.getElementById('importFile').addEventListener('change', (e) => {
        document.getElementById('importFileName').textContent = e.target.files[0]?.name || '';
    });

    // Default initial values
    document.getElementById('cashDate').value = todayLocal();
    const settings = await loadSettings();
    document.getElementById('currency').value = settings.tripCurrencies[0];
    document.getElementById('cashCurrency').value = settings.tripCurrencies[0];
    document.getElementById('summaryCurrency').value = settings.homeCurrency;

    // First render
    await render();

    // Sync pending offline expenses
    if (navigator.onLine) await syncPendingExpenses();
    window.addEventListener('online', async () => { await syncPendingExpenses(); });

    // Display version
    const versionEl = document.getElementById('appVersion');
    if (versionEl) versionEl.textContent = `v${APP_VERSION}`;

    // Register SW (as module to support import) and handle updates
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js', { type: 'module' }).then(reg => {
            setInterval(() => reg.update(), 30 * 60 * 1000);
        });

        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data?.type === 'SW_UPDATED') {
                showToast(`Updated to v${event.data.version}! Tap to reload.`, 'success', 8000);
                const toast = document.getElementById('toast');
                toast.style.cursor = 'pointer';
                toast.addEventListener('click', () => window.location.reload(), { once: true });
            }
        });
    }

    updateOnlineStatus();
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
});

// ---------- Split helpers ----------

function createSplitRowHtml(categories, selectedCategoryId = '', amount = '') {
    const options = categories.map(c =>
        `<option value="${c.id}"${c.id === selectedCategoryId ? ' selected' : ''}>${c.name}</option>`
    ).join('');
    return `<div class="split-row" style="display:flex;gap:.5rem;align-items:center;margin-bottom:.35rem;">
        <select class="split-category">${options}</select>
        <input class="split-amount" type="number" step="0.01" min="0" placeholder="0.00" value="${amount}" style="width:7rem;" />
        <button type="button" class="removeSplitRow btn btn-ghost btn-sm" title="Remove">✕</button>
    </div>`;
}

function createEditSplitRowHtml(categories, selectedCategoryId = '', amount = '') {
    const options = categories.map(c =>
        `<option value="${c.id}"${c.id === selectedCategoryId ? ' selected' : ''}>${c.name}</option>`
    ).join('');
    return `<div class="edit-split-row" style="display:flex;gap:.5rem;align-items:center;margin-bottom:.35rem;">
        <select class="edit-split-category">${options}</select>
        <input class="edit-split-amount" type="number" step="0.01" min="0" placeholder="0.00" value="${amount}" style="width:7rem;" />
        <button type="button" class="removeEditSplitRow btn btn-ghost btn-sm" title="Remove">✕</button>
    </div>`;
}

function getEditSplitTotal(container) {
    let total = 0;
    for (const input of container.querySelectorAll('.edit-split-amount')) {
        const val = parseFloat(input.value);
        if (!isNaN(val)) total += val;
    }
    return Math.round(total * 100) / 100;
}

function updateEditSplitRemainder(container, totalAmount) {
    const splitTotal = getEditSplitTotal(container);
    const remainder = Math.round((totalAmount - splitTotal) * 100) / 100;
    const el = container.querySelector('.edit-split-remainder');
    const warning = container.querySelector('.edit-split-warning');

    if (el) {
        el.textContent = `Remaining: ${remainder.toFixed(2)}`;
        el.style.color = remainder < 0 ? 'var(--color-danger, #c00)' : remainder === 0 ? 'var(--color-success, #090)' : '';
    }
    if (warning) {
        if (remainder < 0) {
            warning.textContent = `Splits exceed total by ${Math.abs(remainder).toFixed(2)}`;
        } else if (remainder > 0) {
            warning.textContent = `${remainder.toFixed(2)} still unassigned`;
        } else {
            warning.textContent = '';
        }
    }
    return remainder;
}

function getEditSplitsFromContainer(container) {
    const rows = container.querySelectorAll('.edit-split-row');
    const splits = [];
    for (const row of rows) {
        const categoryId = row.querySelector('.edit-split-category').value;
        const amount = parseFloat(row.querySelector('.edit-split-amount').value);
        if (categoryId && !isNaN(amount) && amount > 0) {
            splits.push({ categoryId, amount });
        }
    }
    return splits;
}

function validateEditSplits(container, splits, totalAmount) {
    const splitTotal = splits.reduce((sum, s) => sum + s.amount, 0);
    const diff = Math.round(Math.abs(totalAmount - splitTotal) * 100) / 100;
    const warning = container.querySelector('.edit-split-warning');
    if (diff > 0.01) {
        if (warning) warning.textContent = `Split total (${splitTotal.toFixed(2)}) ≠ expense amount (${totalAmount.toFixed(2)}). Difference: ${diff.toFixed(2)}`;
        return false;
    }
    if (warning) warning.textContent = '';
    return true;
}

function getSplitTotal() {
    let total = 0;
    for (const input of document.querySelectorAll('#splitRows .split-amount')) {
        const val = parseFloat(input.value);
        if (!isNaN(val)) total += val;
    }
    return Math.round(total * 100) / 100;
}

function updateSplitRemainder() {
    const totalAmount = parseFloat(document.getElementById('amount').value) || 0;
    const splitTotal = getSplitTotal();
    const remainder = Math.round((totalAmount - splitTotal) * 100) / 100;
    const el = document.getElementById('splitRemainder');
    const warning = document.getElementById('splitWarning');

    if (el) {
        el.textContent = `Remaining: ${remainder.toFixed(2)}`;
        el.style.color = remainder < 0 ? 'var(--danger, #c00)' : remainder === 0 ? 'var(--success, #090)' : '';
    }
    if (warning) {
        if (remainder < 0) {
            warning.textContent = `Splits exceed total by ${Math.abs(remainder).toFixed(2)}`;
        } else if (remainder > 0) {
            warning.textContent = `${remainder.toFixed(2)} still unassigned`;
        } else {
            warning.textContent = '';
        }
    }
    return remainder;
}

function getRemainder() {
    const totalAmount = parseFloat(document.getElementById('amount').value) || 0;
    const splitTotal = getSplitTotal();
    return Math.round((totalAmount - splitTotal) * 100) / 100;
}

function getSplitsFromForm() {
    const rows = document.querySelectorAll('#splitRows .split-row');
    const splits = [];
    for (const row of rows) {
        const categoryId = row.querySelector('.split-category').value;
        const amount = parseFloat(row.querySelector('.split-amount').value);
        if (categoryId && !isNaN(amount) && amount > 0) {
            splits.push({ categoryId, amount });
        }
    }
    return splits;
}

function validateSplits(splits, totalAmount) {
    const splitTotal = splits.reduce((sum, s) => sum + s.amount, 0);
    const diff = Math.round(Math.abs(totalAmount - splitTotal) * 100) / 100;
    if (diff > 0.01) {
        document.getElementById('splitWarning').textContent =
            `Split total (${splitTotal.toFixed(2)}) ≠ expense amount (${totalAmount.toFixed(2)}). Difference: ${diff.toFixed(2)}`;
        return false;
    }
    document.getElementById('splitWarning').textContent = '';
    return true;
}