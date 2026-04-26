# WSL Ubuntu + Codex Quickstart

This guide is for beginners using Codex and this repository inside Windows WSL Ubuntu.

It focuses on the setup that is easy to get wrong when moving from Windows PowerShell to WSL:

- installing and running the agent with Linux `node` and `npm`
- keeping API keys and proxy settings in the WSL shell
- connecting the paper downloader extension in Windows Chrome or Edge back to the WSL workspace
- understanding which steps still need Windows PowerShell

This version is intentionally written so Codex can execute it more reliably.

## 1. Confirm you are in WSL and in the repository

Run:

```sh
uname -a
pwd
```

Expected result:

- `uname -a` should mention Linux or WSL
- `pwd` should be the repository path, for example `/home/<user>/pi-agent-minimal-ts`

If the repository is still on the Windows filesystem under `/mnt/c/...`, consider moving it into the WSL filesystem, for example under `/home/<user>/`. Node dependency installs and test runs are usually faster and less fragile there.

## 2. Verify Node.js and npm

Run:

```sh
node --version
npm --version
```

This project is tested with a modern Node.js release that supports the built-in test runner. If `node` or `npm` is missing, install Node.js in WSL before continuing.

Install dependencies from the repository root:

```sh
npm install
```

This lets Playwright install its managed browser during dependency setup.

If you intentionally use:

```sh
npm install --ignore-scripts
```

then normal build and test flows still work, but `open_paper_page_for_login` and explicit Playwright paper fallback paths will need one of these before they can launch a browser:

- set `PI_PAPER_CHROME_EXECUTABLE` to an existing Linux Chrome or Chromium executable inside WSL
- run `npx playwright install chromium`

If Playwright reports missing Linux browser libraries later, install the browser dependencies from WSL:

```sh
npx playwright install-deps chromium
```

That command may require `sudo` depending on the WSL image.

## 3. Configure API keys in bash

Configure the agent environment in `~/.bashrc` so it is loaded every time you
restart Ubuntu or open a new WSL terminal.

Append this block from WSL Ubuntu, replacing `your-key` with your real key:

```sh
cat >> ~/.bashrc <<'EOF'

# Pi Agent model configuration
export OPENAI_API_KEY="your-key"
export PI_PROVIDER="openai"
export PI_MODEL="gpt-5.4"
EOF
```

Load the new settings into the current terminal without restarting:

```sh
source ~/.bashrc
```

Most Ubuntu WSL terminals load `~/.bashrc` automatically. If your setup uses a
login shell, make sure `~/.profile` also loads `~/.bashrc`:

```sh
grep -Eq '(\.|source)[[:space:]]+~/.bashrc' ~/.profile 2>/dev/null || cat >> ~/.profile <<'EOF'

if [ -f ~/.bashrc ]; then
  . ~/.bashrc
fi
EOF
```

Verify that the required variables are present. This command does not print the
API key:

```sh
printf 'PI_PROVIDER=%s\nPI_MODEL=%s\nOPENAI_API_KEY configured=%s\n' \
  "$PI_PROVIDER" \
  "$PI_MODEL" \
  "$(test -n "$OPENAI_API_KEY" && printf yes || printf no)"
```

Expected result:

```text
PI_PROVIDER=openai
PI_MODEL=gpt-5.4
OPENAI_API_KEY configured=yes
```

To verify persistence after a full Ubuntu restart, run this from Windows
PowerShell:

```powershell
wsl --shutdown
wsl
```

Then run the same `printf ...` verification command in the new WSL terminal.

Optional search and fetch settings can also be appended to `~/.bashrc`:

```sh
cat >> ~/.bashrc <<'EOF'

# Pi Agent optional search and fetch settings
export PI_SEARCH_API_URL="https://search.example.com/query"
export PI_SEARCH_API_KEY="your-search-key"
export PI_FETCH_USER_AGENT="pi-agent-minimal-ts/1.0"
export PI_FETCH_TIMEOUT_MS="10000"
EOF

source ~/.bashrc
```

Do not commit API keys into this repository.

## 4. Build, test, and start the agent

Run:

```sh
npm run build
npm test
```

Start the agent:

```sh
npm run agent
```

Example one-shot startup check that does not call the model:

```sh
printf 'exit\n' | npm run agent
```

If no provider API key is configured, the agent should fail with:

```text
No usable model found with configured authentication.
```

That means the runtime reached model selection but did not find usable credentials. Configure the environment variables above and retry.

<a id="paper-downloader-extension"></a>

## 5. Paper Downloader Extension

Detailed setup and troubleshooting live in [paper-downloader-extension.md](paper-downloader-extension.md).

The common WSL setup is:

- the agent runs in WSL Ubuntu
- Chrome or Edge runs on Windows
- the extension is loaded in the Windows browser
- the native host registration is written to the Windows registry
- the native host points back to this WSL repository through a `\\wsl.localhost\...` path

This means you need both:

- Linux Node.js inside WSL for normal agent development
- Windows Node.js available as `node.exe` for the browser native messaging host

Build the repository from WSL:

```sh
npm run build
```

Open the extension folder in Windows Explorer if needed:

```sh
explorer.exe extension/paper-downloader
```

Then in Chrome or Edge:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer Mode.
3. Choose **Load unpacked**.
4. Select the `extension/paper-downloader` folder.
5. Copy the extension ID from the extension card.

Register the native host from WSL by invoking Windows PowerShell:

```sh
WIN_WORKSPACE="$(wslpath -w "$PWD")"
powershell.exe -ExecutionPolicy Bypass -File "$WIN_WORKSPACE\\scripts\\register-paper-extension-host.ps1" -WorkspaceDir "$WIN_WORKSPACE" -ExtensionId "<extension-id>"
```

Fully restart Chrome or Edge, then restart the agent in WSL:

```sh
npm run agent
```

### Verify native host registration

From WSL, query the Windows registry through Windows `reg.exe`:

```sh
reg.exe query 'HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pi_agent.paper_downloader' /ve
reg.exe query 'HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.pi_agent.paper_downloader' /ve
```

The default value should point to a manifest under this repository's `.browser-profile\native-messaging\` directory, usually through a `\\wsl.localhost\...` path.

If registration fails because `node.exe` is missing, install Node.js on Windows as well as in WSL, reopen the WSL shell, and rerun the registration command.

If the extension ID changes after reinstalling the unpacked extension, rerun the same `powershell.exe ... register-paper-extension-host.ps1` command with the new extension ID.

## 6. Codex notes for WSL

Codex running in WSL uses Linux paths and Linux commands. Do not copy the Windows PowerShell approval rules from [windows-powershell-codex-quickstart.md](windows-powershell-codex-quickstart.md) into a WSL setup; those rules match a Windows PowerShell launcher path.

For WSL, routine commands usually look like direct Linux commands:

```sh
git status --short --branch
git diff --stat
npm test
```

If Codex asks for approval for network or local server operations, evaluate the prompt by the actual command:

- `npm install` needs network access to the npm registry
- tests that bind `127.0.0.1` may need permission to listen on a local port
- browser or Windows registry setup commands cross the WSL/Windows boundary and should be reviewed before approval

Keep destructive commands such as `git reset --hard`, `git clean -fdx`, and broad filesystem deletes out of permanent allow rules.

## 7. If you want Codex to apply the WSL setup for you

Use an instruction like this:

```text
Read docs/wsl-ubuntu-codex-quickstart.md and verify the WSL setup. Install dependencies with npm install if needed, run npm run build and npm test, and report any WSL-specific failure. Do not edit Windows registry or browser native messaging settings unless I explicitly ask.
```

For the paper extension bridge:

```text
Read docs/wsl-ubuntu-codex-quickstart.md and docs/paper-downloader-extension.md. Register the paper downloader native host for Windows Chrome/Edge from this WSL repository using the extension ID I provide, then verify the HKCU native messaging registry keys.
```

## 8. Recommended first-run checklist

Use this order on a fresh WSL Ubuntu setup:

1. Confirm `pwd` is inside the WSL filesystem, preferably under `/home/<user>/`.
2. Verify `node --version` and `npm --version`.
3. Run `npm install`.
4. Run `npm run build`.
5. Run `npm test`.
6. Export your provider API key and model variables.
7. Start the agent with `npm run agent`.
8. If you use publisher paper downloads, load the browser extension in Windows Chrome or Edge.
9. Register the native host through `powershell.exe` with the WSL workspace path.
10. Restart the browser and agent.
