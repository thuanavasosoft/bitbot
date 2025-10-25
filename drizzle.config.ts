import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'mysql', // 'postgresql' | 'mysql' | 'sqlite'
  out: "./db/drizzle",
  schema: "./src/schema/*",
  dbCredentials: {
    url: `mysql://${process.env.DATABASE_USER}:${process.env.DATABASE_PASSWORD}@${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT}/${process.env.DATABASE_NAME}`,
  }
});