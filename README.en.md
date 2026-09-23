# ChatGPT Web Next

<p align="center">
  <img src="docs/images/icon.png" width="112" alt="ChatGPT Web Next icon">
</p>

<p align="center">
  An independent ChatGPT desktop container for macOS and Windows with native sign-in, isolated sessions, egress-network status, download management, and a local session-safety policy.
</p>

<p align="center">
  English · <a href="README.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/IronMan-libingxue/ChatGPT-Web-Next/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/IronMan-libingxue/ChatGPT-Web-Next?display_name=tag&sort=semver"></a>
  <a href="https://github.com/IronMan-libingxue/ChatGPT-Web-Next/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/IronMan-libingxue/ChatGPT-Web-Next/total"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-Universal-111111?logo=apple">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-x64-0078D4?logo=windows11">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-orange"></a>
</p>

> [!IMPORTANT]
> This is an unofficial, source-available project. It is not affiliated with or endorsed by OpenAI. ChatGPT and OpenAI are trademarks of their respective owners. Use of the app remains subject to the applicable service terms.

## Quick downloads

| Platform | Recommended | Alternative |
| --- | --- | --- |
| macOS (Apple Silicon and Intel) | [Download DMG](https://github.com/IronMan-libingxue/ChatGPT-Web-Next/releases/latest/download/ChatGPT-Web-Next-0.2.1-mac-universal.dmg) | [Download ZIP](https://github.com/IronMan-libingxue/ChatGPT-Web-Next/releases/latest/download/ChatGPT-Web-Next-0.2.1-mac-universal.zip) |
| Windows x64 | [Download installer](https://github.com/IronMan-libingxue/ChatGPT-Web-Next/releases/latest/download/ChatGPT-Web-Next-0.2.1-windows-x64-setup.exe) | [Download portable build](https://github.com/IronMan-libingxue/ChatGPT-Web-Next/releases/latest/download/ChatGPT-Web-Next-0.2.1-windows-x64-portable.exe) |

[All releases](https://github.com/IronMan-libingxue/ChatGPT-Web-Next/releases) · [SHA-256 checksums](https://github.com/IronMan-libingxue/ChatGPT-Web-Next/releases/latest/download/SHA256SUMS.txt)

Version 0.2.1 completed full functional acceptance on macOS. Both Windows packages were also manually validated by the user on multiple physical machines and multiple Windows versions. The current packages are not Apple-notarized or commercially code-signed for Windows, so the operating system may show a source or security warning. Download only from this repository's Releases page and verify the checksum.

## Preview

> Screenshots use documentation-only example IP addresses and fictional locations. They contain no real account, conversation, or network data.

![Compact status bar, response latency, and local session-safety countdown](docs/images/toolbar-light.png)

<table>
  <tr>
    <td width="42%"><img src="docs/images/downloads-light.png" alt="Download manager"></td>
    <td width="58%"><img src="docs/images/session-safety-cleared.png" alt="Local session safety cleanup completed"></td>
  </tr>
  <tr>
    <td align="center">Download management</td>
    <td align="center">Local session-safety cleanup</td>
  </tr>
</table>

## Highlights

- Preserves ChatGPT's native Google sign-in popup and two-step verification flow; the regular window uses a dedicated persistent profile.
- Gives every incognito window its own temporary profile and removes its cookies, cache, and web storage when closed.
- Shows the current ChatGPT egress IP, estimated location, time zone, local time, and response latency.
- Provides a device-local IP and session-safety policy to reduce unattended retention, repeated account reuse, and high-concurrency reuse risk.
- Tracks ChatGPT downloads and reveals completed files in Finder or File Explorer; clearing the list never deletes the files.
- Supports normal refresh, cache-bypassing refresh, page zoom, light/dark appearance, and five built-in icons.
- Keeps encrypted device state, detection records, download history, and preferences separate. No cloud backend is used.

## IP and session-safety policy

The app observes only the local state required for the current web session. After it confirms that a protected work state was submitted by this device and accepted by the service:

1. The status indicator stays red and the local 96-hour reminder restarts.
2. A non-cancellable safety countdown appears immediately.
3. At 10 seconds, the app clears all regular and incognito ChatGPT sign-in data, cookies, cache, web storage, and current network display, then prevents another sign-in during that exit cycle.
4. At 30 seconds, every app window closes and the app exits.

This is a local risk-control measure. It does not copy browser cookies, upload device records, or stop work already running in the cloud. It cannot guarantee that Google or OpenAI will not request verification, and it is not a verification-bypass tool.

## Privacy boundaries

- No chat body, attachment contents, password, verification code, cookie, token, full request, or full conversation identifier is stored.
- The app does not read profiles from everyday Chrome, Edge, ChatGPT Web, or ChatGPT Web2 installations.
- Location is an IPWho.is estimate for the currently observed egress IP, not a historical sign-in location.
- Only the user-visible local status fields are retained; clearing web sign-in data does not erase the device-safety state.

See [Privacy and security](docs/PRIVACY.en.md) for details.

## Installation notes

### macOS

This build uses a local testing signature, not Apple Developer ID notarization. After verifying the SHA-256 checksum, use “System Settings → Privacy & Security” to allow the app if macOS blocks it. Do not disable Gatekeeper globally. macOS may ask for access to “ChatGPT Web Next Safe Storage” when the encrypted local record is first created.

### Windows

The current Windows packages do not have a commercial code-signing certificate, so SmartScreen may identify an unknown publisher. Confirm that the file came from this repository and verify its SHA-256 checksum before running it. Uninstalling the setup build does not automatically erase app data; the portable build also keeps its dedicated profile under the current Windows user.

## Development

Node.js 24 and pnpm 11 are recommended:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
```

Build packages with:

```bash
pnpm dist:mac
pnpm dist:win
```

Real account passwords and two-step verification must always be entered by the user. Set an isolated `CHATGPT_WEB_NEXT_TEST_ROOT` for tests; never point tests at a real installed profile.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before opening an issue or change. Never post passwords, cookies, tokens, account email addresses, or conversation text.

## License

The source is available under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal study, research, testing, and other noncommercial purposes are permitted. **Commercial use is prohibited** unless the project owner grants separate written permission.

Because of this noncommercial restriction, the project is source-available rather than OSI open source.
