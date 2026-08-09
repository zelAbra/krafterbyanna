// krafted.js - Unified Logic for Storefront, Inventory, and Maintenance
// (Supabase edition)
//
// STORAGE ARCHITECTURE:
//   - Product catalog, orders, and the sales log live in Supabase
//     (Postgres + PostgREST + Realtime). Data written on one device (a
//     customer checking out on their phone) is visible on every other
//     device (Anna's inventory dashboard) via Supabase's Realtime
//     subscriptions.
//   - Product photos are stored as base64 data URLs, resized and
//     compressed on upload (see compressImageFile) and stored ONCE per
//     product, same approach as before. Postgres has no per-row size
//     limit like Firestore's 1MB, but the images are still kept small
//     (roughly 50-200KB) to keep page loads fast.
//   - Checkout, refunds, and clearing sales history all go through
//     Postgres functions (create_order / refund_sale / reset_sales_data
//     — see supabase-schema.sql) instead of the browser writing rows
//     directly. This is a meaningful security improvement over a naive
//     port: the browser only ever sends "product id + quantity" for a
//     checkout, never a price, so a customer editing their cart in
//     devtools cannot change what actually gets charged or recorded —
//     create_order() looks up the live price and live available stock
//     itself, inside the database, before writing anything. refund_sale()
//     and reset_sales_data() both check is_admin() (a real signed-in
//     *admin* session, per the `admins` table -- not just any signed-in
//     user, since buyers get real Supabase Auth sessions too) before
//     doing anything destructive.
//   - Row Level Security (see supabase-schema.sql) is the actual access
//     control layer, same role Firestore Security Rules played before.
//     The admin login uses real Supabase Auth (email + password). The
//     krafted_is_logged_in localStorage flag still exists purely so
//     protected pages can redirect instantly without a network
//     round-trip, but it is not what actually protects the data.
//   - The shopping cart stays in sessionStorage (per-tab, cleared on
//     checkout) since it's disposable, per-visit state.
//
// See supabase-config.js for the project connection settings, and
// SUPABASE_SETUP_GUIDE.md for how to create the project, run the schema,
// and create the admin account this file expects.

let cart = [];

// Local placeholder (no external dependency on via.placeholder.com, which
// could go down or change behavior unannounced). Same image is reused at
// whatever size the CSS renders it at, since SVG scales cleanly.
const PLACEHOLDER_IMAGE = "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">` +
    `<rect width="200" height="200" fill="#F3E2E6"/>` +
    `<text x="50%" y="50%" font-family="sans-serif" font-size="14" fill="#C06C84" text-anchor="middle" dominant-baseline="middle">No Image</text>` +
    `</svg>`
);

/* ==========================================================================
   SHARED PRODUCT CATEGORIES
   ========================================================================== */
// Single source of truth for the category list, used by the storefront
// filter, the inventory dashboard filter, and the maintenance panel's
// "Add Product" form.
const CATEGORIES = ['Sewn', 'Crochet'];

function populateCategorySelect(selectEl, { allOption = false, placeholder = null } = {}) {
    if (!selectEl) return;
    const optionsHTML = CATEGORIES.map(cat => `<option value="${escapeHTML(cat)}">${escapeHTML(cat)}</option>`).join('');
    let prefixHTML = '';
    if (placeholder) {
        prefixHTML = `<option value="" disabled selected>${escapeHTML(placeholder)}</option>`;
    } else if (allOption) {
        prefixHTML = `<option value="All">All Categories</option>`;
    }
    selectEl.innerHTML = prefixHTML + optionsHTML;
}

/* ==========================================================================
   GLOBAL UTILITIES & HELPERS
   ========================================================================== */

// Helper to escape dynamic HTML strings and prevent XSS attacks
function escapeHTML(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Global currency formatter for #,###.## layout
function formatCurrency(amount) {
    const num = parseFloat(amount);
    if (isNaN(num)) return "0.00";
    return new Intl.NumberFormat('en-PH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(num);
}

document.addEventListener('DOMContentLoaded', async () => {
    const pageType = document.body.getAttribute('data-page');

    // Protected pages (inventory, maintenance) are gated by the inline
    // <script> at the top of their HTML for an instant redirect, but that
    // only checks a localStorage flag, which anyone could set by hand.
    // The real gate is here: wait for Supabase to confirm there is an
    // actual signed-in admin session before doing anything with the data
    // on this page. Row Level Security backs this up server-side too, so
    // even this check being bypassed wouldn't grant write access.
    if (pageType === 'inventory' || pageType === 'maintenance') {
        const user = await waitForAuthUser();
        // Being signed in is not enough -- KRAFTEDregister.html creates
        // ordinary Supabase Auth accounts for customers using this same
        // auth system, so a signed-in buyer and a signed-in admin look
        // identical here unless we explicitly check admin status too.
        const admin = user ? await isCurrentUserAdmin() : false;
        if (!user || !admin) {
            if (user && !admin) {
                // A real (buyer) account, just not an admin one. Sign them
                // out so they don't get stuck in a half-logged-in state,
                // rather than silently bouncing them with no explanation.
                try { await sb.auth.signOut(); } catch (err) { console.error('Sign out error:', err); }
            }
            localStorage.removeItem('krafted_is_logged_in');
            window.location.replace('KRAFTEDlogin.html');
            return;
        }
    }

    if (pageType === 'login') {
        initLoginPage();
    } else if (pageType === 'register') {
        initRegisterPage();
    } else if (pageType === 'inventory') {
        await initInventoryPage();
    } else if (pageType === 'maintenance') {
        await initMaintenancePage();
    } else if (pageType === 'storefront') {
        await initStorefront();
    }

    // Shared logout link, present on the admin pages (inventory/
    // maintenance) as #logoutBtn. Storefront account logout is handled
    // separately in renderStorefrontAccountNav(), since it needs to stay
    // on the storefront afterwards rather than bounce to the admin login.
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try { await sb.auth.signOut(); } catch (err) { console.error('Sign out error:', err); }
            localStorage.removeItem('krafted_is_logged_in');
            window.location.href = 'KRAFTEDlogin.html';
        });
    }

    if (pageType === 'storefront') {
        await renderStorefrontAccountNav();
    }
});

/* ==========================================================================
   SUPABASE AUTH HELPER
   ========================================================================== */

// `sb` comes from supabase-config.js (loaded before this file).
async function waitForAuthUser() {
    try {
        const { data, error } = await sb.auth.getSession();
        if (error) { console.error('Error checking session:', error); return null; }
        return data.session ? data.session.user : null;
    } catch (e) {
        console.error('Error checking session:', e);
        return null;
    }
}

// Real admin check, backed by the `admins` table + is_admin() function in
// supabase-schema.sql -- not just "is someone signed in". A buyer account
// created via KRAFTEDregister.html has a valid session but no row in
// `admins`, so this correctly returns false for them.
async function isCurrentUserAdmin() {
    try {
        const { data, error } = await sb.rpc('is_admin');
        if (error) { console.error('Error checking admin status:', error); return false; }
        return data === true;
    } catch (e) {
        console.error('Error checking admin status:', e);
        return false;
    }
}

/* ==========================================================================
   ROW <-> APP-OBJECT MAPPING
   (Postgres columns are snake_case; the rest of this file works with the
   same camelCase shapes the old Firestore version used, so the render
   functions didn't need to change.)
   ========================================================================== */

function mapProductRow(row) {
    return {
        id: row.id,
        title: row.title,
        category: row.category,
        price: row.price !== undefined && row.price !== null ? parseFloat(row.price).toFixed(2) : '0.00',
        stock: row.stock,
        image: row.image,
        dateAdded: row.date_added
    };
}

function mapOrderRow(row) {
    return {
        orderId: row.order_id,
        date: row.order_date,
        items: row.items || [],
        total: row.total
    };
}

function mapSaleRow(row) {
    return {
        saleId: row.sale_id,
        transactionId: row.transaction_id,
        productId: row.product_id,
        productName: row.product_name,
        category: row.category,
        quantity: row.quantity,
        price: row.price,
        totalRevenue: row.total_revenue,
        soldAt: row.sold_at,
        refunded: row.refunded,
        refundedAt: row.refunded_at
    };
}

/* ==========================================================================
   DATA LAYER (Supabase)
   ========================================================================== */

// Simple in-memory cache, invalidated by the Realtime subscriptions set up
// in initStorefront/initInventoryPage. Keeps repeated cart clicks from
// re-querying the database every time.
let productsCache = null;
let ordersCache = null;

async function getStoredProducts() {
    if (productsCache) return productsCache;
    try {
        const { data, error } = await sb.from('products').select('*').order('id', { ascending: true });
        if (error) throw error;
        productsCache = (data || []).map(mapProductRow);
        return productsCache;
    } catch (e) {
        console.error("Error reading products from Supabase:", e);
        return [];
    }
}

// `products.id` is a Postgres identity column (auto-assigned), not
// supplied by the client -- avoids the old Date.now() approach, where two
// submissions in the same millisecond (a double-click, two admin tabs)
// could collide on the same id and fail the insert.
async function addProduct(product) {
    try {
        const { error } = await sb.from('products').insert({
            title: product.title,
            category: product.category,
            price: product.price,
            stock: product.stock,
            // Store null rather than the placeholder data-URI when no photo
            // was chosen -- the placeholder is a render-time fallback
            // (see mapProductRow / PLACEHOLDER_IMAGE usage), not real data
            // worth persisting on every image-less row.
            image: product.image === PLACEHOLDER_IMAGE ? null : product.image,
            date_added: product.dateAdded
        });
        if (error) throw error;
        return true;
    } catch (e) {
        console.error("Error saving product to Supabase:", e);
        alert("Save failed: could not reach the database, or you're not signed in. Check your connection and try again.");
        return false;
    }
}

async function deleteProductDoc(id) {
    try {
        const { error } = await sb.from('products').delete().eq('id', id);
        if (error) throw error;
        return true;
    } catch (e) {
        console.error("Error deleting product from Supabase:", e);
        alert("Delete failed: could not reach the database, or you're not signed in.");
        return false;
    }
}

async function getStoredOrders() {
    if (ordersCache) return ordersCache;
    try {
        const { data, error } = await sb.from('orders').select('*');
        if (error) throw error;
        ordersCache = (data || []).map(mapOrderRow);
        return ordersCache;
    } catch (e) {
        console.error("Error reading orders from Supabase:", e);
        return [];
    }
}

async function getStoredSalesLog() {
    try {
        const { data, error } = await sb.from('sales_log').select('*').order('sold_at', { ascending: false });
        if (error) throw error;
        return (data || []).map(mapSaleRow);
    } catch (e) {
        console.error("Error reading sales log from Supabase:", e);
        return [];
    }
}

// `orders` is passed in (already fetched by the caller) so this stays a
// cheap, synchronous helper instead of hitting the database on every call.
function calculateAvailableStock(product, orders) {
    if (!product) return 0;
    let unitsSold = 0;

    (orders || []).forEach(order => {
        if (Array.isArray(order.items)) {
            const match = order.items.find(i => String(i.id) === String(product.id) && !i.refunded);
            if (match) {
                unitsSold += parseInt(match.quantity, 10) || 0;
            }
        }
    });

    const initialStock = product.stock !== undefined ? parseInt(product.stock, 10) : 0;
    return Math.max(0, initialStock - unitsSold);
}

/* ==========================================================================
   IMAGE COMPRESSION (resize + re-encode before storing)
   ========================================================================== */

function compressImageFile(file, maxDimension = 900, quality = 0.75) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error('Could not read the selected file.'));
        reader.onload = (e) => {
            const img = new Image();
            img.onerror = () => reject(new Error('Could not decode the selected image.'));
            img.onload = () => {
                let { width, height } = img;
                if (width > maxDimension || height > maxDimension) {
                    if (width > height) {
                        height = Math.round(height * (maxDimension / width));
                        width = maxDimension;
                    } else {
                        width = Math.round(width * (maxDimension / height));
                        height = maxDimension;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);

                try {
                    resolve(canvas.toDataURL('image/jpeg', quality));
                } catch (err) {
                    reject(err);
                }
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

/* ==========================================================================
   STORAGE USAGE INDICATOR (Maintenance Panel)
   ========================================================================== */

async function refreshStorageUsageUI() {
    const bar = document.getElementById('storageUsageBar');
    const label = document.getElementById('storageUsageLabel');
    if (!bar || !label) return;

    if (navigator.storage && navigator.storage.estimate) {
        try {
            const { usage, quota } = await navigator.storage.estimate();
            const usageMB = (usage / (1024 * 1024)).toFixed(1);
            const quotaMB = (quota / (1024 * 1024)).toFixed(0);
            const pct = quota > 0 ? Math.min(100, (usage / quota) * 100) : 0;

            bar.style.width = pct.toFixed(1) + '%';
            bar.style.background = pct > 85 ? '#E74C3C' : (pct > 60 ? '#E67E22' : '#27AE60');
            label.textContent = `Using about ${usageMB} MB of ~${quotaMB} MB available in this browser (${pct.toFixed(1)}%).`;

            if (pct > 85) {
                label.textContent += ' Consider downloading a backup and clearing old sales history soon.';
            }
        } catch (e) {
            label.textContent = 'Storage usage information is unavailable in this browser.';
        }
    } else {
        label.textContent = 'Storage usage information is unavailable in this browser.';
    }
}

/* ==========================================================================
   FILTER HELPER FUNCTIONS
   ========================================================================== */

function passesFilters(product, orderDateStr = null) {
    const selectedCategory = document.getElementById('categoryFilter')?.value || 'All';

    if (selectedCategory.trim().toLowerCase() !== 'all') {
        const prodCat = (product.category || '').trim().toLowerCase();
        const targetCat = selectedCategory.trim().toLowerCase();
        if (prodCat !== targetCat) {
            return false;
        }
    }

    if (orderDateStr) {
        const startDateVal = document.getElementById('startDate')?.value;
        const endDateVal = document.getElementById('endDate')?.value;

        if (startDateVal || endDateVal) {
            const orderDate = new Date(orderDateStr);

            if (startDateVal) {
                const start = new Date(startDateVal + 'T00:00:00');
                if (orderDate < start) return false;
            }

            if (endDateVal) {
                const end = new Date(endDateVal + 'T23:59:59.999');
                if (orderDate > end) return false;
            }
        }
    }

    return true;
}

/* ==========================================================================
   STOREFRONT & CART LOGIC
   ========================================================================== */

function loadCartFromSession() {
    try {
        const saved = JSON.parse(sessionStorage.getItem('krafted_cart'));
        if (Array.isArray(saved)) cart = saved;
    } catch (e) {
        console.error("Error reading cart from sessionStorage:", e);
    }
}

function saveCartToSession() {
    try {
        sessionStorage.setItem('krafted_cart', JSON.stringify(cart));
    } catch (e) {
        console.error("Error saving cart to sessionStorage:", e);
    }
}

async function initStorefront() {
    populateCategorySelect(document.getElementById('categoryFilter'), { allOption: true });
    loadCartFromSession();
    await renderShop();
    updateCartUI();

    const categoryFilter = document.getElementById('categoryFilter');
    if (categoryFilter) {
        categoryFilter.addEventListener('change', (e) => {
            renderShop(e.target.value);
        });
    }

    const openCartBtn = document.getElementById('openCartBtn');
    const closeCartBtn = document.getElementById('closeCartBtn');
    const cartOverlay = document.getElementById('cartOverlay');
    const checkoutBtn = document.getElementById('checkoutBtn');

    if (openCartBtn) openCartBtn.addEventListener('click', toggleCart);
    if (closeCartBtn) closeCartBtn.addEventListener('click', toggleCart);
    if (cartOverlay) {
        cartOverlay.addEventListener('click', (e) => {
            if (e.target === cartOverlay) toggleCart();
        });
    }
    if (checkoutBtn) checkoutBtn.addEventListener('click', checkout);

    // Live updates via Supabase Realtime: if another customer buys the
    // last unit of something (or Anna adds/edits a product) while this
    // page is open, refresh the grid so stock counts stay accurate.
    // Postgres change events only carry the row that changed, not the
    // whole table, so the simplest correct approach is to drop the cache
    // and let the next render re-fetch.
    let refreshTimer = null;
    const scheduleRefresh = () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => renderShop(), 400);
    };

    sb.channel('storefront-products')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
            productsCache = null;
            scheduleRefresh();
        })
        .subscribe();

    sb.channel('storefront-orders')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
            ordersCache = null;
            scheduleRefresh();
        })
        .subscribe();
}

// Renders the storefront nav's account area: shows the Admin Panel link
// only to actual admins (is_admin(), not just "signed in" -- a signed-in
// buyer must not see a link that just bounces them to the admin login),
// and swaps Register/Login for a "Hi, {name}" + Logout once someone is
// signed in, whether that's a buyer or an admin browsing the storefront.
async function renderStorefrontAccountNav() {
    const adminPortalItem = document.getElementById('adminPortalItem');
    const buyerAuthItem = document.getElementById('buyerAuthItem');

    const user = await waitForAuthUser();

    if (!user) {
        if (adminPortalItem) adminPortalItem.style.display = 'none';
        if (buyerAuthItem) {
            buyerAuthItem.innerHTML =
                `<a href="KRAFTEDregister.html">Register</a>` +
                `<span class="nav-sep">·</span>` +
                `<a href="KRAFTEDlogin.html">Login</a>`;
        }
        return;
    }

    const admin = await isCurrentUserAdmin();
    if (adminPortalItem) adminPortalItem.style.display = admin ? 'block' : 'none';
    if (!buyerAuthItem) return;

    // Admin accounts don't have a `buyers` row, so fall back to their
    // email for the greeting; buyers get their chosen username.
    let label = user.email || 'Account';
    if (!admin) {
        try {
            const { data } = await sb.from('buyers').select('username').eq('id', user.id).maybeSingle();
            if (data && data.username) label = data.username;
        } catch (e) {
            console.error('Error loading buyer profile:', e);
        }
    }

    buyerAuthItem.innerHTML =
        `<span class="nav-account-label">Hi, ${escapeHTML(label)}</span>` +
        `<span class="nav-sep">·</span>` +
        `<a href="#" id="buyerLogoutBtn">Logout</a>`;

    document.getElementById('buyerLogoutBtn')?.addEventListener('click', async (e) => {
        e.preventDefault();
        try { await sb.auth.signOut(); } catch (err) { console.error('Sign out error:', err); }
        // Stay on the storefront (unlike the admin logout, which bounces
        // to the admin login page) -- a buyer signing out should just
        // land back on the shop, not on an admin-only form.
        window.location.href = 'KRAFTED.html';
    });
}

function filterShopCategory(products, categoryFilter = 'All') {
    const cleanFilter = categoryFilter.trim().toLowerCase();
    if (cleanFilter === 'all') return products;

    return products.filter(product =>
        (product.category || '').trim().toLowerCase() === cleanFilter
    );
}

async function renderShop(categoryFilter) {
    const productGrid = document.getElementById('productGrid');
    if (!productGrid) return;

    if (!categoryFilter) {
        const filterSelect = document.getElementById('categoryFilter');
        categoryFilter = filterSelect ? filterSelect.value : 'All';
    }

    const [allProducts, orders] = await Promise.all([getStoredProducts(), getStoredOrders()]);

    if (reconcileCartWithCatalog(allProducts, orders)) {
        updateCartUI();
    }

    const products = filterShopCategory(allProducts, categoryFilter);

    if (products.length === 0) {
        productGrid.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #8C7B7F; margin-top: 50px;">No items found in this category. Check back later!</p>`;
        return;
    }

    productGrid.innerHTML = products.map(product => {
        const availableStock = calculateAvailableStock(product, orders);
        const cartItem = cart.find(item => String(item.id) === String(product.id));
        const qtyInCart = cartItem ? cartItem.quantity : 0;
        const maxAddable = availableStock - qtyInCart;
        const canAddMore = maxAddable > 0;

        const safeTitle = escapeHTML(product.title);
        const safeCategory = escapeHTML(product.category || 'General');
        const safeImage = escapeHTML(product.image || PLACEHOLDER_IMAGE);
        const safeId = escapeHTML(String(product.id));

        return `
            <div class="product-card">
                <img src="${safeImage}" alt="${safeTitle}" class="product-img">
                <div class="product-info">
                    <span style="font-size: 0.7rem; background: #F8E2E7; color: #C06C84; padding: 2px 8px; border-radius: 10px; font-weight: 600;">
                        ${safeCategory}
                    </span>
                    <h3 style="margin: 5px 0;">${safeTitle}</h3>
                    <div class="price">₱${formatCurrency(product.price)}</div>

                    <div style="font-size: 0.75rem; color: ${availableStock === 0 ? '#E74C3C' : '#8C7B7F'}; margin-bottom: 10px; font-weight: 600;">
                        ${availableStock > 0 ? `${availableStock} units available` : 'Out of Stock'}
                    </div>

                    <div class="card-qty-panel" ${!canAddMore ? 'style="opacity: 0.5; pointer-events: none;"' : ''}>
                        <button class="card-qty-btn" onclick="updateLocalQty(this, -1, ${maxAddable})">-</button>
                        <span class="card-qty-val" data-product-id="${safeId}">1</span>
                        <button class="card-qty-btn" onclick="updateLocalQty(this, 1, ${maxAddable})">+</button>
                    </div>

                    <button class="btn-add-cart" onclick="addToCart('${safeId}', ${maxAddable})" ${!canAddMore ? 'disabled style="background-color: #D3C5C8; cursor: not-allowed;"' : ''}>
                        ${canAddMore ? 'Add to Cart' : (availableStock === 0 ? 'Sold Out' : 'Max Limit')}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

window.updateLocalQty = function(btn, delta, maxLimit) {
    const valSpan = btn.parentElement.querySelector('.card-qty-val');
    if (!valSpan) return;

    let current = parseInt(valSpan.textContent, 10) || 1;
    let newVal = current + delta;

    if (newVal < 1) newVal = 1;
    if (newVal > maxLimit) newVal = maxLimit;

    valSpan.textContent = newVal;
};

window.addToCart = async function(productId, maxAddable) {
    const products = await getStoredProducts();
    const product = products.find(p => String(p.id) === String(productId));
    if (!product) return;

    const valSpan = document.querySelector(`.card-qty-val[data-product-id="${productId}"]`);
    const qtyToAdd = valSpan ? parseInt(valSpan.textContent, 10) : 1;

    if (qtyToAdd > maxAddable) {
        alert("Not enough stock available.");
        return;
    }

    const existingCartItem = cart.find(item => String(item.id) === String(productId));

    if (existingCartItem) {
        existingCartItem.quantity += qtyToAdd;
    } else {
        cart.push({
            id: product.id,
            title: product.title,
            category: product.category,
            price: product.price,
            image: product.image,
            quantity: qtyToAdd
        });
    }

    updateCartUI();
    await renderShop();
};

// Keeps the in-memory cart honest against the live catalog: refreshes
// price/title/image if they've changed since the item was added, drops
// items whose product was deleted, and clamps quantity down to whatever
// stock is actually still available (e.g. after a failed checkout, or
// another customer buying the last units while this cart sat open).
// Called every time the shop grid renders, so the cart total shown in the
// drawer never silently drifts from what create_order() will actually
// charge. Returns true if anything changed (caller should re-render the
// cart UI).
function reconcileCartWithCatalog(products, orders) {
    const before = JSON.stringify(cart);

    cart = cart
        .map(item => {
            const product = products.find(p => String(p.id) === String(item.id));
            if (!product) return null; // product deleted from catalog

            const availableStock = calculateAvailableStock(product, orders);
            const clampedQty = Math.min(item.quantity, availableStock);

            return clampedQty > 0
                ? { ...item, price: product.price, title: product.title, category: product.category, image: product.image, quantity: clampedQty }
                : null;
        })
        .filter(Boolean);

    const changed = JSON.stringify(cart) !== before;
    if (changed) saveCartToSession();
    return changed;
}

function toggleCart() {
    const overlay = document.getElementById('cartOverlay');
    if (overlay) overlay.classList.toggle('active');
}

window.updateCartQuantity = async function(productId, delta) {
    const itemIndex = cart.findIndex(item => String(item.id) === String(productId));
    if (itemIndex > -1) {
        const item = cart[itemIndex];
        const [products, orders] = await Promise.all([getStoredProducts(), getStoredOrders()]);
        const product = products.find(p => String(p.id) === String(productId));
        const availableStock = calculateAvailableStock(product, orders);

        const newQty = item.quantity + delta;

        if (newQty > availableStock) {
            alert("Maximum stock reached for this item.");
            return;
        }

        if (newQty <= 0) {
            cart.splice(itemIndex, 1);
        } else {
            item.quantity = newQty;
        }

        updateCartUI();
        await renderShop();
    }
};

function updateCartUI() {
    const container = document.getElementById('cartItemsList');
    const countDisplay = document.getElementById('navCartCount');
    const totalDisplay = document.getElementById('cartTotalPrice');

    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    if (countDisplay) countDisplay.textContent = totalItems;

    if (cart.length === 0) {
        if (container) container.innerHTML = `<p style="text-align:center; color: var(--text-light, #8C7B7F); margin-top:20px;">Your cart is currently empty.</p>`;
        if (totalDisplay) totalDisplay.textContent = "₱0.00";
        return;
    }

    let grandTotal = 0;

    if (container) {
        container.innerHTML = cart.map(item => {
            const itemTotal = item.quantity * parseFloat(item.price);
            grandTotal += itemTotal;

            const safeTitle = escapeHTML(item.title);
            const safeImage = escapeHTML(item.image || PLACEHOLDER_IMAGE);
            const safeId = escapeHTML(String(item.id));

            return `
                <div class="cart-item">
                    <img src="${safeImage}" class="cart-item-img" alt="${safeTitle}">
                    <div class="cart-item-details">
                        <h4>${safeTitle}</h4>
                        <div class="item-price">₱${formatCurrency(item.price)}</div>
                        <div class="qty-controls">
                            <button class="qty-btn" onclick="updateCartQuantity('${safeId}', -1)">-</button>
                            <span style="font-size: 0.85rem; font-weight: 600;">${item.quantity}</span>
                            <button class="qty-btn" onclick="updateCartQuantity('${safeId}', 1)">+</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    if (totalDisplay) totalDisplay.textContent = `₱${formatCurrency(grandTotal)}`;
    saveCartToSession();
}

// Checkout no longer builds the order client-side. It sends only
// {id, quantity} pairs to the create_order() database function, which
// looks up live price + live available stock itself and writes the order
// + sales-log rows in one atomic step. See supabase-schema.sql.
async function checkout() {
    if (cart.length === 0) {
        alert("Your cart is empty!");
        return;
    }

    const payloadItems = cart.map(item => ({ id: item.id, quantity: item.quantity }));

    const { data, error } = await sb.rpc('create_order', { p_items: payloadItems });

    if (error) {
        alert("Checkout could not be completed:\n\n" + (error.message || "Please check your connection and try again.") + "\n\nYour cart has been refreshed against current stock.");
        productsCache = null;
        ordersCache = null;
        await renderShop();
        updateCartUI();
        return;
    }

    alert(`Thank you for your purchase!\nOrder ID: ${data.order_id}\nTotal: ₱${formatCurrency(data.total)}`);

    cart = [];
    updateCartUI();
    productsCache = null;
    ordersCache = null;
    await renderShop();
    toggleCart();
}

/* ==========================================================================
   AUTHENTICATION LOGIC
   ========================================================================== */

// One form (KRAFTEDlogin.html) now serves both admin and customer
// sign-in -- previously these were two separate pages/handlers
// (initLoginPage + initBuyerLoginPage) that were nearly identical except
// for which element ids they read and where they redirected afterward.
// Merging them removes that duplication and reflects how auth actually
// works here: is_admin() is a server-side fact about the account, not
// something tied to which login form you happened to land on. Any valid
// Supabase Auth account can sign in here; where it lands afterward
// depends on whether that account has a row in the `admins` table.
function initLoginPage() {
    const loginForm = document.getElementById('loginForm');
    if (!loginForm) return;

    const messageEl = document.getElementById('loginMessage');
    const showMessage = (text) => {
        if (!messageEl) { alert(text); return; }
        messageEl.textContent = text;
        messageEl.className = 'form-message error';
    };
    const clearMessage = () => {
        if (!messageEl) return;
        messageEl.textContent = '';
        messageEl.className = 'form-message';
    };

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearMessage();

        const emailInput = document.getElementById('username')?.value.trim();
        // Don't trim the password -- a leading/trailing space could be
        // part of the actual password, and silently stripping it would
        // just make a correct password fail to match.
        const passwordInput = document.getElementById('password')?.value;
        const submitBtn = loginForm.querySelector('button[type="submit"]');

        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Signing In…'; }

        try {
            // Real authentication against Supabase Auth -- not a check
            // against a value sitting in this file. Works for the single
            // admin account (created in the Supabase Dashboard, see
            // SUPABASE_SETUP_GUIDE.md) and for ordinary buyer accounts
            // (created via KRAFTEDregister.html) alike.
            const { error } = await sb.auth.signInWithPassword({ email: emailInput, password: passwordInput });
            if (error) throw error;

            // Correct credentials only prove this is SOME valid Supabase
            // Auth account. Whether it's an admin is a separate, real fact
            // (a row in the `admins` table, checked server-side) -- not
            // something this form assumes based on itself.
            const admin = await isCurrentUserAdmin();

            if (admin) {
                localStorage.setItem('krafted_is_logged_in', 'true');
                window.location.href = 'KRAFTEDMP.html';
            } else {
                // Not an admin account -- just an ordinary signed-in
                // customer. Nothing wrong with that; send them to the
                // shop rather than treating it as a failed login.
                localStorage.removeItem('krafted_is_logged_in');
                window.location.href = 'KRAFTED.html';
            }
        } catch (err) {
            console.error('Login error:', err);
            showMessage('Invalid email or password.');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Log In'; }
        }
    });
}

/* ==========================================================================
   BUYER REGISTRATION LOGIC
   ========================================================================== */

function initRegisterPage() {
    const registerForm = document.getElementById('registerForm');
    if (!registerForm) return;

    const messageEl = document.getElementById('formMessage');

    const showMessage = (text, type) => {
        if (!messageEl) { alert(text); return; }
        messageEl.textContent = text;
        messageEl.className = 'form-message ' + (type || '');
    };

    const clearMessage = () => {
        if (!messageEl) return;
        messageEl.textContent = '';
        messageEl.className = 'form-message';
    };

    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearMessage();

        const email = document.getElementById('regEmail')?.value.trim() || '';
        const username = document.getElementById('regUsername')?.value.trim() || '';
        const password = document.getElementById('regPassword')?.value || '';
        const confirmPassword = document.getElementById('regConfirmPassword')?.value || '';
        const contactNumber = document.getElementById('regContact')?.value.trim() || '';

        if (!email || !username || !password || !confirmPassword || !contactNumber) {
            showMessage('Please fill in every field.', 'error');
            return;
        }

        if (username.length < 3) {
            showMessage('Username must be at least 3 characters.', 'error');
            return;
        }

        if (password.length < 6) {
            showMessage('Password must be at least 6 characters.', 'error');
            return;
        }

        if (password !== confirmPassword) {
            showMessage('Passwords do not match.', 'error');
            return;
        }

        const contactDigits = contactNumber.replace(/[^0-9]/g, '');
        if (contactDigits.length < 7) {
            showMessage('Please enter a valid contact number.', 'error');
            return;
        }

        const submitBtn = registerForm.querySelector('button[type="submit"]');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating Account…'; }

        try {
            // Narrow availability check -- buyers' profile rows aren't
            // publicly readable (see supabase-schema.sql), so this goes
            // through a dedicated RPC rather than querying the table
            // directly.
            const { data: taken, error: checkError } = await sb.rpc('username_is_taken', { p_username: username });
            if (checkError) throw checkError;
            if (taken) {
                showMessage('That username is already taken. Please choose another.', 'error');
                return;
            }

            // Username + contact number ride along as auth metadata; a
            // database trigger (handle_new_buyer, see supabase-schema.sql)
            // copies them into the buyers table the moment this account
            // is created -- so it works whether or not email confirmation
            // is required before a session comes back.
            const { data, error } = await sb.auth.signUp({
                email,
                password,
                options: {
                    data: {
                        username: username,
                        contact_number: contactNumber
                    }
                }
            });

            if (error) throw error;

            if (data.session) {
                showMessage('Account created! You are now signed in. Redirecting to the shop…', 'success');
                setTimeout(() => { window.location.href = 'KRAFTED.html'; }, 1500);
            } else {
                showMessage('Account created! Please check your email to confirm your account before logging in.', 'success');
                registerForm.reset();
            }
        } catch (err) {
            console.error('Registration error:', err);
            let msg = err.message || 'Registration failed. Please try again.';
            if (/already registered|already exists|user already/i.test(msg)) {
                msg = 'An account with that email already exists.';
            }
            showMessage(msg, 'error');
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Account'; }
        }
    });
}

/* ==========================================================================
   MAINTENANCE PANEL LOGIC
   ========================================================================== */

async function initMaintenancePage() {
    const productForm = document.getElementById('productForm');
    populateCategorySelect(document.getElementById('prodCategory'), { placeholder: 'Select Category' });
    await renderMaintenanceTable();
    refreshStorageUsageUI();
    await initSuperAdminPanel();

    if (productForm) {
        productForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const title = document.getElementById('prodTitle')?.value || '';
            const category = document.getElementById('prodCategory') ? document.getElementById('prodCategory').value : 'Uncategorized';
            const price = document.getElementById('prodPrice')?.value || 0;
            const stockInput = document.getElementById('prodStock')?.value || 0;
            const imageInput = document.getElementById('prodImage');

            let newStock = parseInt(stockInput, 10);
            if (isNaN(newStock) || newStock < 0) newStock = 0;

            let imageStr = PLACEHOLDER_IMAGE;
            if (imageInput && imageInput.files && imageInput.files[0]) {
                const file = imageInput.files[0];
                const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024; // 10MB original file cap
                if (file.size > MAX_ORIGINAL_BYTES) {
                    alert("That photo is too large (over 10MB). Please choose a smaller image.");
                    return;
                }

                try {
                    imageStr = await compressImageFile(file, 900, 0.75);
                } catch (err) {
                    console.error('Image compression failed, falling back to original file:', err);
                    imageStr = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = (ev) => resolve(ev.target.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(file);
                    });
                }
            }

            await saveProductToCatalog(title, category, price, newStock, imageStr);
        });
    }
}

/* ==========================================================================
   MAIN ADMIN PANEL (Admin Team + User Accounts)
   Only rendered/visible for the super admin (is_super_admin()). Every
   action still re-checks super-admin status server-side inside the RPC
   functions themselves (see supabase-schema.sql) -- hiding the section
   here is a UI convenience for co-admins, not the actual access control.
   ========================================================================== */

async function initSuperAdminPanel() {
    const section = document.getElementById('superAdminSection');
    if (!section) return;

    let isSuper = false;
    try {
        const { data, error } = await sb.rpc('is_super_admin');
        if (error) throw error;
        isSuper = data === true;
    } catch (e) {
        console.error('Error checking main admin status:', e);
        return;
    }

    if (!isSuper) return; // stays hidden for co-admins

    section.style.display = 'block';

    await Promise.all([renderAdminTeamTable(), renderUserAccountsTable()]);

    const addAdminForm = document.getElementById('addAdminForm');
    if (addAdminForm) {
        addAdminForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const emailInput = document.getElementById('newAdminEmail');
            const email = emailInput?.value.trim();
            if (!email) return;

            const submitBtn = addAdminForm.querySelector('button[type="submit"]');
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Adding…'; }

            try {
                const { error } = await sb.rpc('promote_to_admin', { p_email: email });
                if (error) throw error;
                addAdminForm.reset();
                await Promise.all([renderAdminTeamTable(), renderUserAccountsTable()]);
            } catch (err) {
                console.error('Error adding co-admin:', err);
                alert('Could not add co-admin: ' + (err.message || 'please try again.'));
            } finally {
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add Co-Admin'; }
            }
        });
    }
}

async function renderAdminTeamTable() {
    const tbody = document.getElementById('adminTeamTableBody');
    if (!tbody) return;

    try {
        const { data, error } = await sb.rpc('list_admins');
        if (error) throw error;

        if (!data || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">No admins found.</td></tr>';
            return;
        }

        tbody.innerHTML = data.map(row => {
            const safeEmail = escapeHTML(row.email || 'Unknown');
            const safeId = escapeHTML(String(row.id));
            const isSuperRow = row.role === 'super_admin';
            const formattedDate = row.created_at
                ? new Date(row.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                : 'N/A';

            const roleBadge = isSuperRow
                ? '<span class="role-badge super">Main Admin</span>'
                : '<span class="role-badge admin">Co-Admin</span>';

            const actionCell = isSuperRow
                ? '<span class="locked-note">This is you</span>'
                : `<button class="btn-action remove" onclick="removeCoAdmin('${safeId}')">Remove</button>`;

            return `
                <tr>
                    <td>${safeEmail}</td>
                    <td>${roleBadge}</td>
                    <td style="font-size:0.85rem; color:#8C7B7F;">${formattedDate}</td>
                    <td>${actionCell}</td>
                </tr>
            `;
        }).join('');
    } catch (e) {
        console.error('Error loading admin team:', e);
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#c0392b;">Could not load admin team.</td></tr>';
    }
}

async function renderUserAccountsTable() {
    const tbody = document.getElementById('userAccountsTableBody');
    if (!tbody) return;

    try {
        const { data, error } = await sb.rpc('list_platform_users');
        if (error) throw error;

        if (!data || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">No accounts found.</td></tr>';
            return;
        }

        tbody.innerHTML = data.map(row => {
            const safeEmail = escapeHTML(row.email || 'Unknown');
            const safeUsername = row.username ? ` <span style="color:#8C7B7F;">(${escapeHTML(row.username)})</span>` : '';
            const safeId = escapeHTML(String(row.id));
            const isSuperRow = row.admin_role === 'super_admin';

            let typeBadge;
            if (isSuperRow) typeBadge = '<span class="role-badge super">Main Admin</span>';
            else if (row.admin_role === 'admin') typeBadge = '<span class="role-badge admin">Co-Admin</span>';
            else typeBadge = '<span class="role-badge buyer">Buyer</span>';

            const statusBadge = row.banned
                ? '<span class="status-badge disabled">Disabled</span>'
                : '<span class="status-badge active">Active</span>';

            const formattedDate = row.created_at
                ? new Date(row.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                : 'N/A';

            let actionCell;
            if (isSuperRow) {
                actionCell = '<span class="locked-note">This is you</span>';
            } else {
                const toggleBtn = row.banned
                    ? `<button class="btn-action enable" onclick="toggleUserBanned('${safeId}', true)">Enable</button>`
                    : `<button class="btn-action disable" onclick="toggleUserBanned('${safeId}', false)">Disable</button>`;
                const deleteBtn = `<button class="btn-action remove" onclick="deleteUserAccount('${safeId}')">Delete</button>`;
                actionCell = toggleBtn + deleteBtn;
            }

            return `
                <tr${row.banned ? ' style="opacity:0.6;"' : ''}>
                    <td>${safeEmail}${safeUsername}</td>
                    <td>${typeBadge}</td>
                    <td>${statusBadge}</td>
                    <td style="font-size:0.85rem; color:#8C7B7F;">${formattedDate}</td>
                    <td>${actionCell}</td>
                </tr>
            `;
        }).join('');
    } catch (e) {
        console.error('Error loading user accounts:', e);
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#c0392b;">Could not load user accounts.</td></tr>';
    }
}

window.removeCoAdmin = async function(adminId) {
    if (!confirm('Remove this co-admin? They will keep their account and can still shop as a regular customer, but will lose access to the Maintenance Panel and Inventory Dashboard.')) {
        return;
    }
    try {
        const { error } = await sb.rpc('demote_admin', { p_admin_id: adminId });
        if (error) throw error;
        await Promise.all([renderAdminTeamTable(), renderUserAccountsTable()]);
    } catch (e) {
        console.error('Error removing co-admin:', e);
        alert('Could not remove co-admin: ' + (e.message || 'please try again.'));
    }
};

// currentlyBanned is the state BEFORE this click, so the RPC is told the
// opposite: click "Disable" (currentlyBanned=false) -> set banned=true.
window.toggleUserBanned = async function(userId, currentlyBanned) {
    const willBan = !currentlyBanned;
    const confirmMsg = willBan
        ? 'Disable this account? They will be unable to sign in until you re-enable it. Their data is not affected.'
        : 'Re-enable this account? They will be able to sign in again immediately.';

    if (!confirm(confirmMsg)) return;

    try {
        const { error } = await sb.rpc('set_user_banned', { p_user_id: userId, p_banned: willBan });
        if (error) throw error;
        await renderUserAccountsTable();
    } catch (e) {
        console.error('Error updating account status:', e);
        alert('Could not update this account: ' + (e.message || 'please try again.'));
    }
};

window.deleteUserAccount = async function(userId) {
    if (!confirm('Permanently delete this account?\n\nThis removes their login and admin/buyer profile entirely. Past orders and sales history are NOT affected. This cannot be undone.')) {
        return;
    }
    try {
        const { error } = await sb.rpc('delete_platform_user', { p_user_id: userId });
        if (error) throw error;
        await Promise.all([renderAdminTeamTable(), renderUserAccountsTable()]);
    } catch (e) {
        console.error('Error deleting account:', e);
        alert('Could not delete this account: ' + (e.message || 'please try again.'));
    }
};

async function saveProductToCatalog(title, category, price, stock, imageStr) {
    const newProduct = {
        title: title,
        category: category,
        price: parseFloat(price).toFixed(2),
        stock: stock,
        image: imageStr,
        dateAdded: new Date().toISOString()
    };

    const saved = await addProduct(newProduct);
    if (!saved) return;

    const productForm = document.getElementById('productForm');
    if (productForm) productForm.reset();

    productsCache = null;
    await renderMaintenanceTable();
    refreshStorageUsageUI();
}

async function renderMaintenanceTable() {
    const tbody = document.getElementById('maintenanceTableBody');
    if (!tbody) return;

    const products = await getStoredProducts();

    if (products.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No items added to catalog yet.</td></tr>';
        return;
    }

    tbody.innerHTML = products.map(item => {
        const formattedDate = item.dateAdded
            ? new Date(item.dateAdded).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
            : 'N/A';

        const safeTitle = escapeHTML(item.title);
        const safeCategory = escapeHTML(item.category || 'N/A');
        const safeImage = escapeHTML(item.image || PLACEHOLDER_IMAGE);
        const safeId = escapeHTML(String(item.id));

        return `
            <tr>
                <td style="display: flex; align-items: center; gap: 10px;">
                    <img src="${safeImage}" style="width: 40px; height: 40px; object-fit: cover; border-radius: 6px;" alt="${safeTitle}">
                    <strong>${safeTitle}</strong>
                </td>
                <td><span style="background: #F8E2E7; color: #C06C84; padding: 3px 8px; border-radius: 12px; font-size: 0.8rem; font-weight: 600;">${safeCategory}</span></td>
                <td>₱${formatCurrency(item.price)}</td>
                <td>${item.stock !== undefined ? item.stock : 0} Units</td>
                <td style="font-size: 0.85rem; color: #8C7B7F;">${formattedDate}</td>
                <td>
                    <button onclick="deleteProduct('${safeId}')" style="background: #E74C3C; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold;">Remove</button>
                </td>
            </tr>
        `;
    }).join('');
}

window.downloadBackup = async function() {
    const backup = {
        exportedAt: new Date().toISOString(),
        format: 'krafted-backup-v3-supabase',
        products: await getStoredProducts(),
        orders: await getStoredOrders(),
        salesLog: await getStoredSalesLog()
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dateStamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `krafted-backup-${dateStamp}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};

// Restoring now goes through the restore_backup() database function in a
// single transaction, instead of three separate client-side delete+insert
// round trips. That old approach could leave the store in a half-restored
// state (e.g. orders wiped but sales_log restore failing partway through)
// if the connection dropped mid-way; this way it's all-or-nothing.
window.restoreBackup = function(file) {
    if (!file) return;

    if (!confirm('Restoring will REPLACE your current catalog, orders, and sales log with the contents of this backup file. Continue?')) {
        document.getElementById('restoreFileInput').value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);

            if (!Array.isArray(data.products) || !Array.isArray(data.orders) || !Array.isArray(data.salesLog)) {
                throw new Error('Backup file is missing expected data.');
            }

            // Backups from the old Firebase version (or earlier) may still
            // carry a duplicated `image` field on order items / sales
            // entries -- strip it on the way in so restoring doesn't
            // reintroduce old storage bloat. Missing `saleId` is backfilled.
            const cleanedOrders = data.orders.map(order => ({
                ...order,
                items: Array.isArray(order.items)
                    ? order.items.map(({ image, ...rest }) => rest)
                    : order.items
            }));
            const cleanedSales = data.salesLog.map((sale, idx) => {
                const { image, ...rest } = sale;
                return {
                    saleId: sale.saleId || ((sale.transactionId || 'legacy') + '-' + (sale.productId || 'x') + '-' + idx),
                    ...rest
                };
            });

            const { error } = await sb.rpc('restore_backup', {
                p_products: data.products,
                p_orders: cleanedOrders,
                p_sales_log: cleanedSales
            });
            if (error) throw error;

            productsCache = null;
            ordersCache = null;

            alert('Backup restored successfully.');
            await renderMaintenanceTable();
            refreshStorageUsageUI();
        } catch (err) {
            console.error('Error restoring backup:', err);
            alert('Could not restore this file: ' + (err.message || 'it does not look like a valid KRAFTED backup.'));
        } finally {
            document.getElementById('restoreFileInput').value = '';
        }
    };
    reader.readAsText(file);
};

window.deleteProduct = async function(id) {
    if (confirm('Remove this product from the shop catalog?')) {
        await deleteProductDoc(id);
        productsCache = null;

        if (document.body.getAttribute('data-page') === 'maintenance') {
            await renderMaintenanceTable();
            refreshStorageUsageUI();
        }
    }
};

/* ==========================================================================
   INVENTORY & SALES DASHBOARD LOGIC
   ========================================================================== */

async function initInventoryPage() {
    populateCategorySelect(document.getElementById('categoryFilter'), { allOption: true });
    await renderInventoryDashboard();

    // Live updates: a sale made from a customer's phone, or another admin
    // session, shows up here without needing a manual reload.
    let refreshTimer = null;
    const scheduleRefresh = () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => renderInventoryDashboard(), 400);
    };

    sb.channel('inventory-products')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
            productsCache = null;
            scheduleRefresh();
        })
        .subscribe();

    sb.channel('inventory-orders')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
            ordersCache = null;
            scheduleRefresh();
        })
        .subscribe();

    sb.channel('inventory-sales')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sales_log' }, () => {
            scheduleRefresh();
        })
        .subscribe();
}

async function renderInventoryDashboard() {
    const [products, orders, salesLog] = await Promise.all([
        getStoredProducts(),
        getStoredOrders(),
        getStoredSalesLog()
    ]);

    const productsById = new Map(products.map(p => [String(p.id), p]));

    const categoryFilter = document.getElementById('categoryFilter')?.value || 'All';
    const startDateVal = document.getElementById('startDate')?.value;
    const endDateVal = document.getElementById('endDate')?.value;

    const tableBody = document.getElementById('inventoryTableBody');
    const salesLogTbody = document.getElementById('salesLogTableBody');
    const metricProductCount = document.getElementById('metricProductCount');
    const metricTotalSales = document.getElementById('metricTotalSales');
    const metricTotalQty = document.getElementById('metricTotalQty');
    const metricTotalStock = document.getElementById('metricTotalStock');
    const metricTotalRefunded = document.getElementById('metricTotalRefunded');

    const filteredProducts = products.filter(product => passesFilters(product));

    if (metricProductCount) metricProductCount.textContent = filteredProducts.length;

    let grossRevenue = 0;
    let totalItemsSold = 0;
    let globalStockAvail = 0;

    if (tableBody) {
        if (filteredProducts.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding: 25px; color: #8C7B7F;">No products found matching the criteria.</td></tr>`;
        } else {
            const productStats = filteredProducts.map(product => {
                // "Units sold" / "Revenue" for the table are scoped to
                // whatever date range is selected -- that's the whole
                // point of the filter.
                let unitsSoldInRange = 0;
                orders.forEach(order => {
                    if (passesFilters(product, order.date)) {
                        if (Array.isArray(order.items)) {
                            const match = order.items.find(i => String(i.id) === String(product.id) && !i.refunded);
                            if (match) {
                                unitsSoldInRange += parseInt(match.quantity, 10) || 0;
                            }
                        }
                    }
                });

                const itemPrice = parseFloat(product.price) || 0;
                const revenue = unitsSoldInRange * itemPrice;

                // "Stock Available" must always reflect ALL-TIME sales,
                // never just the units sold within the selected date
                // range -- otherwise filtering to e.g. "today" would make
                // stock look artificially high, since sales from before
                // today would stop being subtracted. calculateAvailableStock
                // deliberately ignores the date filter for this reason.
                const currentStock = calculateAvailableStock(product, orders);

                grossRevenue += revenue;
                totalItemsSold += unitsSoldInRange;
                globalStockAvail += currentStock;

                return {
                    ...product,
                    unitsSold: unitsSoldInRange,
                    currentStock,
                    revenue
                };
            });

            tableBody.innerHTML = productStats.map(item => {
                const formattedDate = item.dateAdded
                    ? new Date(item.dateAdded).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                    : 'N/A';

                const safeTitle = escapeHTML(item.title);
                const safeCategory = escapeHTML(item.category || 'N/A');
                const safeImage = escapeHTML(item.image || PLACEHOLDER_IMAGE);

                return `
                    <tr>
                        <td>
                            <div class="product-cell">
                                <img src="${safeImage}" class="table-img" alt="${safeTitle}">
                                <span>${safeTitle}</span>
                            </div>
                        </td>
                        <td>
                            <span class="badge-category">${safeCategory}</span>
                        </td>
                        <td class="text-right">₱${formatCurrency(item.price)}</td>
                        <td class="text-center">
                            <span class="${item.currentStock <= 2 ? 'badge-low-stock' : 'badge-stock'}">
                                ${item.currentStock} Units
                            </span>
                        </td>
                        <td class="text-center">
                            <span class="badge-sales">${item.unitsSold}</span>
                        </td>
                        <td class="text-center" style="font-size: 0.85rem; color: #8C7B7F;">
                            ${formattedDate}
                        </td>
                        <td class="text-right" style="font-weight: 600; color: #5C4A4E;">
                            ₱${formatCurrency(item.revenue)}
                        </td>
                    </tr>
                `;
            }).join('');
        }
    }

    // Orders (not sales_log rows) are the source of truth for whether every
    // item in a transaction has been refunded/cancelled -- used below to
    // decide whether to show "Cancel Transaction" or an already-cancelled
    // badge for a given order, and to only show it once per order even
    // though sales_log has one row per line item.
    const ordersById = new Map(orders.map(o => [o.orderId, o]));
    const seenTransactionIds = new Set();

    let filteredSales = salesLog.filter(sale => {
        let matchCategory = (categoryFilter.trim().toLowerCase() === 'all' || (sale.category || '').trim().toLowerCase() === categoryFilter.trim().toLowerCase());

        let saleDate = new Date(sale.soldAt).getTime();
        let start = startDateVal ? new Date(startDateVal + 'T00:00:00').getTime() : null;
        let end = endDateVal ? new Date(endDateVal + 'T23:59:59.999').getTime() : null;

        let matchStart = start ? saleDate >= start : true;
        let matchEnd = end ? saleDate <= end : true;

        return matchCategory && matchStart && matchEnd;
    });

    if (salesLogTbody) {
        if (filteredSales.length === 0) {
            salesLogTbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding: 25px; color: #8C7B7F;">No individual sales transactions logged for the selected period.</td></tr>`;
            if (metricTotalRefunded) metricTotalRefunded.textContent = `₱${formatCurrency(0)}`;
        } else {
            let totalRefunded = 0;

            salesLogTbody.innerHTML = filteredSales.map(sale => {
                const formattedDate = new Date(sale.soldAt).toLocaleString([], {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });

                const relatedProduct = productsById.get(String(sale.productId));
                const displayName = sale.productName || (relatedProduct ? relatedProduct.title : 'Deleted Product');
                const displayCategory = sale.category || (relatedProduct ? relatedProduct.category : 'N/A');
                const displayImage = (relatedProduct && relatedProduct.image) || PLACEHOLDER_IMAGE;

                const safeName = escapeHTML(displayName);
                const safeCategory = escapeHTML(displayCategory || 'N/A');
                const safeImage = escapeHTML(displayImage);
                const safeTxnId = escapeHTML(sale.transactionId || 'N/A');
                const safeProductId = escapeHTML(String(sale.productId));

                if (sale.refunded) {
                    totalRefunded += parseFloat(sale.totalRevenue) || 0;
                }

                const itemActionCell = sale.refunded
                    ? `<span class="badge-refunded">Refunded</span>`
                    : `<button class="btn-refund" onclick="refundSale('${safeTxnId}', '${safeProductId}')">Refund</button>`;

                // Whole-order cancel control: an order can have several
                // sales_log rows (one per product), but the button that
                // voids all of them at once should only appear next to
                // the FIRST row for that order, not repeated on every line.
                let orderActionCell = '';
                const isFirstRowForOrder = sale.transactionId && !seenTransactionIds.has(sale.transactionId);
                if (isFirstRowForOrder) {
                    seenTransactionIds.add(sale.transactionId);
                    const relatedOrder = ordersById.get(sale.transactionId);
                    const orderFullyCancelled = relatedOrder
                        && Array.isArray(relatedOrder.items)
                        && relatedOrder.items.length > 0
                        && relatedOrder.items.every(i => i.refunded);

                    orderActionCell = orderFullyCancelled
                        ? `<div class="order-action-note">Transaction Cancelled</div>`
                        : `<div class="order-action-note"><button class="btn-cancel-order" onclick="cancelOrder('${safeTxnId}')">Cancel Transaction</button></div>`;
                }

                return `
                    <tr${sale.refunded ? ' style="opacity: 0.55;"' : ''}>
                        <td>
                            <strong>${safeTxnId}</strong><br>
                            <span class="text-muted">${formattedDate}</span>
                        </td>
                        <td>
                            <div class="product-cell">
                                <img src="${safeImage}" class="table-img" alt="${safeName}">
                                <span>${safeName}</span>
                            </div>
                        </td>
                        <td><span class="badge-category">${safeCategory}</span></td>
                        <td class="text-center"><span class="badge-sales">+${sale.quantity}</span></td>
                        <td class="text-right">₱${formatCurrency(sale.price)}</td>
                        <td class="text-right"><strong>₱${formatCurrency(sale.totalRevenue)}</strong></td>
                        <td class="text-center">${itemActionCell}${orderActionCell}</td>
                    </tr>
                `;
            }).join('');

            if (metricTotalRefunded) metricTotalRefunded.textContent = `₱${formatCurrency(totalRefunded)}`;
        }
    }

    if (metricTotalSales) metricTotalSales.textContent = `₱${formatCurrency(grossRevenue)}`;
    if (metricTotalQty) metricTotalQty.textContent = totalItemsSold;
    if (metricTotalStock) metricTotalStock.textContent = globalStockAvail;
}

window.applyDateFilter = function() {
    renderInventoryDashboard();
};

window.clearDateFilter = function() {
    const startDate = document.getElementById('startDate');
    const endDate = document.getElementById('endDate');
    const categoryFilter = document.getElementById('categoryFilter');

    if (startDate) startDate.value = '';
    if (endDate) endDate.value = '';
    if (categoryFilter) categoryFilter.value = 'All';

    renderInventoryDashboard();
};

// Refund now goes through the refund_sale() database function, which
// checks for a real signed-in *admin* session (is_admin(), backed by the
// `admins` table -- not just auth.uid() IS NOT NULL, which a signed-in
// buyer would also satisfy) before touching anything -- see
// supabase-schema.sql.
window.refundSale = async function(transactionId, productId) {
    if (!confirm('Process a refund for this sale?\n\nThis will remove it from revenue/units-sold totals and restore the item to available stock. This cannot be undone.')) {
        return;
    }

    const { error } = await sb.rpc('refund_sale', {
        p_transaction_id: transactionId,
        p_product_id: productId
    });

    if (error) {
        console.error('Error processing refund:', error);
        alert('Refund failed: ' + (error.message || 'please try again.'));
        return;
    }

    ordersCache = null;
    await renderInventoryDashboard();
};

// Cancels every non-refunded item in an order at once via cancel_order(),
// the multi-item sibling of refund_sale(). Same admin bar (is_admin()),
// so any co-admin can do this -- matches the existing per-item refund
// permission level. See supabase-schema.sql.
window.cancelOrder = async function(transactionId) {
    if (!confirm('Cancel this entire transaction?\n\nThis refunds every item in the order at once, removes it from revenue/units-sold totals, and restores all of its items to available stock. This cannot be undone.')) {
        return;
    }

    const { error } = await sb.rpc('cancel_order', { p_transaction_id: transactionId });

    if (error) {
        console.error('Error cancelling transaction:', error);
        alert('Cancel failed: ' + (error.message || 'please try again.'));
        return;
    }

    ordersCache = null;
    await renderInventoryDashboard();
};

/* ==========================================================================
   EXCEL EXPORT (SheetJS)
   Mirrors exactly what's on the Inventory & Sales Dashboard page: the 5
   metric cards ("Summary"), the Product Stock Breakdown table, and the
   Recent Sales & Order Log table (refund status included as a column,
   same as the page's Action badge). Same row filtering math as
   renderInventoryDashboard() -- "Stock Available" is always all-time,
   "Total Sold"/revenue respect the date range, refunded sales are
   excluded from revenue/units-sold but still listed with their status.
   ========================================================================== */

// category/startDate/endDate -> the same category+date matching
// renderInventoryDashboard() applies via passesFilters(), but as a
// standalone function (not reading the DOM) so it can be reused for both
// "export what's on screen right now" and "export everything, ignore
// filters" without duplicating the matching logic twice.
function buildExportFilterMatcher({ category, startDate, endDate }) {
    const cleanCategory = (category || 'All').trim().toLowerCase();
    const start = startDate ? new Date(startDate + 'T00:00:00').getTime() : null;
    const end = endDate ? new Date(endDate + 'T23:59:59.999').getTime() : null;

    return {
        matchesCategory(prodCategory) {
            return cleanCategory === 'all' || (prodCategory || '').trim().toLowerCase() === cleanCategory;
        },
        inDateRange(dateVal) {
            if (!start && !end) return true;
            const t = new Date(dateVal).getTime();
            if (start && t < start) return false;
            if (end && t > end) return false;
            return true;
        }
    };
}

// Builds the Summary row + Product Stock Breakdown rows + Sales & Order
// Log rows, using the exact same math as renderInventoryDashboard() so
// the spreadsheet can never disagree with what's on screen.
function buildDashboardExportData(products, orders, salesLog, filters) {
    const matcher = buildExportFilterMatcher(filters);

    const filteredProducts = products.filter(p => matcher.matchesCategory(p.category));

    let grossRevenue = 0;
    let totalItemsSold = 0;
    let globalStockAvail = 0;

    const productRows = filteredProducts.map(product => {
        let unitsSoldInRange = 0;
        orders.forEach(order => {
            if (matcher.inDateRange(order.date)) {
                const match = (order.items || []).find(i => String(i.id) === String(product.id) && !i.refunded);
                if (match) unitsSoldInRange += parseInt(match.quantity, 10) || 0;
            }
        });

        const itemPrice = parseFloat(product.price) || 0;
        const revenue = unitsSoldInRange * itemPrice;
        // Stock Available is always all-time, same reasoning as the page:
        // filtering to e.g. "today" shouldn't make stock look artificially
        // high just because earlier sales fall outside the date range.
        const currentStock = calculateAvailableStock(product, orders);

        grossRevenue += revenue;
        totalItemsSold += unitsSoldInRange;
        globalStockAvail += currentStock;

        return {
            'Product': product.title,
            'Category': product.category,
            'Price': itemPrice,
            'Stock Available': currentStock,
            'Total Sold': unitsSoldInRange,
            'Date Added': product.dateAdded ? new Date(product.dateAdded).toLocaleDateString() : '',
            'Total Revenue': revenue
        };
    });

    const filteredSales = (salesLog || []).filter(sale =>
        matcher.matchesCategory(sale.category) && matcher.inDateRange(sale.soldAt)
    );

    let totalRefunded = 0;
    const salesRows = filteredSales.map(sale => {
        if (sale.refunded) totalRefunded += parseFloat(sale.totalRevenue) || 0;
        return {
            'Order ID': sale.transactionId,
            'Date': sale.soldAt ? new Date(sale.soldAt).toLocaleString() : '',
            'Product Purchased': sale.productName,
            'Category': sale.category,
            'Qty Sold': sale.quantity,
            'Unit Price': parseFloat(sale.price) || 0,
            'Total Paid': parseFloat(sale.totalRevenue) || 0,
            'Status': sale.refunded ? 'Refunded' : 'Active'
        };
    });

    const summaryRow = [{
        'Total Revenue (Net of Refunds)': grossRevenue,
        'Total Units Sold': totalItemsSold,
        'Total Refunded': totalRefunded,
        'Total Stock Available': globalStockAvail,
        'Unique Products': filteredProducts.length,
        'Category Filter': filters.category || 'All',
        'Start Date': filters.startDate || '(none)',
        'End Date': filters.endDate || '(none)',
        'Exported At': new Date().toLocaleString()
    }];

    return { summaryRow, productRows, salesRows };
}

// useCurrentPageFilters = true  -> exactly what's on screen right now
//                                  (reads the category/date filter bar)
// useCurrentPageFilters = false -> everything, filters ignored (used for
//                                  the pre-reset safety backup, since that
//                                  action wipes ALL sales data regardless
//                                  of whatever filter happens to be set)
async function buildKraftedWorkbook(useCurrentPageFilters) {
    if (typeof XLSX === 'undefined') {
        throw new Error('Excel export library failed to load. Check your internet connection.');
    }

    const [products, orders, salesLog] = await Promise.all([
        getStoredProducts(),
        getStoredOrders(),
        getStoredSalesLog()
    ]);

    const filters = useCurrentPageFilters ? {
        category: document.getElementById('categoryFilter')?.value || 'All',
        startDate: document.getElementById('startDate')?.value || '',
        endDate: document.getElementById('endDate')?.value || ''
    } : { category: 'All', startDate: '', endDate: '' };

    const { summaryRow, productRows, salesRows } = buildDashboardExportData(products, orders, salesLog, filters);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRow), 'Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(productRows), 'Product Stock Breakdown');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(salesRows), 'Sales & Order Log');
    return wb;
}

// Standalone button: exports exactly what's currently visible on the
// dashboard (metric cards + both tables), respecting whatever category/
// date filter is applied at the moment.
window.exportDataToExcel = async function() {
    try {
        const wb = await buildKraftedWorkbook(true);
        const dateStamp = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `krafted-data-export-${dateStamp}.xlsx`);
    } catch (e) {
        console.error('Excel export failed:', e);
        alert('Export failed: ' + (e.message || 'please try again.'));
    }
};

// Clearing sales history goes through reset_sales_data(), which likewise
// checks for a real admin session before deleting anything.
//
// Flow: confirm -> auto-download an Excel backup -> confirm again -> delete.
// The double confirmation is deliberate friction for a destructive,
// irreversible action; the backup here always covers ALL sales data
// (filters ignored), since the reset itself wipes everything regardless
// of what's selected in the filter bar at the time.
window.resetSalesData = async function() {
    if (!confirm(
        'This will permanently delete ALL orders and sales history (your product catalog stays intact).\n\n' +
        'This cannot be undone. Continue?'
    )) {
        return;
    }

    try {
        const wb = await buildKraftedWorkbook(false);
        const dateStamp = new Date().toISOString().slice(0, 10);
        XLSX.writeFile(wb, `krafted-backup-before-reset-${dateStamp}.xlsx`);
    } catch (e) {
        console.error('Backup export failed:', e);
        if (!confirm(
            'Could not generate the Excel backup (' + (e.message || 'unknown error') + ').\n\n' +
            'Continue with the reset anyway, without a backup?'
        )) {
            return;
        }
    }

    if (!confirm(
        'Backup downloaded. This is your last chance to back out.\n\n' +
        'Permanently delete all sales data now? This cannot be undone.'
    )) {
        return;
    }

    const { error } = await sb.rpc('reset_sales_data');
    if (error) {
        console.error('Error resetting sales data:', error);
        alert('Reset failed: ' + (error.message || 'please try again.'));
        return;
    }

    ordersCache = null;
    await renderInventoryDashboard();
    alert('Sales history has been reset.');
};
