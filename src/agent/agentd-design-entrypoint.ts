import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { createAgentdDesignExecution, designSha256, type AgentdDesignExecution, type DesignExecutionLimits } from "./design-script-execution.js";

export const AGENTD_DESIGN_CLIENT_CONFIG = "/run/agentd-design-client.json";
export const AGENTD_DESIGN_CLIENT_HELPER = "/run/agentd-design-client.py";

/** Supplied as code constants by an independently reviewed, pinned launch module.
 * Never derive these from the client document, argv, ENV or candidate content. */
export interface ReviewedAgentdDesignPins {
  readonly pythonPath: string;
  readonly pythonSha256: string;
  readonly helperSha256: string;
  readonly capabilitySha256: string;
}
function validatePins(pins: ReviewedAgentdDesignPins): void {
  if (!pins || !path.isAbsolute(pins.pythonPath) || path.normalize(pins.pythonPath) !== pins.pythonPath
    || [pins.pythonSha256, pins.helperSha256, pins.capabilitySha256].some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("Independent reviewed launch pins are required");
  }
}

/** Pure binding check for the fixed controller document. Parsing never authenticates a controller. */
export function bindReviewedAgentdClientDocument(value: unknown, pins: ReviewedAgentdDesignPins): AgentdDesignExecution {
  validatePins(pins);
  const keys = ["protocol", "mode", "helperPath", "helperSha256", "pythonPath", "limits", "timeoutSeconds", "capabilitySha256"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== keys.sort().join("\0")) throw new Error("Invalid fixed agentd client document");
  const document = value as Record<string, unknown>;
  if (document.protocol !== "agentd-design-exec/1" || document.mode !== "external-agentd"
    || document.helperPath !== AGENTD_DESIGN_CLIENT_HELPER || document.pythonPath !== pins.pythonPath
    || document.helperSha256 !== pins.helperSha256 || document.capabilitySha256 !== pins.capabilitySha256
    || !Number.isSafeInteger(document.timeoutSeconds) || (document.timeoutSeconds as number) < 1 || (document.timeoutSeconds as number) > 120) {
    throw new Error("Fixed agentd client document does not match independent launch pins");
  }
  return createAgentdDesignExecution({
    pythonExecutable: pins.pythonPath, pythonSha256: pins.pythonSha256,
    helperPath: AGENTD_DESIGN_CLIENT_HELPER, helperSha256: pins.helperSha256,
    capabilitySha256: pins.capabilitySha256, limits: document.limits as DesignExecutionLimits,
    // Transport grace only; controller script/runtime deadline remains <=120s.
    helperTimeoutMs: ((document.timeoutSeconds as number) + 30) * 1000
  });
}

// Fixed stdlib bootstrap, not candidate code. Python provides fstatvfs(ST_RDONLY),
// which Node's fs.statfs does not expose. No host path or code comes from stdin.
export const READ_FIXED_CONTROLLER_DOCUMENT = `import os,sys,stat,json
fds=[]
try:
 for path,maximum,links in [('/run/agentd-design-client.json',65536,(0,1)),('/run/agentd-design-client.py',1048576,(1,))]:
  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK);fds.append(fd)
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_nlink not in links or not 0<st.st_size<=maximum or not os.fstatvfs(fd).f_flag&os.ST_RDONLY: raise ValueError('unverified mount')
 data=os.pread(fds[0],65537,0)
 if len(data)!=os.fstat(fds[0]).st_size: raise ValueError('changed document')
 sys.stdout.buffer.write(data)
except Exception:
 sys.stderr.write('AGENTD_FIXED_CONFIG_UNVERIFIED\\n');sys.exit(125)
finally:
 for fd in fds: os.close(fd)
`;

export async function loadReviewedAgentdDesignExecution(pins: ReviewedAgentdDesignPins): Promise<AgentdDesignExecution> {
  pins = Object.freeze({ ...pins });
  validatePins(pins);
  const interpreter = await open(pins.pythonPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await interpreter.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > 64 * 1024 * 1024) throw new Error("Unverified launch interpreter");
    // The allocation is fixed by the pre-read stat; growing files cannot create
    // unbounded reads. A post-read identity comparison rejects concurrent edits.
    const bytes = Buffer.alloc(before.size);
    let size = 0;
    while (size < bytes.length) {
      const read = await interpreter.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await interpreter.stat();
    if (size !== before.size || before.size !== after.size || before.ino !== after.ino || before.dev !== after.dev
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || designSha256(bytes) !== pins.pythonSha256) throw new Error("Launch interpreter does not match independent pin");
    const raw = await new Promise<string>((resolve, reject) => {
      const child = spawn("/proc/self/fd/3", ["-I", "-S", "-c", READ_FIXED_CONTROLLER_DOCUMENT], {
        cwd: "/", shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        stdio: ["ignore", "pipe", "pipe", interpreter.fd]
      });
      const chunks: Buffer[] = []; let length = 0, diagnostics = 0, failed = false;
      const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, 5000);
      child.stdout!.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 65536) { failed = true; child.kill("SIGKILL"); } else chunks.push(chunk); });
      child.stderr!.on("data", (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 4096) { failed = true; child.kill("SIGKILL"); } });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => { clearTimeout(timer); if (failed || code !== 0) reject(new Error("environment_unverified: fixed immutable controller configuration is unavailable")); else resolve(Buffer.concat(chunks, length).toString("utf8")); });
    });
    return bindReviewedAgentdClientDocument(JSON.parse(raw), pins);
  } finally { await interpreter.close(); }
}

/** Entry for a reviewed fixed launch module. No CLI/ENV mode activation exists. */
export async function runReviewedAgentdDesignAgent(pins: ReviewedAgentdDesignPins, options: { argv?: string[] } = {}): Promise<void> {
  const designScriptExecution = await loadReviewedAgentdDesignExecution(pins);
  const { main } = await import("../design-agent.js");
  await main({ argv: options.argv, designScriptExecution });
}
