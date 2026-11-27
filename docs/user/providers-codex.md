# Codex

Use your ChatGPT plan or an existing Codex CLI login to run Codex in T3 Code.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers** (select your target environment first for remote machines). T3 Code manages the Codex runtime and signs you in via OpenAI.

- Manage shared usage and credits through **Manage usage** in T3 Code.
- **Remote sign-in**: If sign-in doesn't return automatically, paste the full `localhost` redirect URL into the sign-in panel.
- **Speed options**: Fast and Ultrafast speeds are not available through ChatGPT sharing—[use an existing Codex login](#use-an-existing-codex-login) instead.
- Disconnecting stops running threads while preserving history.

## Use an existing Codex login

Run `codex login` on the environment's machine, then add a Codex instance in **Settings → Providers** via **Configure manually**. See [provider setup](./install.md#providers) for installation details.

If provider status checks time out on a slower machine, set `T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` in the server environment and restart. See [Provider check timeouts](./install.md#provider-check-timeouts).

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers**, or configure multiple CLI logins with a **shadow home** so work and personal accounts can continue the same threads:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | _(leave empty)_     |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

- Both instances must share the same **CODEX_HOME path**. Keep the shadow directory fresh—don't copy your full Codex home into it.
- The shadow account needs file-based credential storage (`auth.json`); see [OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).
- Use a separate **CODEX_HOME path** (no shadow home) if you want completely isolated sessions.

To switch accounts mid-thread, pick another compatible Codex instance sharing the same **CODEX_HOME path** from the model picker.

## Features and options

- **Image generation**: Supported when your Codex version, model, and account allow it. If disabled in Codex config, add `-c features.image_generation=true` to the instance's **Launch arguments** (applies to new sessions).
- **Async questions**: Codex can ask a question while continuing to work; answer in the question panel (steers the active turn or starts a new one) or dismiss it without sending.
- **App access approvals**: Respond to external app access requests directly in chat (one-time, session, or permanent depending on the tool).
- **MCP OAuth sign-in**: Click **Sign in** on the thread notice, approve in your browser, and paste the final redirect URL into **Finish sign-in** (requires provider management permission).
- **Daybreak**: Models with cyber access programs show a **Cyber Access** option (`Standard` or `Daybreak`, initialized from `daybreak = true` in `config.toml`).
- **Usage limits**: Limit stops display the exhausted window, reset time, and (on workspace plans) whether credits or spend limits need adjustment.
- **Feedback to OpenAI**: Send `/feedback <description>` in an existing Codex thread to upload conversation and Codex logs to OpenAI.

## OpenAI Chrome extension

Using your signed-in Chrome profile via [OpenAI's Chrome extension](https://learn.chatgpt.com/docs/chrome-extension) requires a browser connection for the Codex thread. For remote environments, forward the remote page's port or use a reachable URL—T3 Code's built-in preview browser uses its own separate session.

On Windows, T3 Code can only share individual files such as `config.toml` when it
is allowed to create symlinks, which normally means Developer Mode is on. A shadow
home prepared without that still shares sessions, skills, and the other Codex
folders, but each account reads and writes its own files, and that stays true if
Developer Mode is turned on later. To share them, turn it on and use a fresh shadow
directory.

Choose the other account from the thread's model picker. T3 Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home. Picking the same model on the
other account keeps the thread's options, such as reasoning effort.

To move every thread of one account at once, open that account in
**Settings → Providers** and choose **Move threads to…**. Model, options and
scheduled tasks move along; threads with a turn under way stay where they are and
can be moved once they finish. The other account's card moves them back.

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. If you have another signed-in Codex
account that offers the thread's model and is not out of quota, the notice shows
**Continue with** that account, with its remaining quota when Codex reports it.
One click continues the same thread there; accounts that share the thread's
**CODEX_HOME path** are listed first. Otherwise send the message again after the
reset. On a workspace plan the message also says whether your workspace owner
needs to add credits or raise the spend limit to continue sooner.

Codex can keep working past a used-up limit by spending ChatGPT credits, so the
turn never stops. Once the selected account's session or weekly limit is used up,
the composer shows **Switch to** another signed-in account for your next message.

To make that switch without a click, turn on **Settings → General → Switch account at usage
limit**. A new turn then starts on another signed-in account of the same provider that offers the
model, whenever the thread's account has used up a usage window. It applies to messages you send,
to scheduled tasks, and to turns agents start. A turn that is already running stays on its account.
When no other account has allowance left, the turn runs where it was.
