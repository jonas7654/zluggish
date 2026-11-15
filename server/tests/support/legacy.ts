import { completionSchemaSQL, createSchemaSQL } from '#src/db/ddl';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** A version 5 account database, as releases before the storage merge created it. */
export function legacyDatabase(storage: string) {
  mkdirSync(storage, { recursive: true });
  const db = new DatabaseSync(resolve(storage, 'zluggish.db'));
  db.exec(createSchemaSQL);
  db.exec(completionSchemaSQL);
  db.exec('INSERT INTO version VALUES (5); INSERT INTO account_state VALUES (1, 1);');

  return db;
}
