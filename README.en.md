# Suno Downloader · Chrome Extension

[简体中文](README.md) | **English**

**Suno Downloader** is a lightweight Chrome extension built with **Manifest V3**. It discovers song links already loaded on the current **suno.com** page and saves playback-source audio as **M4A (Opus-in-MP4)** for your own music or works you are authorized to download.

Use the floating song-list panel to view cover art, titles, authors, duration and style, then download individual tracks for personal backup. Audio is saved without recording or transcoding; this does not make it a lossless master, WAV export or stem download.

**Extension version: v1.1.1. No build step or third-party dependencies.**

## Features

- Discover and deduplicate song links on the current Suno page.
- Keep the current song at the top of the list.
- Show song metadata and cover art.
- Save individual playback-source audio files as `.m4a`.
- Process audio locally in the browser using the Web Crypto API.
- Use the supported signed-in or guest playback flow, subject to Suno's current permissions and service restrictions.

## Install in Chrome

1. Open [Releases](../../releases/latest) and download **Source code (zip)** under **Assets**. Alternatively, use **Code → Download ZIP** on the repository homepage to get the latest default-branch files.
2. Extract the archive and locate the folder containing `manifest.json`.
3. Open `chrome://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and select that folder.
5. Open or refresh a Suno page. The floating **⬇ Suno 下载** button should appear at the bottom right.

The extension interface is currently in Chinese: **下载** means **Download**. This English README documents installation and behavior; it does not change the interface language.

## Usage

1. Open a song page, profile or another Suno page containing song links.
2. Click **⬇ Suno 下载** to open the song list.
3. Click **下载** next to the track you want to save.
4. Check Chrome's download list and the folder configured in your browser settings.

The extension rescans loaded page links approximately every two seconds. Scrolling may load more songs. It does not enumerate an entire account or playlist, and it has no batch-download button. A success message means a browser download was triggered; Chrome's download list is the final status.

## Permissions and privacy

| Permission or host | Purpose |
| --- | --- |
| `cookies` and `suno.com` | Read the current Suno `__session` cookie when requesting a track's playback key |
| `studio-api-prod.suno.com` | Request song metadata and playback-key material |
| The specified CloudFront host, `cdn1.suno.ai`, `cdn2.suno.ai` | Fetch playback-source audio |

Session material is used at runtime for requests to Suno and local processing. It is not written to extension storage or sent to the project author. The extension has no project-operated server, analytics service or remote script loader. Scanning a page makes metadata requests to Suno, and cover art loads from its associated image URLs.

Background messages are accepted only from this extension's content scripts on `https://suno.com/`. Audio requests are restricted to the three configured CDN hosts and reject redirects.

The repository and distribution contain no real Suno account records, personal audio samples, browser screenshots or real cookies or tokens. Offline tests use synthetic data.

## For coding agents and maintainers

This repository contains a browser extension. Its entry points are:

| File | Responsibility |
| --- | --- |
| `manifest.json` | Manifest V3 configuration, permissions and script entry points |
| `content.js` | DOM song discovery, metadata, panel UI and local audio processing |
| `background.js` | Session-cookie lookup and requests to approved audio CDNs |
| `test.js` | Dependency-free offline regression checks using Node.js built-ins |

There is no command-line downloader, MCP server or separate agent API. Browser use requires the installed extension and any access Suno requires for the selected work.

Run the offline checks with Node.js:

```sh
node test.js
```

Checks cover cached-metadata reuse, message senders, the CDN allowlist, redirect rejection and binary transfer. They do not verify live Suno availability. After editing the extension, reload it in `chrome://extensions`, then refresh Suno.

## Limitations

- Private, deleted, unfinished or unauthorized tracks may not be downloadable. Public playback does not grant copyright or reuse permission.
- This is an unofficial implementation based on the web playback flow; Suno interface or API changes may break it.
- Only song links already loaded in the page are discovered.
- Output is playback-source M4A; there is no MP3 conversion, WAV export or stem separation. Player compatibility depends on Opus-in-MP4 support.
- A valid MP4 `ftyp` header is only a basic container check; it does not prove completeness, playability or codec type.
- Audio is processed in memory and may encounter browser-memory or extension-message limits.

## License and responsible use

The code is available under the [MIT License](LICENSE). That license does not cover songs, cover art, trademarks or other third-party content.

This project is not affiliated with Suno. Use it for learning, technical research and backups of your own or authorized works. Follow applicable platform terms and rules. Do not use it to infringe copyright or bypass access permissions. Downloading a file does not grant commercial, adaptation or redistribution rights.
