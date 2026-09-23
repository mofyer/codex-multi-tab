[简体中文](README.md) | English

# Codex Multi Tab

Version 0.5.0 adds saved ChatGPT accounts: save the current account, add another through official browser login, rename or remove saved entries, and switch with a window reload. Saved credentials use VS Code SecretStorage. This first implementation supports verified local, file-based ChatGPT authentication only. Keyring, remote, WSL, and API key modes are not supported. End tasks and save drafts before switching: clients sharing the same CODEX_HOME share the login cache. Expired credentials may require signing in again. See [design and verification scope](docs/multi-account.md).

<img src="assets/icon.png" alt="Codex Multi Tab icon" width="96" height="96">

Open multiple independent Codex tabs in VS Code, manage conversations for your current project, and view your official account and usage in the sidebar.

This is a community extension with no affiliation with OpenAI. It requires the official **Codex extension (`openai.chatgpt`)**, which provides chat, sign-in, models, and tools.

Native enhancements modify audited extension assets with backups and compatibility checks. Future Codex versions may require adaptation. See the platform and version coverage below before installing.

## Features

- **Independent tabs and split editors:** Each new tab is a separate editor tab that you can drag into another editor group. Its title follows the current conversation and any name changes.
- **Conversations scoped to your project:** Lists, search results, and pinned conversations include only conversations within the current workspace roots and their subdirectories. Multi-folder workspaces are supported. Conversations are grouped into pinned, today, and recent sections.
- **Quick access to past conversations:** Click a conversation in the sidebar to focus its existing tab or open a new one. Pin, unpin, and rename actions appear on hover or keyboard focus and are also available in the context menu.
- **Official running status:** Running conversations display a spinner, with status synchronized every 2 seconds. You can stop the turn that was current when you clicked. Stopping is unavailable when the running status or turn cannot be confirmed.
- **Account and official usage:** View the plan, usage windows, and reset times supplied by Codex, with manual refresh available. Once the sidebar is active, it checks sign-in status every minute. When signed in, it automatically refreshes your account, usage, and reset cards while preserving conversation search and focus.
- **Official usage reset cards (reset credits):** View the available count, card names, and expiration times. Confirming a reset consumes the selected real card. An uncertain result never triggers an automatic retry that could consume another card.
- **Native history enhancements:** Pin and rename conversations in the official history panel and continue a past conversation in the current chat tab. A reminder asks you to save unsent content before switching.

> **What Stop does:** The sidebar's Stop action stops only the current turn. It does not pause an autonomous goal or perform the background terminal cleanup associated with the native whole-conversation stop action. To pause an autonomous goal, use the stop control inside the official conversation.

## Screenshots

The interface shown in these screenshots is in Chinese.

![Sidebar account, official usage, and conversations grouped by project](assets/screenshots/sidebar-overview.png)

Sidebar overview example: the actual sidebar interface with simulated account, usage, and conversation data. It illustrates the layout and features, not a real account's entitlements.

![Pin, rename, and stop-current-turn actions shown on hover](assets/screenshots/session-actions.png)

Conversation actions example: the actual sidebar interface with simulated conversation state, showing the pin, rename, and Stop buttons on hover. The context menu provides the same actions. No real running task was affected.

![Independent Codex tabs displayed in side-by-side editor groups](assets/screenshots/independent-tabs.png)

Screenshot from VS Code: three independent blank tabs, two of which are visible in separate editor groups. No real conversation content is shown.

## Installation and use

Requires **VS Code 1.96.2 or later** and the official Codex extension. See the compatibility section below for the platforms and versions covered by verification.

1. Install **Codex Multi Tab** from the extension marketplace, published by `mofyer`, and sign in through the official Codex extension. Alternatively, download a VSIX from [GitHub Releases](https://github.com/mofyer/codex-multi-tab/releases) and install it with **Extensions: Install from VSIX...**.
2. After the enhancements are first applied, save your drafts, wait for running tasks to finish, and reload the window when prompted. This extension does not automatically reload windows or stop tasks.
3. Open a project folder and select **Codex Multi Tab** in the Activity Bar to view your account, usage, and conversations for that project.
4. Click the new-tab icon at the top right of the editor or official Codex sidebar, or use one of the commands below.

The command names currently shown in VS Code are in Chinese. The English descriptions below explain their meaning; they are not alternate command names.

| Action | Command or shortcut |
| --- | --- |
| Open a new independent tab | **Codex：新建独立标签页** |
| Open a new independent tab to the right | **Codex：在右侧新建独立标签页** |
| macOS shortcut | **⌘⌥⇧N** |
| Windows / Linux shortcut | **Ctrl+Alt+Shift+N** (see platform compatibility below) |

Selecting a past conversation in the sidebar focuses its tab or opens a new one. The **native history button** inside the chat page instead switches conversations within the current tab. The switch reminder does not save drafts automatically; canceling keeps the current content.

GPT-5.3 usage is collapsed by default; click **显示更多** (show more) to expand it. The reset card list initially shows two entries; click **查看更多** (view more) to expand it. Hover over an expiration date to see the full time. A usage reset time is not a plan expiration date. Data that Codex does not provide is shown as unavailable, not as zero.

As of 0.5.3, API results determine operation completion; notifications only report the result. Leaving notifications open, or a failure to display them, no longer blocks controls or usage refresh. If an older window is stuck processing a reset, install the update, finish running tasks, save drafts, and reload the window. Refresh the card status before taking further action; do not consume another card to clear the pending state.

## Codex updates and compatibility

Native UI enhancements and sidebar data access depend on internal interfaces and small patches to the official extension's assets. This extension validates audited files, retains original backups, and checks compatibility at startup and when the official extension changes. **Automatic compatibility with every future Codex update is not guaranteed.**

- Regression verification for **0.5.4** covers patch application, idempotency, modification protection, and restoration on copies of installed official **26.917.61114 assets on macOS ARM64**. Windows, Linux, and Intel Macs have not been verified, and native enhancement support is not promised on those platforms.
- A changed release version can reuse a compatibility profile if the audited asset bytes are identical. If file hashes or internal structures change, modification is refused and an adaptation notice is shown.
- Basic tab creation also depends on an internal Codex URI, which may require adaptation if it changes. When the bridge is unavailable, the sidebar displays a compatibility notice and retains the new-tab entry point.
- Updating Codex Multi Tab does not overwrite original backups stored under its VS Code `globalStorage/patch-backups/` directory. **Disabling or uninstalling this extension does not automatically restore modified Codex files.** See the restoration instructions below.

## Limitations

- Project scoping currently supports local folders. No conversations are shown without a project. Remote or virtual workspaces display an unsupported-workspace notice instead of falling back to an account-wide list.
- The today section uses your computer's local date and each conversation's last update time. Larger histories are scanned in batches, with a load-more option when scanning is incomplete.
- Pinning and renaming use official interfaces and state. Synchronization between applications remains subject to Codex's own behavior. This extension does not bypass conversation-in-use safeguards or change sign-in, authentication, model, or tool permissions.
- Restoring each auxiliary tab to its conversation after a restart is not yet supported. Tabs may reopen as blank chats; conversations with sent messages can be reopened from history. Save unsent drafts yourself.

## Support and feedback

Report problems through [GitHub Issues](https://github.com/mofyer/codex-multi-tab/issues). Include your versions, operating system, and reproduction steps as described in the [support guide](SUPPORT.md). Do not upload tokens, real conversation content, or patch backups.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Technical details and restoration

The sidebar shares the official extension's current connection; it does not launch a separate sign-in or model process. The official search interface does not support recursive directory filtering, so the extension process reads paginated metadata, filters it by workspace, and then sends it to the sidebar. Project scoping limits display and operations; it does not mean that the server returns metadata only for the current project. Each batch scans at most ten pages.

Running status comes from official notifications and read-only metadata. Stopping uses separate preparation and submission stages: after rechecking the project and current turn, it submits a single-use ticket. Switching projects or advancing to another turn during preparation cancels submission. Native enhancements remain experimental, and automated checks do not replace verification on an actual platform.

### Restore original files

First disable Codex Multi Tab to prevent automatic reapplication. Keep the scripts from the source tree or installed extension directory, then run:

```sh
node title-patch.js restore "<actual official extension installation directory>" "<patch-backups directory under Codex Multi Tab globalStorage>"
```

Legacy manual patches use `backups/` under the source directory and do not require the third argument:

```sh
npm run title:restore -- "<actual official extension installation directory>"
```

Restoration validates both the backups and the current files. It refuses to overwrite unknown changes made by other tools or official updates. Reload the window after restoration. Backups are not distributed in the Git repository or VSIX.

### Migrate from the old local extension

The marketplace extension ID is `mofyer.codex-multi-tab`; the old local extension ID is `yafan-local.codex-multi-tab`. Do not enable both at the same time.

If you use the old extension, disable it first, save your drafts, wait for tasks to finish, and close all VS Code windows. Copy the entire `patch-backups/` directory from the old extension's `globalStorage` to the corresponding directory for the new extension. Keep the old backup, then install and enable the marketplace version. Do not overwrite an existing backup at the destination. Automatic backup migration between publisher IDs is not supported. New installations do not need this step.

On macOS, the default storage root is `~/Library/Application Support/Code/User/globalStorage/`. The old and new extension subdirectory names are their full IDs listed above.

### Development and packaging

```sh
npm run check
npm test
npm run package
code --install-extension dist/codex-multi-tab-0.5.4-mofyer.vsix --force --do-not-sync
```

Tests cover tab isolation, conversation management, runtime status and stopping, compatibility detection, hash validation, rollback after failed application, and byte-for-byte restoration. Tests that require an official installation package are explicitly marked as skipped when that package is unavailable.

Extension code lives in `src/`, sidebar page resources in `media/sidebar/`, and icons and Marketplace screenshots in `assets/`. Packages are written to `dist/`. Existing restoration commands and the root `backups/` location remain supported. See the [development guide](https://github.com/mofyer/codex-multi-tab/blob/main/docs/development.md) for directory responsibilities and packaging boundaries. Packaging requires Node.js 22 or newer and downloads a pinned VSCE version on first use; `npm run package` runs syntax checks and tests before packaging.
