import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteFile(
  filePath: string,
  content: string,
  options: { rename?: typeof rename } = {}
): Promise<void> {
  const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && !existing.isFile()) {
    throw new Error("Atomic writes require a regular destination file.");
  }
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await open(temporary, "wx", existing ? existing.mode & 0o777 : 0o666);
    created = true;
    if (existing) await handle.chmod(existing.mode & 0o777);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await (options.rename ?? rename)(temporary, filePath);
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(filePath), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close();
    if (created) await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
