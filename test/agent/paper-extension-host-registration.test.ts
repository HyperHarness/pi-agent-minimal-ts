import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeNativeHostManifest } from "../../src/agent/paper-extension-host.js";

test("writeNativeHostManifest writes Chrome native messaging manifest", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "native-host-manifest-"));
  try {
    const manifestPath = path.join(workspace, "com.pi_agent.paper_downloader.json");
    const hostPath = path.join(workspace, "paper-extension-host.exe");
    await writeNativeHostManifest({
      manifestPath,
      hostPath,
      extensionId: "abcdefghijklmnopabcdefghijklmnop"
    });

    assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), {
      name: "com.pi_agent.paper_downloader",
      description: "Pi Agent paper downloader native host",
      path: hostPath,
      type: "stdio",
      allowed_origins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("registration script generates exe native host and registers HKCU browser keys", async () => {
  const script = await readFile(
    path.join(process.cwd(), "scripts", "register-paper-extension-host.ps1"),
    "utf8"
  );

  assert.match(
    script,
    /\[string\]\$WorkspaceDir\s*=\s*\(Resolve-Path\s+-LiteralPath\s+\(Join-Path\s+\$PSScriptRoot\s+"\.{2}"\)\)\.Path/
  );
  assert.match(script, /\$HostExe\s*=\s*Join-Path\s+\$ScriptsDir\s+"paper-extension-host\.exe"/);
  assert.match(script, /set "PI_PAPER_WORKSPACE=%~dp0\.\."/);
  assert.match(script, /node "%~dp0\.\.\\dist\\src\\paper-extension-host\.js"/);
  assert.match(script, /Add-Type\s+-TypeDefinition\s+\$LauncherSource\s+-OutputAssembly\s+\$HostExe\s+-OutputType\s+ConsoleApplication/);
  assert.match(script, /path\s*=\s*\$HostExe/);
  assert.doesNotMatch(script, /path\s*=\s*\$HostPath/);
  assert.doesNotMatch(script, /path\s*=\s*\$HostCmd/);
  assert.match(
    script,
    /Registry::HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\\$NativeHostName/
  );
  assert.match(
    script,
    /Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\\$NativeHostName/
  );
  assert.match(
    script,
    /\$RegistryKey\.SetValue\("",\s*\$ManifestPath,\s*\[Microsoft\.Win32\.RegistryValueKind\]::String\)/
  );
  assert.match(script, /\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.doesNotMatch(script, /Set-Content\s+-LiteralPath\s+\$ManifestPath/);
  assert.match(script, /\$Value\.Replace\('\\',\s*'\\\\'\)\.Replace\('\"',\s*'\\\"'\)/);
  assert.match(script, /Get-Command\s+-CommandType\s+Application\s+-Name\s+"node\.exe"/);
  assert.match(script, /Test-Path\s+-LiteralPath\s+\$HostEntryPath/);
  assert.match(script, /npm\.cmd run build/);

  const launcherSourceMatch = script.match(/\$LauncherSource = @"\r?\n([\s\S]*?)\r?\n"@/);
  assert.ok(launcherSourceMatch);
  const launcherSource = launcherSourceMatch[1];
  assert.match(launcherSource, /UseShellExecute\s*=\s*false/);
  assert.match(launcherSource, /RedirectStandardInput\s*=\s*true/);
  assert.match(launcherSource, /RedirectStandardOutput\s*=\s*true/);
  assert.match(launcherSource, /RedirectStandardError\s*=\s*true/);
  assert.match(launcherSource, /CreateNoWindow\s*=\s*true/);
  assert.match(
    launcherSource,
    /CopyStream\(Console\.OpenStandardInput\(\),\s*process\.StandardInput\.BaseStream\)/
  );
  assert.match(
    launcherSource,
    /CopyStream\(process\.StandardOutput\.BaseStream,\s*Console\.OpenStandardOutput\(\)\)/
  );
  assert.match(
    launcherSource,
    /CopyStream\(process\.StandardError\.BaseStream,\s*Console\.OpenStandardError\(\)\)/
  );
  assert.doesNotMatch(launcherSource, /Console\.Write(?:Line)?\s*\(/);
});
