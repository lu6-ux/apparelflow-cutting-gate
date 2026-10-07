import { openDb } from './db.js';
import { migrate } from './schema.js';
import { seed } from './seed.js';
import { createApp } from './app.js';

const prod = process.env.NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET || (prod ? null : 'dev-only-insecure-secret');
if (!jwtSecret) { console.error('JWT_SECRET must be set in production'); process.exit(1); }

const db = openDb();
await migrate(db);
await seed(db);
const port = Number(process.env.PORT) || 3000;
createApp({ db, jwtSecret }).listen(port, () => console.log(`ApparelFlow listening on :${port} (${db.dialect})`));
