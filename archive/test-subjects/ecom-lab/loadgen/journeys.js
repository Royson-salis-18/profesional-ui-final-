// Shopper behaviour for the ecom system. setup() runs once (not measured): creates a bulk-stock product so purchases never run out,
// registers a pool of customers and logs them in. Weights: browse 65 / orders 10 / purchase 25.
const PW = 'Passw0rd!x';
export async function setup({ http, users }) {
  const admin = (await http('POST', '/api/v1/auth/login', { email: 'admin@demo.local', password: 'DemoAdmin1!' })).data;
  if (!admin?.access_token) throw new Error('admin login failed - is the stack up?');
  const auth = { authorization: `Bearer ${admin.access_token}` };
  const bulk = (await http('POST', '/api/products', { category: 'ELECTRONICS', name: `Bulk ${Date.now()}`, brand: 'Acme', description: 'bulk stock for load tests', stock: 50_000_000, price: 9.99, active: true }, auth)).data;
  const tag = Date.now().toString(36);
  const pool = Math.min(users, 40);
  const tokens = [];
  for (let i = 0; i < pool; i++) {
    const email = `load-${tag}-${i}@example.test`;
    await http('POST', '/api/v1/auth/register', { email, password: PW, firstName: 'Load', lastName: `U${i}` });
    const t = (await http('POST', '/api/v1/auth/login', { email, password: PW })).data;
    if (t?.access_token) tokens.push(t.access_token);
  }
  const cat = (await http('GET', '/api/catalog/products?size=50')).data;
  return { bulkId: bulk.id, tokens, ids: (cat?.items ?? []).map((i) => i.productId) };
}
export const journeys = [
  { name: 'browse', weight: 65, run: async (c) => {
    await c.http('GET', `/api/catalog/products?page=${c.rand(2)}&size=10`);
    if (c.state.ids.length) await c.http('GET', `/api/catalog/products/${c.state.ids[c.rand(c.state.ids.length)]}`);
  } },
  { name: 'orders', weight: 10, run: async (c) => {
    await c.http('GET', '/api/catalog/orders', undefined, { authorization: `Bearer ${c.state.tokens[c.rand(c.state.tokens.length)]}` });
  } },
  { name: 'purchase', weight: 25, run: async (c) => {
    await c.http('POST', '/api/products/purchase', { items: [{ productId: c.state.bulkId, quantity: 1 }] }, { authorization: `Bearer ${c.state.tokens[c.rand(c.state.tokens.length)]}` });
  } },
];
