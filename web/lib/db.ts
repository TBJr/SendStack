import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { config } from "./config";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations or seeds.");
  }
  pool ??= new Pool({ connectionString: config.databaseUrl });
  return pool;
}

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, values);
}
