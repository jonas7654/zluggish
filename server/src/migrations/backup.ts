import { ConfigError } from '#src/config/index';
import { configureConnection, SCHEMA_VERSION } from '#src/db/open';
import { StorageFile } from '#src/migrations/storage';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { SystemFlag } from '#src/repositories/system-flag.repository';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const MANIFEST = 'backup-manifest.json';
const CONFIG = 'config';
const RESTORING = 'zluggish.db.restoring';

const manifestSchema = z.object({
  version: z.literal(2),
  created: z.string(),
  schemaVersion: z.number(),
  config: z.string().nullable(),
  checksums: z.record(z.string(), z.string()),
});

const crypto = new CryptoRepository();

function sync(path: string, flags = 'r+') {
  if (process.platform === 'win32' && flags === 'r') return;
  const fd = openSync(path, flags);

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeDurable(path: string, data: string) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  sync(temporary);
  renameSync(temporary, path);
  sync(dirname(path), 'r');
}

/** Storage entries that a backup holds as files. The database is copied with VACUUM INTO;
WAL sidecars, locks, migration state and older backups are never copied.
*/
function included(name: string) {
  return ![
    StorageFile.Database,
    `${StorageFile.Database}-wal`,
    `${StorageFile.Database}-shm`,
    StorageFile.Temporary,
    StorageFile.RestoreMarker,
    StorageFile.Manifest,
    RESTORING,
    '.server.lock',
    'backups',
  ].includes(name);
}

function copyTree(source: string, target: string, root: string, checksums: Record<string, string>) {
  mkdirSync(target, { recursive: true });

  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name);
    const to = resolve(target, entry.name);

    if (entry.isDirectory()) copyTree(from, to, root, checksums);
    else if (entry.isFile()) {
      copyFileSync(from, to);
      sync(to);
      checksums[relative(root, to)] = crypto.sha256(readFileSync(to));
    }
  }

  sync(target, 'r');
}

/** Offline backup: the caller holds the storage lock. The database is a consistent
snapshot; media, FIT exports, configuration and encryption keys are copied beside it.
*/
export function backupStorage(storage: string, output: string, config: string | null) {
  if (existsSync(output) && readdirSync(output).length > 0) throw new ConfigError('The backup directory is not empty');
  mkdirSync(output, { recursive: true });
  const checksums: Record<string, string> = {};
  const db = new DatabaseSync(resolve(storage, StorageFile.Database), { readOnly: true });
  let schemaVersion: number;

  try {
    schemaVersion = z.number().parse(db.prepare('SELECT version FROM version').get()?.version);

    if (schemaVersion !== SCHEMA_VERSION) throw new ConfigError('Start the server once to upgrade storage first');
    db.prepare('VACUUM INTO ?').run(resolve(output, StorageFile.Database));
  } finally {
    db.close();
  }

  sync(resolve(output, StorageFile.Database));
  checksums[StorageFile.Database] = crypto.sha256(readFileSync(resolve(output, StorageFile.Database)));

  for (const entry of readdirSync(storage, { withFileTypes: true })) {
    if (!included(entry.name)) continue;
    const from = resolve(storage, entry.name);
    const to = resolve(output, entry.name);

    if (entry.isDirectory()) copyTree(from, to, output, checksums);
    else if (entry.isFile()) {
      copyFileSync(from, to);
      sync(to);
      checksums[entry.name] = crypto.sha256(readFileSync(to));
    }
  }

  if (config && existsSync(config)) {
    mkdirSync(resolve(output, CONFIG));
    copyFileSync(config, resolve(output, CONFIG, basename(config)));
    sync(resolve(output, CONFIG, basename(config)));
    checksums[`${CONFIG}/${basename(config)}`] = crypto.sha256(readFileSync(config));
  }

  writeDurable(
    resolve(output, MANIFEST),
    `${JSON.stringify(
      {
        version: 2,
        created: new Date().toISOString(),
        schemaVersion,
        config: config ? basename(config) : null,
        checksums,
      },
      null,
      2,
    )}\n`,
  );

  return Object.keys(checksums).length;
}

function validateBackup(input: string) {
  const path = resolve(input, MANIFEST);

  if (!existsSync(path)) throw new ConfigError('The backup has no manifest');
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

  for (const [name, checksum] of Object.entries(manifest.checksums)) {
    const file = resolve(input, name);

    if (!existsSync(file) || crypto.sha256(readFileSync(file)) !== checksum)
      throw new ConfigError(`The backup file ${name} is missing or changed`);
  }

  if (manifest.schemaVersion > SCHEMA_VERSION) throw new ConfigError('The backup is newer than this release');
  const db = new DatabaseSync(resolve(input, StorageFile.Database), { readOnly: true });

  try {
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
      throw new ConfigError('The backup database failed its integrity check');

    if (
      db.prepare('SELECT 1 FROM rider_document WHERE encrypted=1 LIMIT 1').get() &&
      !existsSync(resolve(input, StorageFile.CredentialsKey))
    )
      throw new ConfigError('The backup has encrypted credentials but no credentials-key.bin');
  } finally {
    db.close();
  }

  return manifest;
}

/** Close the current database with its WAL applied, so no sidecar file can be replayed
onto the replacement.
*/
function closeCurrent(storage: string) {
  const path = resolve(storage, StorageFile.Database);

  if (!existsSync(path)) return;
  const db = new DatabaseSync(path);

  try {
    const result = z.object({ busy: z.number() }).parse(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get());

    if (result.busy !== 0) throw new ConfigError('The database is busy; stop the server before a restore');
    db.exec('PRAGMA journal_mode=DELETE');
  } finally {
    db.close();
  }

  if (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0)
    throw new ConfigError('The current database still has WAL changes; stop the server before a restore');

  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

/** Offline restore. The caller holds the storage lock. A durable marker blocks startup
until every required file is in place. The restored database carries the upload pause:
a delivery can succeed after its backup was made, so no restored delivery is sent
automatically until an operator clears the pause.
*/
export function restoreStorage(
  storage: string,
  input: string,
  config: string | null,
  reached: (step: 'marked' | 'prepared' | 'published' | 'copied') => void = () => {},
) {
  const manifest = validateBackup(input);
  mkdirSync(storage, { recursive: true });
  writeDurable(
    resolve(storage, StorageFile.RestoreMarker),
    `${JSON.stringify({ input, started: new Date().toISOString() })}\n`,
  );
  reached('marked');

  const restoring = resolve(storage, RESTORING);

  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${restoring}${suffix}`, { force: true });
  copyFileSync(resolve(input, StorageFile.Database), restoring);
  const db = new DatabaseSync(restoring);

  try {
    db.exec('PRAGMA synchronous=FULL');
    db.prepare(
      'INSERT INTO system_flag (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value',
    ).run(SystemFlag.UploadPause, `restore ${manifest.created}`);
    db.exec('PRAGMA journal_mode=DELETE');
  } finally {
    db.close();
  }

  sync(restoring);
  reached('prepared');
  closeCurrent(storage);
  renameSync(restoring, resolve(storage, StorageFile.Database));
  sync(storage, 'r');
  reached('published');

  for (const name of Object.keys(manifest.checksums)) {
    if (name === StorageFile.Database || name.startsWith(`${CONFIG}/`)) continue;
    const target = resolve(storage, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(input, name), target);
    sync(target);
    reached('copied');
  }

  if (config && manifest.config) {
    copyFileSync(resolve(input, CONFIG, manifest.config), config);
    sync(config);
  }

  sync(storage, 'r');
  rmSync(resolve(storage, StorageFile.RestoreMarker));
  sync(storage, 'r');
}

/** For a manual directory copy: set the upload pause before the first start. */
export function pauseUploads(storage: string, reason: string) {
  const db = new DatabaseSync(resolve(storage, StorageFile.Database));

  try {
    configureConnection(db);
    db.prepare(
      'INSERT INTO system_flag (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value',
    ).run(SystemFlag.UploadPause, reason);
  } finally {
    db.close();
  }
}
