import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Durable JSON persistence helpers for the memory stores.
 *
 * Writes go to an exclusive unique temporary file beside the destination and
 * are moved into place with rename(2), so a crash mid-write can never leave a
 * truncated store file behind. Before each replacement the previous content is
 * rotated into a `<file>.bak` last-good backup, and a file that cannot be
 * parsed/validated is quarantined (renamed to `<file>.corrupt-<id>`) instead
 * of being overwritten with an empty cache.
 */

/** `ok` = parsed, `missing` = ENOENT, `corrupt` = unreadable or unparseable. */
export type JsonFileReadStatus = 'ok' | 'missing' | 'corrupt';

export type JsonFileReadResult<T> =
  | { status: 'ok'; value: T; error?: undefined }
  | { status: 'missing'; value?: undefined; error?: undefined }
  | { status: 'corrupt'; value?: undefined; error: Error };

export interface JsonStoreOptions<T> {
  defaultValue: () => T;
  isValid: (value: unknown) => value is T;
  /** Human-readable store name used in corruption log lines. */
  label: string;
}

export interface JsonStoreLoadResult<T> {
  value: T;
  recoveredFromBackup: boolean;
  quarantinedPath?: string;
}

export function backupPathFor(filePath: string): string {
  return `${filePath}.bak`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNoSuchFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // the fd is already unusable; nothing left to do
  }
}

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // best-effort cleanup
  }
}

function tempPathFor(target: string): string {
  return `${target}.tmp-${process.pid}-${randomUUID()}`;
}

function fsyncDirectoryQuietly(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
  } catch {
    return;
  }
  if (fd === undefined) {
    return;
  }
  try {
    fs.fsyncSync(fd);
  } catch {
    // directory fsync is not supported on every platform/filesystem
  } finally {
    closeQuietly(fd);
  }
}

/** Reads a JSON file, distinguishing ENOENT from read/parse failures. */
export function readJsonFile<T>(filePath: string): JsonFileReadResult<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (isNoSuchFileError(error)) {
      return { status: 'missing' };
    }
    // Permission/I/O errors are not recoverable JSON corruption. Refuse to
    // start an empty store that could later overwrite inaccessible data.
    throw error;
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) as T };
  } catch (error) {
    return { status: 'corrupt', error: asError(error) };
  }
}

function readValidated<T>(filePath: string, options: JsonStoreOptions<T>): JsonFileReadResult<T> {
  const result = readJsonFile<T>(filePath);
  if (result.status === 'ok' && !options.isValid(result.value)) {
    return { status: 'corrupt', error: new Error(`persisted ${options.label} data at ${filePath} failed validation`) };
  }
  return result;
}

/** Moves an unreadable file aside so it is preserved instead of overwritten. */
export function quarantineCorruptFile(filePath: string): string | null {
  const quarantinePath = `${filePath}.corrupt-${randomUUID().slice(0, 8)}`;
  try {
    fs.renameSync(filePath, quarantinePath);
    return quarantinePath;
  } catch {
    return null;
  }
}

function logCorruption(label: string, filePath: string, error: Error, backupPath: string | null, quarantinedPath: string | null): void {
  const recovery = backupPath === null
    ? `no usable backup found, starting from an empty ${label} cache`
    : `recovered the last good state from backup ${backupPath}`;
  const preservation = quarantinedPath === null
    ? 'the original file could not be preserved'
    : `the original file was preserved at ${quarantinedPath} and was not overwritten`;
  console.error(`[memory] ${label} file ${filePath} is corrupt and could not be loaded: ${error.message}; ${recovery}; ${preservation}`);
}

/** Rotates the current file into the last-good backup before replacement. */
function rotateBackup(filePath: string, dir: string, isValid?: (value: unknown) => boolean): void {
  const backupPath = backupPathFor(filePath);
  let previous: string;
  try {
    previous = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(previous);
    if (isValid && !isValid(parsed)) throw new Error('Refusing to replace invalid memory data or rotate it over a good backup.');
  } catch (error) {
    if (isNoSuchFileError(error)) return;
    throw error;
  }
  const tempPath = tempPathFor(backupPath);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, 'wx', fs.statSync(filePath).mode & 0o777);
    fs.writeFileSync(fd, previous, 'utf-8');
    fs.fsyncSync(fd);
    closeQuietly(fd);
    fd = undefined;
    fs.renameSync(tempPath, backupPath);
  } catch (error) {
    if (fd !== undefined) {
      closeQuietly(fd);
    }
    removeQuietly(tempPath);
    throw error;
  }
  fsyncDirectoryQuietly(dir);
}

/**
 * Atomically replaces `filePath` with the JSON serialization of `value`.
 *
 * The payload is written to an exclusive unique temporary file beside the
 * destination, flushed to disk, the previous content is rotated into
 * `<file>.bak`, and only then is the temporary file renamed over the target.
 * Any failure cleans the temporary file up and rethrows, leaving the previous
 * file content intact.
 */
export function writeJsonFileAtomic(filePath: string, value: unknown, isValid?: (value: unknown) => boolean): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify(value, null, 2);
  const tempPath = tempPathFor(filePath);
  let fd: number | undefined;
  try {
    let mode = 0o600;
    try { mode = fs.statSync(filePath).mode & 0o777; }
    catch (error) { if (!isNoSuchFileError(error)) throw error; }
    fd = fs.openSync(tempPath, 'wx', mode);
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, payload, 'utf-8');
    fs.fsyncSync(fd);
    closeQuietly(fd);
    fd = undefined;
    rotateBackup(filePath, dir, isValid);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== undefined) {
      closeQuietly(fd);
    }
    removeQuietly(tempPath);
    throw error;
  }
  fsyncDirectoryQuietly(dir);
}

/**
 * Loads a store file with crash recovery: a missing file starts from the
 * default value quietly, while a corrupt/unreadable file is loudly reported,
 * recovered from the last-good backup when possible, and quarantined so a
 * later save can never silently replace it with an empty cache.
 */
export function loadJsonStore<T>(filePath: string, options: JsonStoreOptions<T>): JsonStoreLoadResult<T> {
  const backupPath = backupPathFor(filePath);
  const main = readValidated(filePath, options);

  if (main.status === 'ok') {
    return { value: main.value, recoveredFromBackup: false };
  }

  if (main.status === 'missing') {
    const backup = readValidated(backupPath, options);
    if (backup.status === 'ok') {
      logCorruption(options.label, filePath, new Error('file is missing'), backupPath, null);
      return { value: backup.value, recoveredFromBackup: true };
    }
    if (backup.status === 'corrupt') {
      const quarantinedPath = quarantineCorruptFile(backupPath);
      logCorruption(options.label, backupPath, backup.error ?? new Error('unreadable backup'), null, quarantinedPath);
    }
    return { value: options.defaultValue(), recoveredFromBackup: false };
  }

  const backup = readValidated(backupPath, options);
  const quarantinedPath = quarantineCorruptFile(filePath);
  if (!quarantinedPath) {
    throw new Error(`Refusing to overwrite unpreserved corrupt ${options.label} at ${filePath}.`, { cause: main.error });
  }
  if (backup.status === 'ok') {
    logCorruption(options.label, filePath, main.error ?? new Error('unreadable'), backupPath, quarantinedPath);
    return { value: backup.value, recoveredFromBackup: true, quarantinedPath };
  }
  logCorruption(options.label, filePath, main.error ?? new Error('unreadable'), null, quarantinedPath);
  return { value: options.defaultValue(), recoveredFromBackup: false, quarantinedPath };
}
