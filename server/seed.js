import bcrypt from 'bcryptjs';

export const DEMO_USERS = [
  { email: 'supervisor@apparelflow.test', password: 'Supervisor@123', role: 'cutting_supervisor', full_name: 'Nimali Perera' },
  { email: 'verifier@apparelflow.test', password: 'Verifier@123', role: 'cutting_verifier', full_name: 'Kasun Fernando' },
  { email: 'sewing@apparelflow.test', password: 'Sewing@123', role: 'sewing_supervisor', full_name: 'Dilani Silva' },
];

const RECIPES = [
  { code: 'REC-BL01', name: 'Casual Blouse', category: 'Blouse', yds: 1.8, cap: 5.0, comps: [
    ['Front Body Panel', 1], ['Back Body Panel', 1], ['Sleeves (Left & Right)', 2], ['Collar & Stand', 1], ['Sleeve Cuffs', 2]] },
  { code: 'REC-CT02', name: 'Crop Top', category: 'Crop Top', yds: 1.1, cap: 8.0, comps: [
    ['Front Chest Panel', 1], ['Back Support Panel', 1], ['Neck Binding Strip', 1], ['Hem Elastic Casing', 1], ['Side Strap Accents', 2]] },
];

// Idempotent: safe to run on every boot.
export async function seed(db) {
  const now = new Date().toISOString();
  for (const u of DEMO_USERS) {
    const ex = await db.query('SELECT id FROM users WHERE email = ?', [u.email]);
    if (!ex.rows.length) {
      await db.query('INSERT INTO users (email, password_hash, role, full_name, created_at) VALUES (?,?,?,?,?)',
        [u.email, bcrypt.hashSync(u.password, 10), u.role, u.full_name, now]);
    }
  }
  for (const r of RECIPES) {
    const ex = await db.query('SELECT id FROM recipes WHERE recipe_code = ?', [r.code]);
    if (ex.rows.length) continue;
    const ins = await db.query(
      'INSERT INTO recipes (recipe_code, name, category, std_fabric_yards, wastage_cap) VALUES (?,?,?,?,?) RETURNING id',
      [r.code, r.name, r.category, r.yds, r.cap]);
    for (const [name, n] of r.comps) {
      await db.query('INSERT INTO recipe_components (recipe_id, component_name, pieces_per_garment, image_url) VALUES (?,?,?,?)',
        [ins.rows[0].id, name, n, null]);
    }
  }
}
