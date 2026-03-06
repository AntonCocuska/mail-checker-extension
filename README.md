# Mail Checker Extension

Chrome extension for quick email checking from popup. Supports two providers:

- **Roundcube** (me-n.com) — auto-login with email/password
- **FirstMail** (firstmail.ltd) — uses browser session (login on site with "Memorize session")

## Features

- Dark themed popup UI
- Inbox list with read/unread indicators
- Message preview with HTML rendering
- Delete messages (with confirmation)
- Auto-split credentials on paste (login;password)
- Cached inbox for instant load
- 15s fetch timeout with clear error messages

## Install

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this folder

Or load the `mail-ext.zip` from releases.

## Files

| File | Description |
|------|-------------|
| `manifest.json` | Manifest V3, permissions: storage + cookies |
| `popup.html` | UI — settings, mail list, message view |
| `popup.js` | Logic — RC + FM providers, cache, rendering |
| `icon.png` | Extension icon |

## Permissions

- `storage` — save settings and mail cache
- `cookies` — read session cookies for mail providers
- `host_permissions` — access to me-n.com and firstmail.ltd
