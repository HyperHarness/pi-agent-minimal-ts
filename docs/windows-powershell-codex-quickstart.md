# Windows PowerShell + Codex Quickstart

This guide is for beginners using Codex Desktop and this repository on Windows PowerShell.

It focuses on the setup that is easy to get wrong on Windows:

- making `npm` resolve correctly in PowerShell
- making Chinese and other non-ASCII input survive the console
- registering the paper downloader extension native host in Windows
- reducing repeated approval prompts for routine Git commands in Codex Desktop

This version is intentionally written so Codex can execute it more reliably.

## 1. Find the actual PowerShell profile first

Do not hardcode a profile path unless you have already checked what PowerShell is using on the current machine.

Run:

```powershell
$PROFILE.CurrentUserAllHosts
```

Use the returned path as the profile file to edit.

Why this matters:

- on some machines the effective profile is not the path you expected
- telling Codex to edit a hardcoded profile path can update the wrong file

If the parent directory does not exist yet, create it before writing the profile.

## 2. Make `npm` work reliably in PowerShell

If `npm` resolves to `npm.ps1`, PowerShell execution policy or script handling can get in the way. The simplest fix is to map `npm` to `npm.cmd` in the profile returned by `$PROFILE.CurrentUserAllHosts`.

Add this line to that profile:

```powershell
Set-Alias -Name npm -Value npm.cmd -Scope Global
```

Then allow user-level PowerShell profiles and local scripts:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Close and reopen PowerShell, then verify:

```powershell
Get-Command npm | Format-List Source,Name,CommandType,Definition
```

Expected result:

- `CommandType` should be `Alias`
- `Definition` should be `npm.cmd`

Install dependencies from the repository root:

```powershell
npm install
```

This lets Playwright install its managed browser during dependency setup.

If you intentionally use:

```powershell
npm install --ignore-scripts
```

then normal build and test flows still work, but `open_paper_page_for_login` and explicit Playwright paper fallback paths will need one of these before they can launch a browser:

- set `PI_PAPER_CHROME_EXECUTABLE` to an existing local Chrome or Chromium executable
- run `npx playwright install chromium`

## 3. Make UTF-8 persistent if you type Chinese into the agent

If you plan to type Chinese or other non-ASCII text directly into the REPL, switch the PowerShell console to UTF-8.

For the current shell only:

```powershell
chcp 65001
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
```

If you use Codex or the agent regularly, put the same lines in the PowerShell profile so every new shell starts in UTF-8:

```powershell
chcp 65001 > $null
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
```

Verify after reopening PowerShell:

```powershell
[pscustomobject]@{
  CodePage = (chcp)
  InputEncoding = [Console]::InputEncoding.WebName
  OutputEncoding = [Console]::OutputEncoding.WebName
} | Format-List
```

Expected result:

- active code page should be `65001`
- `InputEncoding` should be `utf-8`
- `OutputEncoding` should be `utf-8`

Without UTF-8 console encoding, PowerShell can turn non-ASCII input into `?` before it reaches Node. This is especially visible with `search_arxiv`, where a malformed query can trigger an arXiv HTTP 500 instead of a normal search response.

## 4. Start the agent

Example:

```powershell
$env:OPENAI_API_KEY="your-key"
$env:PI_PROVIDER="openai"
$env:PI_MODEL="gpt-5.4"
npm run agent
```

<a id="paper-downloader-extension"></a>

## 5. Paper Downloader Extension

Detailed setup and troubleshooting live in [paper-downloader-extension.md](paper-downloader-extension.md).

1. Run `npm.cmd run build`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer Mode.
4. Load unpacked extension from `extension/paper-downloader`.
5. Copy the extension id.
6. Run `powershell -ExecutionPolicy Bypass -File scripts/register-paper-extension-host.ps1 -ExtensionId <id>`.
7. Restart the browser.

### Verify native host registration

Chrome:

```powershell
reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pi_agent.paper_downloader /ve
```

Edge:

```powershell
reg query HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.pi_agent.paper_downloader /ve
```

The default value should point to this repository's native messaging manifest:

```text
.browser-profile\native-messaging\com.pi_agent.paper_downloader.json
```

If the extension ID changes after reinstalling the unpacked extension, rerun:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-paper-extension-host.ps1 -ExtensionId <new-extension-id>
```

## 6. Reduce routine Git approval prompts in Codex Desktop

This section is intentionally conservative.

Goal:

- keep Codex approval mode on `on-request`
- allow only routine, low-risk Git commands
- avoid blanket permission for all Git commands

Target files:

- `%USERPROFILE%\.codex\rules\default.rules`
- `%USERPROFILE%\.codex\config.toml`

Quick self-check from this repository:

```powershell
npm run doctor:approval
```

The doctor reads the project guidance, `%USERPROFILE%\.codex\config.toml`, `%USERPROFILE%\.codex\rules\default.rules`, and the current PowerShell startup environment. It reports a concrete conclusion, missing or mismatched Git prefix rules, and the exact safe rule lines expected by this project.

To append missing safe rules automatically:

```powershell
npm run doctor:approval -- --apply
```

The apply mode only appends exact allowlisted prefixes. It does not add broad rules such as `git` or `git commit`.

If the doctor reports `Windows sandbox is unelevated`, safe prefix rules can still be correct while Git write commands fail inside the sandbox with errors such as `.git/index.lock`. In that case a follow-up prompt for `git add`, `git commit`, or `git push` is a sandbox escalation prompt, not a missing `default.rules` entry. Persist the external-execution approval in the Codex prompt, or change the Windows sandbox policy and restart Codex Desktop before re-testing.

Important execution note:

- these files are outside the repository workspace
- Codex will usually need approval before editing them
- the agent should request approval and then continue, not stop after asking
- after changing `default.rules`, fully restart Codex Desktop before judging whether the new rules worked

### Safe rules that should exist

Ensure these allow rules exist in `%USERPROFILE%\.codex\rules\default.rules`:

```txt
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git status"], decision="allow")
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git diff"], decision="allow")
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git log"], decision="allow")
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git branch"], decision="allow")
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git rev-parse"], decision="allow")
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git show"], decision="allow")
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git add"], decision="allow")
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git restore --staged"], decision="allow")
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git commit -m"], decision="allow")
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git commit --amend --no-edit"], decision="allow")
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git switch"], decision="allow")
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git checkout -b"], decision="allow")
prefix_rule(pattern=["C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-Command", "git push"], decision="allow")
```

These are prefix rules, so a narrow safe prefix like `git add` also covers `git add -u`, and `git push` also covers `git push -u origin`.

Why the all-caps `C:\\WINDOWS` prefix matters:

- the allow rule must match the actual launcher prefix Codex uses
- on this setup, the effective PowerShell prefix used by Codex was `C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
- if the rules file uses a different spelling such as `C:\\Windows\\...`, routine Git commands can still prompt for approval

### Commands that should not be permanently allowed

Do not add rules for:

```txt
git
git fetch
git pull
git merge
git rebase
git cherry-pick
git stash
git tag
git reset --hard
git clean -fd
git clean -fdx
git checkout --
git restore
git branch -D
```

### Recommended edit procedure

1. Read `%USERPROFILE%\.codex\rules\default.rules`.
2. Read `%USERPROFILE%\.codex\config.toml`.
3. Check whether `approval_policy` already exists.
4. If it exists, confirm it is still `on-request`.
5. If it does not exist, add `approval_policy = "on-request"` without replacing the rest of the file.
6. Check which safe rules already exist.
7. Append only the missing safe rules.
8. Do not remove unrelated existing rules.
9. Re-read both files after editing.
10. Verify every desired safe rule is present once.
11. Confirm no forbidden blanket or destructive rule was introduced.
12. Restart Codex Desktop.
13. In an existing Git repository, verify that read-only commands like the ones below run without approval prompts:

```powershell
git status --short --branch
git diff --stat
git log -1 --oneline
git branch --show-current
git rev-parse --show-toplevel
git show --stat -1
```

### Verification pitfalls to avoid

Do not use loose substring matching when checking rules.

Example problem:

- searching for `git branch` can also match `git branch -d`

Use exact line matching or exact rule-string matching instead.

If approval prompts still appear after restart:

- re-read `%USERPROFILE%\.codex\rules\default.rules` and confirm the prefix is still exactly `C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
- re-read `%USERPROFILE%\.codex\config.toml` and confirm `approval_policy = "on-request"` is still present
- compare the exact command launcher prefix Codex is using with the prefix in the rule file instead of assuming they are equivalent
- do not paste machine-specific usernames, session logs, or other local-only paths into shared documentation

## 7. If you want Codex to apply these rules for you

Use an instruction like this:

```text
Read docs/windows-powershell-codex-quickstart.md and apply the Codex Desktop approval-rule section exactly. Only append missing safe rules in %USERPROFILE%\.codex\rules\default.rules, keep approval_policy = "on-request" in %USERPROFILE%\.codex\config.toml, do not replace whole files, and re-read both files to verify the result.
```

## 8. Recommended first-run checklist

Use this order on a fresh Windows machine:

1. Query `$PROFILE.CurrentUserAllHosts` and update the actual PowerShell profile.
2. Add the `npm` alias to that profile.
3. Set `RemoteSigned` for the current user.
4. Add the UTF-8 console lines to the same profile if you will type Chinese into the REPL.
5. Reopen PowerShell.
6. Verify `npm` resolves to `npm.cmd`.
7. Verify the console is running in UTF-8 if needed.
8. Run `npm install`.
9. Run `npm run build`.
10. Start the agent with your API key and model.
11. If you use publisher paper downloads, load the browser extension and register the native host.
12. Optionally update Codex approval rules for routine Git commands.
