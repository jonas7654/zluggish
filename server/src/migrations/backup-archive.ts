import { ConfigError } from '#src/config/index';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

export const archiveSuffix = '.tar.gz';

const runTar = promisify(execFile);

export async function compressBackup(source: string, output: string, signal?: AbortSignal) {
  await runTar('tar', ['-czf', output, '-C', source, '.'], { signal });
}

export function compressBackupSync(source: string, output: string) {
  execFileSync('tar', ['-czf', output, '-C', source, '.']);
}

export function readArchivedFile(input: string, name: string) {
  return execFileSync('tar', ['-xOzf', input, `./${name}`], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

/** Run against a directory backup or unpack an archive into a private temporary directory. */
export function withBackupDirectory<T>(input: string, use: (directory: string) => T): T {
  if (!statSync(input).isFile()) return use(input);
  const stage = mkdtempSync(resolve(tmpdir(), 'zluggish-restore-'));

  try {
    execFileSync('tar', ['-xzf', input, '-C', stage, '--no-same-owner', '--no-same-permissions']);
    const entries = readdirSync(stage, { recursive: true, withFileTypes: true });

    if (entries.some((entry) => !entry.isFile() && !entry.isDirectory()))
      throw new ConfigError('The backup archive contains an unsupported file type');

    return use(stage);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
