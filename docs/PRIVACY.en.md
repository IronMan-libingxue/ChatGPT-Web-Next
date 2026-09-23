# Privacy and Security

ChatGPT Web Next is a local desktop container. It provides no project-hosted account system or cloud backend.

## Stored locally

- A random device identifier and a redacted display value.
- Session-safety state, last confirmed time, remaining duration, and anonymous deduplication digests.
- The account display name, project name, conversation title, and trigger time shown by the page, limited to 10 records retained for seven days.
- Download file name, size, status, time, and local save path, limited to 50 records retained for seven days.
- Icon choice, location cache, and required interface preferences.

Device state, detection records, download history, and preferences are stored separately and use operating-system encryption when available. Records are replaced atomically to reduce partial writes after interruption.

## Not stored

- Passwords, two-step verification codes, cookies, tokens, or sign-in credentials.
- Conversation text, attachment contents, complete requests, complete responses, or full conversation identifiers.
- Google or ChatGPT account email addresses.
- Hardware serial numbers.
- Profiles from everyday Chrome, Edge, ChatGPT Web, or ChatGPT Web2 installations.

## Network requests

- ChatGPT pages and sign-in requests are handled by their original websites.
- The egress IP is confirmed through `chatgpt.com/cdn-cgi/trace` using the same session as the current ChatGPT page.
- A confirmed IP may be sent to IPWho.is to estimate location and time zone.
- Device state, detection records, download history, and preferences are never uploaded by this project.

## Data cleanup

Clearing cache manually does not sign the user out. Clearing sign-in and web data manually, or reaching the session-safety deadline, removes ChatGPT cookies, cache, and web storage from this app. It does not erase device-safety state, detection records, downloaded files, or the selected icon.

“Clear list” removes only download records, never downloaded files.
