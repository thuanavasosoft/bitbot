import * as schema from "db/drizzle/schema"

import { MySql2Database, drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

class DatabaseService {
  static db: MySql2Database<typeof schema>;
  static pool: mysql.Pool;

  static async configure(isMigration?: boolean) {
    try {
      this.pool = mysql.createPool({
        host: process.env.DATABASE_HOST,
        user: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASSWORD,
        port: Number(process.env.DATABASE_PORT),
        ...(isMigration ? {} : { database: process.env.DATABASE_NAME }),
        waitForConnections: true, // Queue connection requests when no connections are available
        connectionLimit: 10, // Allows up to 10 simultaneous connections
        queueLimit: 0, // Unlimited queue size
      });

      // Create a temporary connection to execute the database creation and selection
      const tempConnection = await this.pool.getConnection();
      await tempConnection.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DATABASE_NAME}\``);
      await tempConnection.query(`USE \`${process.env.DATABASE_NAME}\``);
      tempConnection.release();

      // Initialize drizzle with the selected database
      this.db = drizzle(this.pool, { schema, mode: "default" });
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