import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL ?? 'postgres://compass:compass@localhost:5432/compass',
  },
  schemaFilter: ['auth', 'inventory', 'domain', 'read_model', 'ops', 'sync'],
  verbose: true,
  strict: true,
} satisfies Config;
