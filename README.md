# Media Grabber

A Chrome (Manifest V3) extension that detects video and audio streams on the page you're viewing and lets you download them from the toolbar popup.

## Features

- **Automatic detection**: watches network requests per tab and lists media as it loads. The toolbar badge shows how many items were found.
- **Direct files**: `mp4`, `m4v`, `webm`, `mkv`, `mov`, `flv`, `mp3`, `m4a`, `aac`, `ogg`, `opus`, `wav`. Tiny clips and pings (under 100 KB) are ignored.
- **HLS** (`.m3u8`): unencrypted and AES-128 encrypted streams.
- **MPEG-DASH** (`.mpd`): static manifests using `SegmentTemplate` (with or without a timeline), `SegmentList`, or a single `BaseURL`.
- **Popup UI**: lists detected media for the current tab, with a *Clear* button.

## Not supported

- DRM-protected streams (Widevine, PlayReady, FairPlay, etc.).
- Live or dynamic DASH manifests.
- HLS encryption other than AES-128.

## Installation (unpacked)

1. Clone this repository:
   ```bash
   git clone https://github.com/Tola200010/media-grabber-extension.git
   ```
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the cloned folder.

## Usage

1. Open a page and start playing the video or audio.
2. Click the Media Grabber toolbar icon. Detected streams appear in the list.
3. Click an item to download it.

## Project structure

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (MV3) and permissions |
| `background.js` | Service worker: sniffs requests, keeps per-tab list, runs downloads |
| `offscreen.html` / `offscreen.js` | Offscreen document for manifest parsing and segment handling |
| `hls.js` | HLS playlist parsing |
| `dash.js` | MPEG-DASH (MPD) parsing |
| `popup.html` / `popup.js` / `popup.css` | Toolbar popup UI |

## Permissions

`webRequest`, `downloads`, `storage`, `tabs`, `offscreen`, `declarativeNetRequest`, and host access to `<all_urls>`. These are needed to observe media requests on any site and to save the files.

## Disclaimer

Only download content you own or have permission to save. You are responsible for complying with the terms of service of the sites you use and with applicable copyright law.
