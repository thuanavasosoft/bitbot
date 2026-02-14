import * as schema from "db/drizzle/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

class DatabaseService {
  static db: ReturnType<typeof drizzle<typeof schema>>;
  static pool: Pool;

  static async configure() {
    try {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error("DATABASE_URL is required");
      }

      this.pool = new Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });

      this.db = drizzle(this.pool, { schema });
    } catch (error) {
      console.error("Error on configuring database: ", error);
      throw error;
    }
  }

  static async closePool() {
    await this.pool.end();
  }
}

export default DatabaseService;
