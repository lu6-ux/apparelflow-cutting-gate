// Relational schema (see README for the ER overview). Works on SQLite and PostgreSQL.
export async function migrate(db) {
  const pk = db.dialect === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  await db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id ${pk},
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('cutting_supervisor','cutting_verifier','sewing_supervisor')),
  full_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recipes (
  id ${pk},
  recipe_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  std_fabric_yards DOUBLE PRECISION NOT NULL CHECK (std_fabric_yards > 0),
  wastage_cap DOUBLE PRECISION NOT NULL CHECK (wastage_cap >= 0)
);
CREATE TABLE IF NOT EXISTS recipe_components (
  id ${pk},
  recipe_id INTEGER NOT NULL REFERENCES recipes(id),
  component_name TEXT NOT NULL,
  pieces_per_garment INTEGER NOT NULL CHECK (pieces_per_garment > 0),
  image_url TEXT
);
CREATE TABLE IF NOT EXISTS cutting_orders (
  id ${pk},
  order_no TEXT NOT NULL UNIQUE,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id),
  target_qty INTEGER NOT NULL CHECK (target_qty > 0),
  fabric_roll_id TEXT NOT NULL,
  actual_fabric_yds DOUBLE PRECISION NOT NULL CHECK (actual_fabric_yds > 0),
  status TEXT NOT NULL CHECK (status IN ('CUTTING_IN_PROGRESS','PENDING_VERIFICATION','REJECTED','VERIFIED','SEWING_STARTED')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sewing_started_by INTEGER REFERENCES users(id),
  sewing_started_at TEXT
);
CREATE TABLE IF NOT EXISTS verification_items (
  id ${pk},
  order_id INTEGER NOT NULL REFERENCES cutting_orders(id),
  component_id INTEGER NOT NULL REFERENCES recipe_components(id),
  expected_qty INTEGER NOT NULL CHECK (expected_qty > 0),
  actual_qty INTEGER CHECK (actual_qty IS NULL OR actual_qty >= 0),
  status TEXT CHECK (status IS NULL OR status IN ('GREEN','YELLOW','RED')),
  UNIQUE (order_id, component_id)
);
CREATE TABLE IF NOT EXISTS verification_logs (
  id ${pk},
  order_id INTEGER NOT NULL REFERENCES cutting_orders(id),
  verifier_id INTEGER NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  rejection_note TEXT,
  wastage_pct DOUBLE PRECISION,
  component_variances TEXT,
  timestamp TEXT NOT NULL,
  CHECK (decision <> 'REJECTED' OR (rejection_note IS NOT NULL AND length(trim(rejection_note)) > 0))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON cutting_orders(status);
CREATE INDEX IF NOT EXISTS idx_items_order ON verification_items(order_id);
CREATE INDEX IF NOT EXISTS idx_logs_order ON verification_logs(order_id);
`);

  // Audit trail immutability at the database level (defence in depth).
  if (db.dialect === 'sqlite') {
    await db.exec(`
CREATE TRIGGER IF NOT EXISTS verification_logs_no_update BEFORE UPDATE ON verification_logs
BEGIN SELECT RAISE(ABORT, 'verification_logs is immutable'); END;
CREATE TRIGGER IF NOT EXISTS verification_logs_no_delete BEFORE DELETE ON verification_logs
BEGIN SELECT RAISE(ABORT, 'verification_logs is immutable'); END;`);
  } else {
    await db.exec(`
CREATE OR REPLACE FUNCTION verification_logs_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'verification_logs is immutable'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS verification_logs_no_change ON verification_logs;
CREATE TRIGGER verification_logs_no_change BEFORE UPDATE OR DELETE ON verification_logs
FOR EACH ROW EXECUTE FUNCTION verification_logs_immutable();`);
  }
}
