import { TestUserManager } from '../core/TestUserManager.js';
export class SockShopScenario {
    baseUrl;
    stats;
    timeoutMs;
    constructor(baseUrl, stats, timeoutMs = 5000) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.stats = stats;
        this.timeoutMs = timeoutMs;
    }
    async executeJourney() {
        const randomScenario = Math.random();
        if (randomScenario < 0.5) {
            await this.browseCatalogJourney();
        }
        else if (randomScenario < 0.85) {
            await this.shoppingCartJourney();
        }
        else {
            await this.userCheckoutJourney();
        }
    }
    async browseCatalogJourney() {
        // 1. Load Homepage
        await this.step('homepage', () => this.request('GET', '/'));
        // 2. Fetch Catalogue Items
        let items = [];
        await this.step('catalogue_list', async () => {
            const res = await this.request('GET', '/catalogue');
            if (res.data && Array.isArray(res.data))
                items = res.data;
            return res;
        });
        // 3. Fetch Tags
        await this.step('catalogue_tags', () => this.request('GET', '/tags'));
        // 4. View Specific Product Details
        if (items.length > 0) {
            const randomItem = items[Math.floor(Math.random() * items.length)];
            const itemId = randomItem.id || '33382605-b474-49b8-8608-aa1d585ec...';
            await this.step('catalogue_detail', () => this.request('GET', `/catalogue/${itemId}`));
        }
    }
    async shoppingCartJourney() {
        await this.browseCatalogJourney();
        const catalogueRes = await this.request('GET', '/catalogue');
        const items = Array.isArray(catalogueRes.data) ? catalogueRes.data : [];
        const itemId = items.length > 0 ? items[0].id : '03fef6ac-1896-4ce8-bd69-b70d157cbe09';
        // Add item to cart
        await this.step('cart_add_item', () => this.request('POST', '/cart', { id: itemId }));
        // Get Cart
        await this.step('cart_get', () => this.request('GET', '/cart'));
    }
    async userCheckoutJourney() {
        await this.shoppingCartJourney();
        const user = TestUserManager.getNextTestUser();
        // Register / Login
        await this.step('user_register', () => this.request('POST', '/register', {
            username: user.username,
            password: user.password,
            email: user.email
        }));
        // Attempt Login
        await this.step('user_login', () => this.request('GET', '/login', undefined, {
            'Authorization': 'Basic ' + Buffer.from(`${user.username}:${user.password}`).toString('base64')
        }));
        // Place Order
        await this.step('order_create', () => this.request('POST', '/orders'));
    }
    async request(method, path, body, headers = {}) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const opts = {
                method,
                headers: {
                    'User-Agent': 'MicroserviceMapper-TrafficGen/1.0',
                    'Accept': 'application/json, text/html, */*',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                    ...headers,
                },
                signal: controller.signal,
                ...(body ? { body: JSON.stringify(body) } : {}),
            };
            const response = await fetch(`${this.baseUrl}${path}`, opts);
            clearTimeout(id);
            let data = null;
            try {
                const text = await response.text();
                data = text ? JSON.parse(text) : null;
            }
            catch (e) {
                data = null;
            }
            return { status: response.status, data };
        }
        catch (err) {
            clearTimeout(id);
            throw err;
        }
    }
    async step(actionName, fn) {
        const start = Date.now();
        try {
            const res = await fn();
            const latency = Date.now() - start;
            const statusCode = res?.status || 200;
            const isErr = statusCode >= 400;
            this.stats.recordRequest(actionName, statusCode, latency, isErr);
        }
        catch (e) {
            const latency = Date.now() - start;
            const isTimeout = e.name === 'AbortError' || e.message?.includes('aborted');
            this.stats.recordRequest(actionName, null, latency, true, isTimeout);
        }
    }
}
//# sourceMappingURL=SockShopScenario.js.map