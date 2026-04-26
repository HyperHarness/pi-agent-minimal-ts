param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [string]$WorkspaceDir = "",

  [ValidateSet("Chrome", "Edge", "Both")]
  [string]$Browser = "Both"
)

$ErrorActionPreference = "Stop"

$NativeHostName = "com.pi_agent.paper_downloader"
$NativeHostDescription = "Pi Agent paper downloader native host"
$ResolvedWorkspaceDir = if ($WorkspaceDir.Trim()) {
  $WorkspaceDir
} else {
  Join-Path $PSScriptRoot ".."
}
$WorkspacePath = (Resolve-Path -LiteralPath $ResolvedWorkspaceDir).ProviderPath

$ScriptsDir = Join-Path $WorkspacePath "scripts"
$HostCmd = Join-Path $ScriptsDir "paper-extension-host.cmd"
$HostExe = Join-Path $ScriptsDir "paper-extension-host.exe"
$HostEntryPath = Join-Path $WorkspacePath "dist\src\paper-extension-host.js"
$ManifestDir = Join-Path $WorkspacePath ".browser-profile\native-messaging"
$ManifestPath = Join-Path $ManifestDir "$NativeHostName.json"

$NodeCommand = Get-Command -CommandType Application -Name "node.exe" -ErrorAction Stop
$NodeExe = $NodeCommand.Source

if (-not (Test-Path -LiteralPath $HostEntryPath -PathType Leaf)) {
  throw "Missing built native host entry at $HostEntryPath. Run npm.cmd run build before registering the paper extension host."
}

New-Item -ItemType Directory -Path $ScriptsDir -Force | Out-Null
New-Item -ItemType Directory -Path $ManifestDir -Force | Out-Null

$HostScript = @'
@echo off
set "PI_PAPER_WORKSPACE=%~dp0.."
node "%~dp0..\dist\src\paper-extension-host.js"
'@
Set-Content -LiteralPath $HostCmd -Value $HostScript -Encoding ASCII

function ConvertTo-CSharpLiteral {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  return '"' + ($Value.Replace('\', '\\').Replace('"', '\"')) + '"'
}

$LauncherSource = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class PaperExtensionHostLauncher
{
    private const string NodeExe = $(ConvertTo-CSharpLiteral $NodeExe);
    private const string HostEntryPath = $(ConvertTo-CSharpLiteral $HostEntryPath);
    private const string WorkspacePath = $(ConvertTo-CSharpLiteral $WorkspacePath);

    private static int Main()
    {
        using (Process process = new Process())
        {
            process.StartInfo.FileName = NodeExe;
            process.StartInfo.Arguments = QuoteArgument(HostEntryPath);
            process.StartInfo.UseShellExecute = false;
            process.StartInfo.RedirectStandardInput = true;
            process.StartInfo.RedirectStandardOutput = true;
            process.StartInfo.RedirectStandardError = true;
            process.StartInfo.CreateNoWindow = true;
            process.StartInfo.EnvironmentVariables["PI_PAPER_WORKSPACE"] = WorkspacePath;

            process.Start();

            Thread stdinThread = new Thread(delegate()
            {
                try
                {
                    CopyStream(Console.OpenStandardInput(), process.StandardInput.BaseStream);
                }
                catch (IOException)
                {
                }
                finally
                {
                    try
                    {
                        process.StandardInput.Close();
                    }
                    catch (InvalidOperationException)
                    {
                    }
                }
            });
            Thread stdoutThread = new Thread(delegate()
            {
                CopyStream(process.StandardOutput.BaseStream, Console.OpenStandardOutput());
            });
            Thread stderrThread = new Thread(delegate()
            {
                CopyStream(process.StandardError.BaseStream, Console.OpenStandardError());
            });

            stdinThread.IsBackground = true;
            stdoutThread.IsBackground = true;
            stderrThread.IsBackground = true;

            stdinThread.Start();
            stdoutThread.Start();
            stderrThread.Start();

            process.WaitForExit();
            stdoutThread.Join();
            stderrThread.Join();
            return process.ExitCode;
        }
    }

    private static void CopyStream(Stream input, Stream output)
    {
        byte[] buffer = new byte[81920];
        int bytesRead;
        while ((bytesRead = input.Read(buffer, 0, buffer.Length)) > 0)
        {
            output.Write(buffer, 0, bytesRead);
            output.Flush();
        }
    }

    private static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
"@

if (Test-Path -LiteralPath $HostExe) {
  Remove-Item -LiteralPath $HostExe -Force
}
Add-Type -TypeDefinition $LauncherSource -OutputAssembly $HostExe -OutputType ConsoleApplication

$Manifest = [ordered]@{
  name = $NativeHostName
  description = $NativeHostDescription
  path = $HostExe
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$ManifestJson = ($Manifest | ConvertTo-Json -Depth 4) + [Environment]::NewLine
$ManifestEncoding = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($ManifestPath, $ManifestJson, $ManifestEncoding)

function Set-NativeMessagingHostRegistryValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RegistrySubKey,

    [Parameter(Mandatory = $true)]
    [string]$ManifestPath
  )

  $RegistryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($RegistrySubKey)
  if ($null -eq $RegistryKey) {
    throw "Unable to create or open HKCU:\$RegistrySubKey for writing."
  }
  try {
    $RegistryKey.SetValue("", $ManifestPath, [Microsoft.Win32.RegistryValueKind]::String)
  } finally {
    $RegistryKey.Close()
  }
}

if ($Browser -eq "Chrome" -or $Browser -eq "Both") {
  Set-NativeMessagingHostRegistryValue `
    -RegistrySubKey "Software\Google\Chrome\NativeMessagingHosts\$NativeHostName" `
    -ManifestPath $ManifestPath
}

if ($Browser -eq "Edge" -or $Browser -eq "Both") {
  Set-NativeMessagingHostRegistryValue `
    -RegistrySubKey "Software\Microsoft\Edge\NativeMessagingHosts\$NativeHostName" `
    -ManifestPath $ManifestPath
}

Write-Host "Registered $NativeHostName at $ManifestPath"
