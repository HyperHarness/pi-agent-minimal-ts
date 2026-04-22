# pi-agent-minimal-ts

Minimal TypeScript agent built on [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai) and [`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core).

It provides:

- multi-turn terminal chat
- tool calling with a minimal local toolset
- model selection by provider and model ID
- optional `baseUrl` override for OpenAI-compatible or proxied endpoints

## Requirements

- Node.js
- npm
- an API key for the provider you want to use

## Install

Prefer a non-elevated install first:

```powershell
npm install --ignore-scripts
```

This project does not require install-time scripts to build or run, so `npm install --ignore-scripts` is the default recommendation when you want to avoid elevation or run inside a restricted environment. After installing dependencies this way, you can verify the setup with `npm run build` or `npm test`.

If you are running in Windows PowerShell and `npm` does not resolve correctly, configure PowerShell first so `npm` resolves to `npm.cmd`, then run the same non-elevated install command.

### Windows PowerShell

1. Create or edit `C:\Users\<your-user>\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`.
2. Add:

```powershell
Set-Alias -Name npm -Value npm.cmd -Scope Global
```

3. Allow user-level PowerShell profiles and local scripts:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

4. Reopen PowerShell so the profile is loaded.
5. Install dependencies:

```powershell
npm install --ignore-scripts
```

After reopening PowerShell, `npm` will resolve through `npm.cmd` instead of `npm.ps1`.

### Other environments

```powershell
npm install --ignore-scripts
```

## Run

Use environment variables:

```powershell
$env:OPENAI_API_KEY="your-key"
$env:PI_PROVIDER="openai"
$env:PI_MODEL="gpt-5.4"
npm run agent
```

Use CLI arguments:

```powershell
npm run agent -- --provider openai --model gpt-5.4
```

Use an OpenAI-compatible proxy or relay:

```powershell
$env:OPENAI_API_KEY="your-proxy-key"
npm run agent -- --provider openai --model gpt-5.4 --base-url https://your-proxy.example.com/v1
```

You can also set `PI_BASE_URL` instead of passing `--base-url`.

Exit the REPL with `exit` or `quit`.

## Built-in Tools

- `get_time`: returns the current time, optionally for a given timezone
- `read_file`: reads a UTF-8 text file from inside the current workspace

`read_file` rejects absolute paths and paths that resolve outside the workspace.

## Scripts

- `npm run build`: compile TypeScript to `dist/`
- `npm test`: run the automated test suite
- `npm run agent`: build and start the agent

## Test

```powershell
npm test
```

## Notes

- conversation history is kept in memory only
- failed assistant turns are not persisted into the ongoing context
- very large files are not size-limited yet, so `read_file` can still create memory pressure if misused
