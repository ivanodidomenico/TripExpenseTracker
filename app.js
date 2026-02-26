import { put, get, getAll, del, indexGetAllRange, indexGetAllKey } from './db.js';

// ---------- Money & Rate helpers ----------
const PPM = 1_000_000;

const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => (c / 100).toFixed(2);
const rateToPpm = (rateStr) => Math.round(Number(rateStr) * PPM);
const applyFeePpm = (ppm, feePercent) => Math.round(ppm * (1 + feePercent / 100));
const today = () => new Date().toISOString().slice(0, 10);
const $ = (sel) => document.querySelector(sel);

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

    // --- Date extraction ---
    const datePatterns = [
        /(\d{4}[-/.]\d{2}[-/.]\d{2})/,           // 2025-06-15
        /(\d{2}[-/.]\d{2}[-/.]\d{4})/,           // 15/06/2025 or 06-15-2025
        /(\d{2}[-/.]\d{2}[-/.]\d{2})(?!\d)/,     // 15/06/25 (short year)
    ];
    let dateMatch = null;
    for (const line of lines) {
        for (const pat of datePatterns) {
            const m = line.match(pat);
            if (m) { dateMatch = m[1]; break; }
        }
        if (dateMatch) break;
    }

    // Attempt to normalise the matched date into YYYY-MM-DD
    let isoDate = null;
    if (dateMatch) {
        const cleaned = dateMatch.replace(/[/.]/g, '-');
        const parts = cleaned.split('-');
        if (parts.length === 3) {
            let [a, b, c] = parts;
            if (a.length === 4) {
                // YYYY-MM-DD
                isoDate = `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
            } else if (c.length === 4) {
                // DD-MM-YYYY or MM-DD-YYYY — assume DD-MM-YYYY (most common outside US)
                isoDate = `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
            } else if (c.length === 2) {
                // DD-MM-YY
                const year = Number(c) > 50 ? `19${c}` : `20${c}`;
                isoDate = `${year}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
            }
        }
        // Validate the result is a real date
        if (isoDate && isNaN(Date.parse(isoDate))) isoDate = null;
    }

    // --- Total extraction ---
    const moneyPattern = /[\$€£¥]?\s?(\d{1,7}[.,]\d{2})\b/g;
    let totalAmount = null;
    let largestAmount = 0;

    for (const line of lines) {
        // Prioritise lines with "total" keyword (skip "subtotal")
        const isTotal = /\btotal\b/i.test(line) && !/\bsub\s?total\b/i.test(line);
        if (isTotal) {
            const m = line.match(moneyPattern);
            if (m) {
                const val = parseFloat(m[m.length - 1].replace(/[^\d.,]/g, '').replace(',', '.'));
                if (val > 0) totalAmount = val;
            }
        }
        // Track largest amount as fallback
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
    };
}

// ---------- OCR: run Tesseract on a File ----------
let ocrWorker = null;

async function runOcr(file, langs) {
    // Use the global Tesseract loaded from CDN
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
        await deletePhoto(e.id);
        await del('expenses', e.id);
    }
    const categories = await indexGetAllKey('categories', 'byTrip', tripId);
    for (const c of categories) await del('categories', c.id);
    const cashBatches = await indexGetAllKey('cashBatches', 'byTrip', tripId);
    for (const b of cashBatches) await del('cashBatches', b.id);
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
            const effectiveDate = dateStr || today();
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

// ---------- Cash Batches ----------
async function addCashBatch({ date, currency, rateStr, purchasedAmount }) {
    await put('cashBatches', {
        id: crypto.randomUUID(),
        tripId: getActiveTripId(),
        date,
        currency: currency.toUpperCase(),
        ratePpm: rateToPpm(rateStr),
        purchasedAmountCents: toCents(purchasedAmount),
        note: ''
    });
}

async function pickCashBatchFor(dateStr, currency) {
    const batches = await indexGetAllKey('cashBatches', 'byTrip', getActiveTripId());
    const d = new Date(dateStr).getTime();
    const candidates = batches.filter(b => b.currency === currency.toUpperCase() && new Date(b.date).getTime() <= d);
    candidates.sort((a, b) => new Date(b.date) - new Date(a.date));
    return candidates[0] || null;
}

async function deleteCashBatch(batchId) {
    const exps = await indexGetAllKey('expenses', 'byTrip', getActiveTripId());
    const used = exps.some(e => e.cashBatchId === batchId);
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
            if (!batch) throw new Error(`No cash batch found for ${currency} on or before ${date}. Add a cash batch first.`);
            cashBatchId = batch.id;
            fxRatePpm = batch.ratePpm;
            fxSource = 'cashBatch';
            baseAmountCents = Math.round(amountLocalCents * batch.ratePpm / PPM);
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
                    throw new Error(`Unable to fetch FX rate for ${currency} on ${date}. Check your internet connection and try again.`);
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
}

async function updateExpense(id, { date, currency, method, categoryId, description, amountLocal, photoFile, removePhoto }) {
    const exp = await get('expenses', id);
    if (!exp) throw new Error('Expense not found.');

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
            if (!batch) throw new Error(`No cash batch found for ${exp.currency} on or before ${date}. Add a cash batch first.`);
            cashBatchId = batch.id;
            fxRatePpm = batch.ratePpm;
            fxSource = 'cashBatch';
            baseAmountCents = Math.round(exp.amountLocalCents * batch.ratePpm / PPM);
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
                if (!result) throw new Error(`Unable to fetch FX rate for ${exp.currency} on ${date}.`);
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
    const result = await getOrFetchRate(endDate || today(), targetCurrency);
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

    const batches = await indexGetAllKey('cashBatches', 'byTrip', getActiveTripId());
    $('#cashBatchesList').innerHTML = batches
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map(b => `<li data-id="${b.id}">${b.date} • ${b.currency} • rate ${(b.ratePpm / PPM).toFixed(4)} • ${(b.purchasedAmountCents / 100).toFixed(2)} <span class="actions"><button class="editCashBtn" type="button">Edit</button> <button class="deleteCashBtn" type="button">Delete</button></span></li>`)
        .join('');

    const summaryEl = document.getElementById('summaryCurrency');
    const prevSummary = summaryEl.value;
    summaryEl.innerHTML = allDisplayCurrencies.map(c => `<option value="${c}">${c}</option>`).join('');
    summaryEl.value = allDisplayCurrencies.includes(prevSummary) ? prevSummary : settings.homeCurrency;

    const startDate = $('#startDate').value || null;
    const endDate = $('#endDate').value || null;
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
                <td>${e.date}</td>
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
        a.download = `tripx-backup-${today()}.json`;
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
    // This prevents orphaned records when importing older backups that lack newer stores.
    const alwaysWipeStores = ['photos'];

    try {
        if (wipe) {
            // Wipe stores present in the backup
            for (const s of storeNames) {
                const existing = await getAll(s);
                for (const item of existing) {
                    const key = keyFor(s, item);
                    if (key != null) await del(s, key);
                }
            }
            // Wipe stores not in the backup but required for consistency
            for (const s of alwaysWipeStores) {
                if (storeNames.includes(s)) continue; // already handled above
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

// ---------- Event handlers ----------
document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    await ensureDefaults();

    document.getElementById('date').value = today();

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
        if (!confirm(`Delete trip "${current?.name}" and ALL its expenses, categories, and cash batches? This cannot be undone.`)) return;
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
                       <label class="muted" style="cursor:pointer;">Replace: <input class="edit-photo" type="file" accept="image/*" capture="environment" style="width:7rem;" /></label>
                       <label style="font-size:.78rem;"><input class="edit-remove-photo" type="checkbox" /> Remove</label>`
                    : `<input class="edit-photo" type="file" accept="image/*" capture="environment" style="width:7rem;" />`;

                tr.innerHTML = `
                    <td><input class="edit-date" type="date" value="${exp.date}" /></td>
                    <td><select class="edit-category">${categoryOptions}</select></td>
                    <td><select class="edit-method">${methodOptionsHtml}</select></td>
                    <td>
                      <select class="edit-currency">${currencyOptions}</select>
                      <input class="edit-amount" type="number" step="0.01" style="width:6.5rem; margin-left:.5rem;" value="${(exp.amountLocalCents / 100).toFixed(2)}" />
                    </td>
                    <td class="edit-fx">${formatRate(exp.fxRatePpm)}</td>
                    <td class="edit-base">${exp.baseAmountCents == null ? '<span class="muted">pending</span>' : (exp.baseAmountCents/100).toFixed(2)}</td>
                    <td><input class="edit-desc" type="text" value="${(exp.description || '').replace(/"/g, '&quot;')}" /></td>
                    <td>${photoEditHtml}</td>
                    <td class="actions">
                      <button class="saveExpenseBtn" type="button">Save</button>
                      <button class="cancelExpenseBtn" type="button">Cancel</button>
                    </td>`;

                tr.querySelector('.cancelExpenseBtn').addEventListener('click', () => { tr.innerHTML = originalHtml; });
                tr.querySelector('.saveExpenseBtn').addEventListener('click', async (ev) => {
                    const btn = ev.target;
                    btn.disabled = true;
                    try {
                        const newDate = tr.querySelector('.edit-date').value;
                        const newCategoryId = tr.querySelector('.edit-category').value;
                        const newMethod = tr.querySelector('.edit-method').value;
                        const newCurrency = tr.querySelector('.edit-currency').value;
                        const newAmount = tr.querySelector('.edit-amount').value;
                        const newDesc = tr.querySelector('.edit-desc').value || '';
                        const photoInput = tr.querySelector('.edit-photo');
                        const removeCheckbox = tr.querySelector('.edit-remove-photo');
                        const photoFile = photoInput?.files?.[0] || null;
                        const removePhoto = removeCheckbox?.checked || false;

                        if (!newDate || !newCurrency || !newMethod || isNaN(Number(newAmount))) {
                            alert('Invalid input. Please check date, currency, method, and amount.');
                            btn.disabled = false;
                            return;
                        }
                        await updateExpense(id, {
                            date: newDate,
                            currency: newCurrency.trim().toUpperCase(),
                            method: newMethod.trim().toLowerCase(),
                            categoryId: newCategoryId,
                            description: newDesc.trim(),
                            amountLocal: newAmount,
                            photoFile,
                            removePhoto
                        });
                        await render();
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
        const date = document.getElementById('cashDate').value;
        const currency = document.getElementById('cashCurrency').value.trim().toUpperCase();
        const rateStr = document.getElementById('cashRate').value;
        const purchased = document.getElementById('cashAmount').value;
        await addCashBatch({ date, currency, rateStr, purchasedAmount: purchased });
        e.target.reset();
        document.getElementById('cashDate').value = today();
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
            if (!ok) { alert('Cannot delete this cash batch — one or more expenses reference it. Reassign or delete those expenses first.'); return; }
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
                li.innerHTML = `
                    <div class="cash-edit-scroll" style="overflow-x:auto;">
                      <div class="cash-edit-row" style="display:inline-flex; gap:.5rem; align-items:center; min-width:560px; padding:.25rem 0;">
                        <input class="edit-cash-date" type="date" value="${batch.date}" style="width:9.5rem;" />
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
                        const newDate = li.querySelector('.edit-cash-date').value;
                        const newCurrency = li.querySelector('.edit-cash-currency').value;
                        const newRate = li.querySelector('.edit-cash-rate').value;
                        const newAmount = li.querySelector('.edit-cash-amount').value;
                        if (!newDate || !newCurrency || isNaN(Number(newRate)) || isNaN(Number(newAmount))) {
                            alert('Invalid input. Please check date, currency, rate, and amount.');
                            btn.disabled = false;
                            return;
                        }
                        batch.date = newDate.trim();
                        batch.currency = newCurrency.trim().toUpperCase();
                        batch.ratePpm = rateToPpm(newRate);
                        batch.purchasedAmountCents = toCents(newAmount);
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

    // Expense add
    document.getElementById('expenseForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const date = document.getElementById('date').value;
        const currency = document.getElementById('currency').value.trim().toUpperCase();
        const method = document.getElementById('method').value;
        const categoryId = document.getElementById('category').value;
        const description = document.getElementById('description').value.trim();
        const amountLocal = document.getElementById('amount').value;
        const photoInput = document.getElementById('expensePhoto');
        const photoFile = photoInput.files && photoInput.files[0] ? photoInput.files[0] : null;

        try {
            await addExpense({ date, currency, method, categoryId, description, amountLocal, photoFile });
            e.target.reset();
            document.getElementById('date').value = today();
            const settings = await loadSettings();
            document.getElementById('currency').value = settings.tripCurrencies[0];
            document.getElementById('photoPreview').innerHTML = '';
            setOcrStatus('hidden');
            showToast('Expense added ✓');
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

    // Backup/Restore handlers
    document.getElementById('exportBackupBtn').addEventListener('click', exportBackup);
    document.getElementById('importBackupBtn').addEventListener('click', async () => {
        const fileEl = document.getElementById('importFile');
        const file = fileEl.files && fileEl.files[0];
        if (!file) { alert('Select a JSON backup file to import.'); return; }
        try { await importBackupFile(file); } catch (err) { alert(err.message || err); }
    });
    document.getElementById('importFile').addEventListener('change', (e) => {
        document.getElementById('importFileName').textContent = e.target.files[0]?.name || '';
    });

    // Default initial values
    document.getElementById('cashDate').value = today();
    const settings = await loadSettings();
    document.getElementById('currency').value = settings.tripCurrencies[0];
    document.getElementById('cashCurrency').value = settings.tripCurrencies[0];
    document.getElementById('summaryCurrency').value = settings.homeCurrency;

    // First render
    await render();

    // Sync pending offline expenses
    if (navigator.onLine) await syncPendingExpenses();
    window.addEventListener('online', async () => { await syncPendingExpenses(); });

    // Register SW
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');

    updateOnlineStatus();
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
});