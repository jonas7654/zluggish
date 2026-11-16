import { Metric, metrics } from '#src/repositories/metrics.repository';
import type { DatabaseSync } from 'node:sqlite';

/** Run a synchronous write transaction. The operation must not await: another
request could otherwise use the shared connection while the transaction is open.
*/
export function immediate<T>(db: DatabaseSync, operation: () => T): T {
  return metrics.time(Metric.DatabaseTransaction, () => {
    db.exec('BEGIN IMMEDIATE');

    try {
      const result = operation();
      db.exec('COMMIT');

      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  });
}

/** Join the caller's transaction, or run in a new one. */
export function atomic<T>(db: DatabaseSync, operation: () => T): T {
  return db.isTransaction ? operation() : immediate(db, operation);
}
