import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

/** Data contract only. This module is not an OS containment attestation. */
export const DESIGN_EXECUTION_PROTOCOL = "agentd-design-exec/1" as const;
export interface DesignExecutionLimits {
  max_request_bytes: number;
  max_input_files: number;
  max_input_directories: number;
  max_path_depth: number;
  max_path_bytes: number;
  max_input_file_bytes: number;
  max_input_bytes: number;
  max_output_files: number;
  max_output_file_bytes: number;
  max_output_bytes: number;
  max_output_chars: number;
}
export interface DesignInputFile {
  readonly path: string;
  readonly executable: boolean;
  readonly size: number;
  readonly sha256: string;
  readonly data_base64: string;
}
export interface DesignRootEntry {
  readonly size: number;
  readonly sha256: string;
  readonly data_base64: string;
}
export interface DesignExecutionRequest {
  readonly protocol: typeof DESIGN_EXECUTION_PROTOCOL;
  readonly request_id: string;
  readonly runner: "python" | "klayout";
  readonly script_path: string;
  readonly output_paths: readonly string[];
  readonly files: readonly DesignInputFile[];
  readonly root_entry: DesignRootEntry | null;
  readonly max_output_chars: number;
  readonly input_manifest_sha256: string;
}

const backendBrand: unique symbol = Symbol("controller-configured-design-execution");
export interface AgentdDesignExecution {
  readonly mode: "external-agentd";
  readonly [backendBrand]: true;
}
export type DesignScriptExecution = { readonly mode: "self-sandbox" } | AgentdDesignExecution;
interface HelperConfiguration {
  pythonExecutable: string;
  pythonSha256: string;
  helperPath: string;
  helperSha256: string;
  capabilitySha256: string;
  limits: Readonly<DesignExecutionLimits>;
  helperTimeoutMs: number;
}
const activeBackends = new WeakSet<AgentdDesignExecution>();
const configurations = new WeakMap<AgentdDesignExecution, Readonly<HelperConfiguration>>();
const limitNames = ["max_request_bytes", "max_input_files", "max_input_directories", "max_path_depth", "max_path_bytes", "max_input_file_bytes", "max_input_bytes", "max_output_files", "max_output_file_bytes", "max_output_bytes", "max_output_chars"] as const;

/**
 * TRUSTED STARTUP ONLY. The interpreter/helper and their runtime must be fixed,
 * controller-mounted immutable files. A digest supplied by a candidate is not
 * authority. The helper must verify a live peer and sealed controller evidence
 * before dispatch. Neither ENV nor a caller callback can configure this backend.
 */
export function createAgentdDesignExecution(configuration: HelperConfiguration): AgentdDesignExecution {
  if (process.platform !== "linux") throw new Error("external-agentd requires a verified Linux controller setup");
  if (!configuration || !path.isAbsolute(configuration.pythonExecutable) || !path.isAbsolute(configuration.helperPath)
    || !/^[a-f0-9]{64}$/.test(configuration.helperSha256) || !/^[a-f0-9]{64}$/.test(configuration.pythonSha256) || !/^[a-f0-9]{64}$/.test(configuration.capabilitySha256)) throw new Error("Invalid trusted agentd helper configuration");
  if (!configuration.limits || Object.keys(configuration.limits).sort().join("\0") !== [...limitNames].sort().join("\0")) throw new Error("Unknown or missing execution limit fields");
  for (const name of limitNames) {
    if (!Number.isSafeInteger(configuration.limits?.[name]) || configuration.limits[name] < (name === "max_input_directories" || name === "max_output_files" ? 0 : 1)) throw new Error(`Missing or invalid execution limit: ${name}`);
  }
  if (configuration.limits.max_input_file_bytes > configuration.limits.max_input_bytes || configuration.limits.max_output_file_bytes > configuration.limits.max_output_bytes) throw new Error("File limit exceeds aggregate execution limit");
  if (configuration.limits.max_output_chars > 120_000 || !Number.isSafeInteger(configuration.helperTimeoutMs)
    || configuration.helperTimeoutMs <= 0 || configuration.helperTimeoutMs > 150_000) throw new Error("Invalid execution deadline or log limit");
  // A ceiling is a parser protection, never a grant or a replacement for policy.
  if (configuration.limits.max_request_bytes > 32 * 1024 * 1024 || configuration.limits.max_input_bytes > 16 * 1024 * 1024
    || configuration.limits.max_input_file_bytes > 8 * 1024 * 1024 || configuration.limits.max_output_bytes > 64 * 1024 * 1024
    || configuration.limits.max_output_file_bytes > 32 * 1024 * 1024 || configuration.limits.max_input_files > 4096
    || configuration.limits.max_input_directories > 4096 || configuration.limits.max_output_files > 1024
    || configuration.limits.max_path_bytes > 1024 || configuration.limits.max_path_depth > 32) throw new Error("Execution envelope exceeds adapter safety ceiling");
  const backend = Object.freeze({ mode: "external-agentd" as const, [backendBrand]: true as const });
  configurations.set(backend, Object.freeze({ ...configuration, limits: Object.freeze({ ...configuration.limits }) }));
  return backend;
}

export function assertDesignScriptExecution(value: DesignScriptExecution | undefined): void {
  if (value === undefined) return;
  if (value?.mode === "self-sandbox" && Object.keys(value).length === 1) return;
  if (value?.mode === "external-agentd" && configurations.has(value)) return;
  throw new Error("Unverified design script backend; external-agentd requires trusted startup configuration");
}

export function canonicalDesignJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDesignJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalDesignJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new Error("Noncanonical design execution value");
}
export function designSha256(data: string | Buffer): string { return createHash("sha256").update(data).digest("hex"); }
function descriptorPath(handle: FileHandle, child?: string): string { return `/proc/self/fd/${handle.fd}${child === undefined ? "" : `/${child}`}`; }
function checkedPath(value: string, limits: Readonly<DesignExecutionLimits>): string {
  if (typeof value !== "string" || !value || value.includes("\\") || /\p{C}/u.test(value) || /^[A-Za-z]:/.test(value)
    || path.posix.isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || Buffer.byteLength(part) > 255)
    || value.split("/").length > limits.max_path_depth || Buffer.byteLength(value) > limits.max_path_bytes) throw new Error(`Invalid design execution relative path: ${value}`);
  return value;
}
async function readBoundedFile(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const before = await handle.stat();
  if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error("Design execution input must be a bounded ordinary single-link file");
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - size + 1));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > maxBytes) throw new Error("Design execution input grew beyond its byte limit");
    chunks.push(chunk.subarray(0, bytesRead));
  }
  const after = await handle.stat();
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || size !== before.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) throw new Error("Design execution input changed during snapshot");
  return Buffer.concat(chunks, size);
}

export async function prepareDesignExecutionRequest(input: {
  designCodeDir: string;
  scriptPath: string;
  runner: "python" | "klayout";
  rootVenvPython?: string;
  outputPaths: readonly string[];
  maxOutputChars: number;
  limits: Readonly<DesignExecutionLimits>;
}): Promise<DesignExecutionRequest> {
  const { limits } = input;
  const scriptPath = checkedPath(input.scriptPath, limits);
  if (!scriptPath.endsWith(".py")) throw new Error("External design execution requires a .py entry");
  const outputs = input.outputPaths.map(p => checkedPath(p, limits));
  if (outputs.some(p => outputs.some(other => other !== p && other.startsWith(`${p}/`)))) throw new Error("Declared output paths have a prefix conflict");
  if (new Set(outputs).size !== outputs.length || outputs.length > limits.max_output_files) throw new Error("Duplicate or excessive declared design outputs");
  if (!Number.isSafeInteger(input.maxOutputChars) || input.maxOutputChars < 0 || input.maxOutputChars > limits.max_output_chars) throw new Error("Design output log limit exceeds frozen policy");
  const files: DesignInputFile[] = [];
  let directories = 0, totalBytes = 0;
  const root = await open(input.designCodeDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  async function visit(dir: FileHandle, prefix: string): Promise<void> {
    if (prefix && ++directories > limits.max_input_directories) throw new Error("Too many design input directories");
    const entries = await opendir(descriptorPath(dir));
    for await (const entry of entries) {
      const name = entry.name;
      if (name === ".git") continue;
      const relative = checkedPath(prefix ? `${prefix}/${name}` : name, limits);
      const handle = await open(descriptorPath(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (info.isDirectory()) { await visit(handle, relative); continue; }
        if (files.length + (input.runner === "python" ? 1 : 0) >= limits.max_input_files) throw new Error("Too many design input files");
        const data = await readBoundedFile(handle, Math.min(limits.max_input_file_bytes, limits.max_input_bytes - totalBytes));
        totalBytes += data.length;
        files.push(Object.freeze({ path: relative, executable: (info.mode & 0o111) !== 0, size: data.length, sha256: designSha256(data), data_base64: data.toString("base64") }));
      } finally { await handle.close(); }
    }
  }
  try { await visit(root, ""); } finally { await root.close(); }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (!files.some(f => f.path === scriptPath)) throw new Error("Design script is absent from the immutable input manifest");
  let rootEntry: DesignRootEntry | null = null;
  if (input.runner === "python") {
    if (!input.rootVenvPython) throw new Error("Root .venv Python was not found. Run sync_design_environment first.");
    // Only the already-selected root entry may resolve a runtime symlink. Design
    // input symlinks never use this exception. The controller must match a frozen
    // runtime binding or run these bytes as an explicitly isolated fixture entry.
    const rootPath = await realpath(input.rootVenvPython);
    const handle = await open(rootPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const data = await readBoundedFile(handle, Math.min(limits.max_input_file_bytes, limits.max_input_bytes - totalBytes));
      totalBytes += data.length;
      rootEntry = Object.freeze({ size: data.length, sha256: designSha256(data), data_base64: data.toString("base64") });
    } finally { await handle.close(); }
  }
  const manifest = { files: files.map(({ data_base64: _, ...file }) => file), root_entry: rootEntry === null ? null : { size: rootEntry.size, sha256: rootEntry.sha256 } };
  const request = Object.freeze({ protocol: DESIGN_EXECUTION_PROTOCOL, request_id: randomBytes(16).toString("hex"), runner: input.runner, script_path: scriptPath,
    output_paths: Object.freeze(outputs), files: Object.freeze(files), root_entry: rootEntry, max_output_chars: input.maxOutputChars, input_manifest_sha256: designSha256(canonicalDesignJson(manifest)) });
  if (Buffer.byteLength(canonicalDesignJson(request)) > limits.max_request_bytes) throw new Error("Design execution request exceeds its byte limit");
  return request;
}

async function invokeTrustedHelper(configuration: Readonly<HelperConfiguration>, request: DesignExecutionRequest): Promise<unknown> {
  const interpreter = await open(configuration.pythonExecutable, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let helper: FileHandle | undefined;
  try {
    const interpreterBytes = await readBoundedFile(interpreter, 64 * 1024 * 1024);
    if (designSha256(interpreterBytes) !== configuration.pythonSha256) throw new Error("environment_unverified: trusted interpreter digest mismatch");
    helper = await open(configuration.helperPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const bytes = await readBoundedFile(helper, 1024 * 1024);
    if (designSha256(bytes) !== configuration.helperSha256) throw new Error("environment_unverified: trusted helper digest mismatch");
    // Exec the verified descriptor, never re-open the hash-checked path. The
    // interpreter and imported modules still require immutable controller mounts.
    const maxResponse = Math.ceil(configuration.limits.max_output_bytes / 3) * 4
      + configuration.limits.max_output_files * (configuration.limits.max_path_bytes * 6 + 512)
      + configuration.limits.max_output_chars * 12 + 128 * 1024;
    return await new Promise<unknown>((resolve, reject) => {
      const child = spawn("/proc/self/fd/4", ["-I", "-S", "/proc/self/fd/3", "--stdio"], {
        cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        shell: false, stdio: ["pipe", "pipe", "pipe", helper!.fd, interpreter.fd]
      });
      const chunks: Buffer[] = []; let size = 0, errorSize = 0, failure: Error | undefined;
      const timer = setTimeout(() => { failure = new Error("environment_unverified: controller helper deadline expired; completion is unverified"); child.kill("SIGKILL"); }, configuration.helperTimeoutMs);
      child.stdout!.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxResponse) { failure = new Error("environment_unverified: oversized controller response"); child.kill("SIGKILL"); } else chunks.push(chunk); });
      child.stderr!.on("data", (chunk: Buffer) => { errorSize += chunk.length; if (errorSize > 64 * 1024) { failure = new Error("environment_unverified: oversized helper diagnostics"); child.kill("SIGKILL"); } });
      child.stdin!.on("error", error => { failure ??= new Error(`environment_unverified: helper input failed: ${error.message}`); });
      child.on("error", error => { clearTimeout(timer); reject(new Error(`environment_unverified: helper unavailable: ${error.message}`)); });
      child.on("close", code => {
        clearTimeout(timer);
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(new Error(`environment_unverified: trusted helper exited ${code}`)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks, size).toString("utf8"))); } catch { reject(new Error("environment_unverified: invalid controller response")); }
      });
      child.stdin!.end(canonicalDesignJson(request));
    });
  } finally { await helper?.close(); await interpreter.close(); }
}

interface FrozenOutput { path: string; data: Buffer; }
function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`environment_unverified: invalid ${label} fields`);
  return value as Record<string, unknown>;
}
function canonicalBase64(value: unknown, expectedSize: unknown, maximum: number): Buffer {
  if (typeof value !== "string" || !Number.isSafeInteger(expectedSize) || (expectedSize as number) < 0 || (expectedSize as number) > maximum
    || value.length > Math.ceil(maximum / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("environment_unverified: invalid output byte envelope");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== expectedSize || bytes.toString("base64") !== value) throw new Error("environment_unverified: output size or encoding mismatch");
  return bytes;
}
function validateCompletedResponse(value: unknown, request: DesignExecutionRequest, limits: Readonly<DesignExecutionLimits>, capabilitySha256: string): { stdout: string; stderr: string; outputs: FrozenOutput[] } {
  const response = exactObject(value, ["protocol", "request_id", "request_sha256", "call_id", "status", "exit_code", "stdout", "stderr", "outputs", "execution"], "execution response");
  if (response.protocol !== DESIGN_EXECUTION_PROTOCOL || response.request_id !== request.request_id
    || response.request_sha256 !== designSha256(canonicalDesignJson(request)) || typeof response.call_id !== "string" || !/^[a-f0-9]{32}$/.test(response.call_id)) throw new Error("environment_unverified: controller request binding mismatch");
  const states = ["completed", "script_failed", "input_rejected", "environment_unverified", "resource_limit", "timed_out", "cancelled", "cleanup_unverified"];
  if (typeof response.status !== "string" || !states.includes(response.status)) throw new Error("environment_unverified: invalid execution state");
  if (typeof response.stdout !== "string" || typeof response.stderr !== "string" || [...response.stdout].length + [...response.stderr].length > request.max_output_chars) throw new Error("environment_unverified: invalid or oversized execution logs");
  if (response.exit_code !== null && (!Number.isSafeInteger(response.exit_code) || (response.exit_code as number) < -255 || (response.exit_code as number) > 255)) throw new Error("environment_unverified: invalid raw exit status");
  const execution = exactObject(response.execution, ["mode", "run_id", "parent_launch_token", "capability_sha256", "input_manifest_sha256", "root_entry_sha256", "boundary", "closure"], "execution evidence");
  if (execution.mode !== "external-agentd" || typeof execution.run_id !== "string" || !execution.run_id || execution.run_id.length > 128
    || typeof execution.parent_launch_token !== "string" || !execution.parent_launch_token || execution.parent_launch_token.length > 128
    || execution.capability_sha256 !== capabilitySha256
    || execution.input_manifest_sha256 !== request.input_manifest_sha256 || execution.root_entry_sha256 !== (request.root_entry?.sha256 ?? null)) throw new Error("environment_unverified: execution evidence binding mismatch");
  const boundary = exactObject(execution.boundary, ["protocol", "network", "write_scope", "nested_userns"], "execution boundary");
  if (boundary.protocol !== "agentd-design-boundary/1" || boundary.network !== "none" || boundary.write_scope !== "call-private" || boundary.nested_userns !== false) throw new Error("environment_unverified: incorrect execution boundary");
  const closure = exactObject(execution.closure, ["launcher_reaped", "descendants_stopped", "output_frozen"], "execution closure");
  if (Object.values(closure).some(value => typeof value !== "boolean")) throw new Error("environment_unverified: invalid closure values");
  if (response.status !== "completed") {
    if (!Array.isArray(response.outputs) || response.outputs.length !== 0) throw new Error("environment_unverified: failed calls cannot publish outputs");
    const diagnostics = [response.stdout && `stdout:\n${response.stdout}`, response.stderr && `stderr:\n${response.stderr}`].filter(Boolean).join("\n");
    throw new Error(`run_design_script external-agentd ${response.status}: ${diagnostics || "no outputs published"}`);
  }
  if (response.exit_code !== 0) throw new Error("environment_unverified: completed response has nonzero exit status");
  if (closure.launcher_reaped !== true || closure.descendants_stopped !== true || closure.output_frozen !== true) throw new Error("cleanup_unverified: controller did not close the execution lifecycle");
  if (!Array.isArray(response.outputs) || response.outputs.length !== request.output_paths.length || response.outputs.length > limits.max_output_files) throw new Error("environment_unverified: wrong declared output set");
  let totalBytes = 0;
  const byPath = new Map<string, FrozenOutput>();
  for (const value of response.outputs) {
    const output = exactObject(value, ["path", "size", "sha256", "data_base64"], "frozen output");
    if (typeof output.path !== "string" || !request.output_paths.includes(output.path) || byPath.has(output.path)) throw new Error("environment_unverified: unexpected or duplicate output");
    checkedPath(output.path, limits);
    const data = canonicalBase64(output.data_base64, output.size, limits.max_output_file_bytes);
    totalBytes += data.length;
    if (totalBytes > limits.max_output_bytes || output.sha256 !== designSha256(data)) throw new Error("environment_unverified: output digest or total size mismatch");
    byPath.set(output.path, { path: output.path, data });
  }
  return { stdout: response.stdout, stderr: response.stderr, outputs: request.output_paths.map(p => byPath.get(p)!) };
}

/** Anchors every traversal at directory descriptors; no script-returned host paths. */
async function publishFrozenOutputs(designCodeDir: string, outputs: readonly FrozenOutput[]): Promise<Array<{ path: string; bytes: number }>> {
  const root = await open(designCodeDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const rootLocation = await realpath(descriptorPath(root));
  const parents: Array<{ handle: FileHandle; file: string; output: FrozenOutput }> = [];
  const published: string[] = [];
  let pendingTemporary: { handle: FileHandle; name: string } | undefined;
  async function validateLocation(parent: FileHandle, output: FrozenOutput): Promise<void> {
    if (await realpath(descriptorPath(root)) !== rootLocation
      || await realpath(descriptorPath(parent)) !== path.join(rootLocation, path.posix.dirname(output.path))) {
      throw new Error("Output directory identity changed during publication");
    }
    // Re-open each component from the held root to verify the named chain still
    // selects the held directory; no symlink component is ever followed.
    let current = await open(descriptorPath(root), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      for (const component of output.path.split("/").slice(0, -1)) {
        const next = await open(descriptorPath(current, component), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await current.close(); current = next;
      }
      const [expected, actual] = await Promise.all([parent.stat(), current.stat()]);
      if (expected.dev !== actual.dev || expected.ino !== actual.ino) throw new Error("Output directory identity changed during publication");
    } finally { await current.close(); }
  }
  try {
    // Resolve and preflight ALL destinations before replacing any output.
    for (const output of outputs) {
      const parts = output.path.split("/");
      const filename = parts.pop()!;
      let parent = await open(descriptorPath(root), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        for (const part of parts) {
          await mkdir(descriptorPath(parent, part)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
          const next = await open(descriptorPath(parent, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          await parent.close(); parent = next;
        }
        const existing = await lstat(descriptorPath(parent, filename)).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
        if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error(`Unsafe output destination: ${output.path}`);
        parents.push({ handle: parent, file: filename, output });
      } catch (error) { await parent.close(); throw error; }
    }
    for (const destination of parents) {
      await validateLocation(destination.handle, destination.output);
      const temporary = `.agentd-output-${randomBytes(16).toString("hex")}`;
      const handle = await open(descriptorPath(destination.handle, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      pendingTemporary = { handle: destination.handle, name: temporary };
      try { await handle.writeFile(destination.output.data); await handle.sync(); } finally { await handle.close(); }
      await validateLocation(destination.handle, destination.output);
      await rename(descriptorPath(destination.handle, temporary), descriptorPath(destination.handle, destination.file));
      pendingTemporary = undefined;
      published.push(destination.output.path);
      await validateLocation(destination.handle, destination.output);
    }
    return outputs.map(output => ({ path: `design-repo/design-code/${output.path}`, bytes: output.data.length }));
  } catch (error) {
    throw new Error(`run_design_script output publication failed; published=${JSON.stringify(published)}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (pendingTemporary) await unlink(descriptorPath(pendingTemporary.handle, pendingTemporary.name)).catch(() => undefined);
    await Promise.all(parents.map(parent => parent.handle.close()));
    await root.close();
  }
}

export async function executeExternalDesignScript(input: {
  backend: AgentdDesignExecution;
  designCodeDir: string;
  scriptPath: string;
  runner: "python" | "klayout";
  rootVenvPython?: string;
  outputPaths: readonly string[];
  maxOutputChars: number;
}): Promise<{ stdout: string; stderr: string; outputs: Array<{ path: string; bytes: number }> }> {
  assertDesignScriptExecution(input.backend);
  const configuration = configurations.get(input.backend)!;
  if (activeBackends.has(input.backend)) throw new Error("external-agentd already has an active design call");
  activeBackends.add(input.backend);
  try {
  const request = await prepareDesignExecutionRequest({ ...input, limits: configuration.limits });
  // No retry after disconnect/timeout: an uncertain call must be reconciled by
  // the controller. A new invocation receives a distinct id, never a hidden retry.
  const result = validateCompletedResponse(await invokeTrustedHelper(configuration, request), request, configuration.limits, configuration.capabilitySha256);
  const outputs = await publishFrozenOutputs(input.designCodeDir, result.outputs);
  return { stdout: result.stdout, stderr: result.stderr, outputs };
  } finally { activeBackends.delete(input.backend); }
}
