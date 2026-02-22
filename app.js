import { put, get, getAll, del, indexGetAll, indexGetAllRange, indexGetAllKey } from './db.js';

// ---------- Money & Rate helpers ----------
const PPM = 1_000_000;

const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => (c / 100).toFixed(2);
const rateToPpm = (rateStr) => Math.round(Number(rateStr) * PPM);
const applyFeePpm = (ppm, feePercent) => Math.round(ppm * (1 + feePercent / 100));
const today = () => new Date().toISOString().slice(0, 10);
const $ = (sel) => document.querySelector(sel);

// ---------- Active trip ----------
let activeTripId = null;

function getActiveTripId() {
    if (!activeTripId) throw new Error('No trip selected. Create or select a trip first.');
    return activeTripId;
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

    // Create default settings for this trip
    await put('settings', { id: `trip:${id}`, homeCurrency: 'CAD', tripCurrency: 'EUR', ccFeePercent: 2.5 });

    // Create default category for this trip
    await put('categories', { id: crypto.randomUUID(), name: 'Meals', tripId: id });

    return trip;
}

async function deleteTrip(tripId) {
    // Delete all data associated with this trip
    const expenses = await indexGetAllKey('expenses', 'byTrip', tripId);
    for (const e of expenses) await del('expenses', e.id);

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
    // Migrate v1 data: if there are no trips but there is old 'app' settings, create a default trip
    const trips = await listTrips();
    if (!trips.length) {
        const oldSettings = await get('settings', 'app');
        const trip = await createTrip('My Trip');
        activeTripId = trip.id;

        if (oldSettings) {
            // Migrate old settings
            await put('settings', {
                id: `trip:${trip.id}`,
                homeCurrency: oldSettings.homeCurrency || 'CAD',
                tripCurrency: oldSettings.tripCurrency || 'EUR',
                ccFeePercent: oldSettings.ccFeePercent ?? 2.5
            });

            // Migrate existing expenses, categories, and cash batches (assign tripId)
            const existingExpenses = await getAll('expenses');
            for (const e of existingExpenses) {
                if (!e.tripId) { e.tripId = trip.id; await put('expenses', e); }
            }
            const existingCats = await getAll('categories');
            for (const c of existingCats) {
                if (!c.tripId) { c.tripId = trip.id; await put('categories', c); }
            }
            const existingBatches = await getAll('cashBatches');
            for (const b of existingBatches) {
                if (!b.tripId) { b.tripId = trip.id; await put('cashBatches', b); }
            }

            // Remove old settings key
            await del('settings', 'app');
        }
    } else {
        // Load last used trip from localStorage or pick first
        const lastTrip = localStorage.getItem('activeTrip');
        if (lastTrip && trips.some(t => t.id === lastTrip)) {
            activeTripId = lastTrip;
        } else {
            activeTripId = trips[0].id;
        }
    }

    localStorage.setItem('activeTrip', activeTripId);
    return await get('settings', settingsKey());
}

// ---------- FX Rates ----------
async function upsertFxRate(dateStr, currency, ratePpm) {
    const settings = await get('settings', settingsKey());
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

// ---------- Frankfurter API: fetch and cache FX rate ----------
// Always call Frankfurter directly (no server-side proxy)
async function fetchAndCacheRate(dateStr, currency) {
    try {
        const settings = await get('settings', settingsKey());
        const to = settings.homeCurrency.toUpperCase();
        const from = currency.toUpperCase();

        // If the requested currency is the same as home currency, no conversion required.
        // Return identity rate (1.0) represented in ppm and cache it.
        if (from === to) {
            const effectiveDate = dateStr || today();
            const ppm = PPM; // 1.0 in ppm
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

// ---------- Get rate: cache-first, then Frankfurter ----------
async function getOrFetchRate(dateStr, currency) {
    currency = currency.toUpperCase();

    // If the requested currency is the same as the trip's home currency, return identity rate.
    const settings = await get('settings', settingsKey());
    const home = (settings.homeCurrency || '').toUpperCase();
    if (currency === home) {
        return { ppm: PPM, source: 'identity' };
    }

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

// ---------- Expenses ----------
async function addExpense({ date, currency, method, categoryId, description, amountLocal }) {
    const settings = await get('settings', settingsKey());
    const amountLocalCents = toCents(amountLocal);
    currency = currency.toUpperCase();

    let baseAmountCents = 0;
    let cashBatchId = null;
    let fxRatePpm = null;
    let fxSource = 'frankfurter';

    if (method === 'cash') {
        const batch = await pickCashBatchFor(date, currency);
        if (!batch) throw new Error(`No cash batch found for ${currency} on or before ${date}. Add a cash batch first.`);
        cashBatchId = batch.id;
        fxRatePpm = batch.ratePpm;
        fxSource = 'cashBatch';
        baseAmountCents = Math.round(amountLocalCents * batch.ratePpm / PPM);
    } else {
        const result = await getOrFetchRate(date, currency);
        if (!result) {
            throw new Error(`Unable to fetch FX rate for ${currency} on ${date}. Check your internet connection and try again.`);
        }
        fxRatePpm = result.ppm;
        fxSource = result.source;

        // If the FX source is 'identity' (from == homeCurrency), ignore the credit-card fee.
        // Otherwise apply the configured cc fee.
        const eff = (fxSource === 'identity')
            ? fxRatePpm
            : applyFeePpm(fxRatePpm, settings.ccFeePercent ?? 2.5);

        baseAmountCents = Math.round(amountLocalCents * eff / PPM);
    }

    await put('expenses', {
        id: crypto.randomUUID(),
        tripId: getActiveTripId(),
        date,
        currency,
        method,
        categoryId,
        description,
        amountLocalCents,
        baseAmountCents,
        fxRatePpm,
        fxSource,
        cashBatchId
    });
}

async function deleteExpense(id) {
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
    return expenses.reduce((acc, e) => acc + e.baseAmountCents, 0);
}

async function convertBaseToTargetCents(baseCents, targetCurrency, endDate) {
    const settings = await get('settings', settingsKey());
    const home = settings.homeCurrency.toUpperCase();
    targetCurrency = targetCurrency.toUpperCase();
    if (targetCurrency === home) return baseCents;

    const result = await getOrFetchRate(endDate || today(), targetCurrency);
    if (!result) {
        throw new Error(`Unable to fetch FX rate for ${targetCurrency}. Check your internet connection.`);
    }
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
    for (const e of exps) {
        map.set(e.categoryId, (map.get(e.categoryId) || 0) + 1);
    }
    return map;
}

async function renameCategory(id, newName) {
    newName = newName.trim();
    if (!newName) throw new Error('Name required');
    const cats = await listCategories();
    if (cats.some(c => c.name.toLowerCase() === newName.toLowerCase() && c.id !== id)) {
        throw new Error('A category with that name already exists.');
    }
    const cat = cats.find(c => c.id === id);
    if (!cat) throw new Error('Category not found');
    cat.name = newName;
    await put('categories', cat);
}

async function reassignCategory(oldId, newId) {
    if (oldId === newId) return;
    const affected = await indexGetAllKey('expenses', 'byCategory', oldId);
    for (const e of affected) {
        e.categoryId = newId;
        await put('expenses', e);
    }
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
        default: return '🌐';
    }
}

async function renderTripSelector() {
    const trips = await listTrips();
    const selector = $('#tripSelector');
    selector.innerHTML = trips
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(t => `<option value="${t.id}"${t.id === activeTripId ? ' selected' : ''}>${t.name}</option>`)
        .join('');

    // Show current trip name in rename input
    const current = trips.find(t => t.id === activeTripId);
    if (current) {
        document.title = `${current.name} — Trip Expense Tracker`;
    }
}

async function render() {
    await renderTripSelector();
    const settings = await get('settings', settingsKey());

    // --- Settings page ---
    $('#homeCurrency').value = settings.homeCurrency;
    $('#tripCurrency').value = settings.tripCurrency;
    $('#ccFee').value = settings.ccFeePercent;

    // --- Expense page: category selector ---
    const cats = await listCategories();
    const sel = $('#category');
    sel.innerHTML = cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('');

    // --- Settings page: cash batch list ---
    const batches = await indexGetAllKey('cashBatches', 'byTrip', getActiveTripId());
    $('#cashBatchesList').innerHTML = batches
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map(b => `<li>${b.date} • ${b.currency} • rate ${(b.ratePpm / PPM).toFixed(4)} • ${(b.purchasedAmountCents / 100).toFixed(2)}</li>`)
        .join('');

    // --- Summary page ---
    const startDate = $('#startDate').value || null;
    const endDate = $('#endDate').value || null;
    const displayCurrency = ($('#summaryCurrency').value || settings.homeCurrency).toUpperCase();

    const exps = (await getExpensesInRange(startDate, endDate))
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    const catMap = new Map(cats.map(c => [c.id, c.name]));

    $('#expensesTbody').innerHTML = exps.length
        ? exps.map(e => {
            const catName = catMap.get(e.categoryId) || '—';
            const rateDisplay = formatRate(e.fxRatePpm);
            const sourceIcon = fxSourceLabel(e.fxSource);
            return `<tr data-expense-id="${e.id}">
                <td>${e.date}</td>
                <td>${catName}</td>
                <td>${e.method.toUpperCase()}</td>
                <td>${e.currency} ${(e.amountLocalCents / 100).toFixed(2)}</td>
                <td><span title="${e.fxSource || 'frankfurter'}">${sourceIcon}</span> ${rateDisplay}</td>
                <td>${(e.baseAmountCents / 100).toFixed(2)} ${settings.homeCurrency}</td>
                <td>${e.description || ''}</td>
                <td class="actions"><button class="deleteExpenseBtn" type="button">Delete</button></td>
            </tr>`;
        }).join('')
        : `<tr><td colspan="8" class="muted">No expenses in this range.</td></tr>`;

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

async function renderCategorySummary(expenses, categories, displayCurrency, endDate, homeCurrency) {
    const catMap = new Map(categories.map(c => [c.id, c.name]));
    const aggregates = new Map();
    for (const e of expenses) {
        const agg = aggregates.get(e.categoryId) || { count: 0, baseCents: 0 };
        agg.count += 1;
        agg.baseCents += e.baseAmountCents;
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

// ---------- Event handlers ----------
document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    await ensureDefaults();

    // Defaults
    document.getElementById('date').value = today();

    // --- Trip management events ---
    $('#tripSelector').addEventListener('change', async () => {
        activeTripId = $('#tripSelector').value;
        localStorage.setItem('activeTrip', activeTripId);
        const settings = await get('settings', settingsKey());
        document.getElementById('currency').value = settings.tripCurrency;
        document.getElementById('cashCurrency').value = settings.tripCurrency;
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
            const settings = await get('settings', settingsKey());
            document.getElementById('currency').value = settings.tripCurrency;
            document.getElementById('cashCurrency').value = settings.tripCurrency;
            document.getElementById('summaryCurrency').value = settings.homeCurrency;
            await render();
        } catch (err) { alert(err.message); }
    });

    $('#renameTripBtn').addEventListener('click', async () => {
        const trips = await listTrips();
        const current = trips.find(t => t.id === activeTripId);
        const newName = prompt('Rename trip:', current?.name || '');
        if (!newName || !newName.trim()) return;
        try {
            await renameTrip(activeTripId, newName);
            await render();
        } catch (err) { alert(err.message); }
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
        const settings = await get('settings', settingsKey());
        document.getElementById('currency').value = settings.tripCurrency;
        document.getElementById('cashCurrency').value = settings.tripCurrency;
        document.getElementById('summaryCurrency').value = settings.homeCurrency;
        await render();
    });

    // Settings form
    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await put('settings', {
            id: settingsKey(),
            homeCurrency: document.getElementById('homeCurrency').value.trim().toUpperCase(),
            tripCurrency: document.getElementById('tripCurrency').value.trim().toUpperCase(),
            ccFeePercent: Number(document.getElementById('ccFee').value)
        });
        await render();
    });

    // Category add
    document.getElementById('addCategory').addEventListener('click', async () => {
        const nameInput = document.getElementById('newCategoryName');
        const name = (nameInput.value || '').trim();
        if (!name) { alert('Enter a category name.'); return; }
        const cats = await listCategories();
        if (cats.some(c => c.name.toLowerCase() === name.toLowerCase())) {
            alert('A category with that name already exists.');
            return;
        }
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
            try {
                await renameCategory(id, newName);
                await render();
            } catch (err) { alert(err.message); }
        }

        if (e.target.classList.contains('deleteBtn')) {
            const usage = await countExpensesByCategoryAll();
            const count = usage.get(id) || 0;
            if (count === 0) {
                if (confirm(`Delete category "${cat.name}"?`)) {
                    await del('categories', id);
                    await render();
                }
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

    // Expense delete (event delegation on the expenses table)
    document.getElementById('expensesTbody').addEventListener('click', async (e) => {
        if (!e.target.classList.contains('deleteExpenseBtn')) return;
        const tr = e.target.closest('tr[data-expense-id]');
        if (!tr) return;
        const id = tr.getAttribute('data-expense-id');
        if (!confirm('Delete this expense?')) return;
        await deleteExpense(id);
        await render();
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

    // Expense add
    document.getElementById('expenseForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const date = document.getElementById('date').value;
        const currency = document.getElementById('currency').value.trim().toUpperCase();
        const method = document.getElementById('method').value;
        const categoryId = document.getElementById('category').value;
        const description = document.getElementById('description').value.trim();
        const amountLocal = document.getElementById('amount').value;

        try {
            await addExpense({ date, currency, method, categoryId, description, amountLocal });
            e.target.reset();
            document.getElementById('date').value = today();
            const settings = await get('settings', settingsKey());
            document.getElementById('currency').value = settings.tripCurrency;
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

    // Default initial values
    document.getElementById('cashDate').value = today();
    const settings = await get('settings', settingsKey());
    document.getElementById('currency').value = settings.tripCurrency;
    document.getElementById('cashCurrency').value = settings.tripCurrency;
    document.getElementById('summaryCurrency').value = settings.homeCurrency;

    // First render
    await render();

    // Register SW
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js');
    }
});