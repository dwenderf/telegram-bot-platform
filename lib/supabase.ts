import postgres from 'postgres';

const globalForDb = globalThis as unknown as {
  conn: postgres.Sql | undefined;
};

const connectionString = process.env.DATABASE_URL || '';

if (!connectionString) {
  console.warn('Warning: DATABASE_URL is not set in environment variables.');
}

// Reuse the connection pool in serverless environments during hot starts
export const sql =
  globalForDb.conn ??
  postgres(connectionString, {
    max: 10, // Maintain a small pool size to prevent connection exhaustion in serverless
    idle_timeout: 20, // Close idle connections after 20 seconds
    connect_timeout: 10, // Wait up to 10 seconds to connect
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.conn = sql;
}

/**
 * Executes database operations inside a transaction with RLS scoped to a specific entity.
 * 
 * In Postgres, transaction-local settings set with `set_config(..., true)` are scoped
 * strictly to that transaction, preventing cross-tenant leakage in concurrent requests.
 * 
 * @param entityId The UUID of the tenant entity
 * @param callback Database queries executed on the transaction client
 */
export async function withTenantContext<T>(
  entityId: string,
  callback: (tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
  return (await sql.begin(async (tx) => {
    // Set transaction-local session parameter for RLS policies
    await tx`SELECT set_config('app.current_entity_id', ${entityId}, true)`;
    return await callback(tx);
  })) as T;
}
