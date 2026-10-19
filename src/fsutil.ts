/**
 * File helpers that behave the same on macOS, Linux and Windows.
 *
 * Two things differ between the platforms and both are handled here:
 *
 *   permissions  POSIX mode bits do not exist on Windows (chmod only toggles
 *                the read-only flag) and some filesystems (FAT, SMB shares)
 *                reject chmod outright. Setting the mode is therefore best
 *                effort, never a reason for a store to fail.
 *   replace      renaming over an existing file can fail with EPERM/EBUSY on
 *                Windows when an antivirus or another process holds it open,
 *                so a failed rename retries once after removing the target.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const IS_WINDOWS = process.platform === "win32";

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** chmod without caring whether the platform or filesystem supports it. */
export function chmodQuietly(filePath: string, mode: number): void {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    /* Windows, FAT, SMB, or a read-only mount: the mode is a nicety */
  }
}

export function removeQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone, or held open by another process */
  }
}

/**
 * Write a file atomically and as privately as the platform allows.
 *
 * The write goes to a temporary file next to the target and is renamed into
 * place, so a crash mid-write cannot leave a half-written store behind.
 */
export function writePrivateFile(filePath: string, data: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
  chmodQuietly(tmp, 0o600);

  try {
    fs.renameSync(tmp, filePath);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (IS_WINDOWS && (code === "EPERM" || code === "EEXIST" || code === "EBUSY")) {
      removeQuietly(filePath);
      fs.renameSync(tmp, filePath);
      return;
    }
    removeQuietly(tmp);
    throw err;
  }
}

export function writePrivateJson(filePath: string, value: unknown): void {
  writePrivateFile(filePath, JSON.stringify(value, null, 2));
}

/** Home directory of the current user, as pi itself resolves it. */
export function homeDir(): string {
  return os.homedir();
}
