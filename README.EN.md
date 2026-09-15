# YouTube Ext

English | [Русский](README.md)

A set of YouTube enhancements in a single userscript: per-channel playback speed, autoplay control, and a floating player window while scrolling comments.

## Features

### Per-channel playback speed
- Remembers the speed you choose for each channel and applies it automatically to every video from that channel.
- Syncs YouTube's internal player state, so the "Playback speed" menu shows the correct value right after a page reload.
- Survives ads and YouTube's own rate resets: if the speed is dropped after an ad, it is silently restored.
- Distinguishes manual speed changes (preset buttons, slider, hotkeys) from service resets — your manual choice is stored for the channel.

### Video autoplay
- The "Play videos automatically" toggle: when off, an opened video is paused immediately and stays paused until you press Play yourself.
- YouTube may start playback again after the video finishes loading — the script suppresses every automatic start but never interferes after you press Play.
- Ads are left untouched.

### Floating player window
- When the player scrolls completely out of view while reading comments, the video moves into a compact 426×240 window in the bottom-right corner.
- Works in both default and theater modes; disabled in fullscreen.
- Hides the blurred "cinematics" background YouTube leaves behind the player.
- No flickering: the player's document position is remembered when entering float mode, and exit is based on scrolling back.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Vivaldi and other Chromium browsers; Violentmonkey/Greasemonkey work too).
2. Open the script link and confirm the installation:
   [youtube-ext.user.js](https://raw.githubusercontent.com/r35p3ct/Youtube-ext/main/youtube-ext.user.js)
3. Updates are delivered automatically — Tampermonkey checks the `@updateURL` metadata.

Alternatively, create a new script in Tampermonkey and paste the contents of `youtube-ext.user.js`.

## Settings

A gear button **to the left of YouTube's own gear** in the player control bar opens the settings popup:

| Group | Toggle | Effect |
|---|---|---|
| Playback | Play videos automatically | off — opened videos stay paused until you press Play |
| Player | Floating window on scroll | mini-player in the bottom-right corner while scrolling |
| Speed | Remember speed per channel | on — apply and remember speed for each channel |

Settings are stored via `GM_setValue`; saved channel speeds live in a separate key (compatible with the older "YouTube Channel Speed" script).

## Compatibility

- Desktop YouTube (`www.youtube.com`), Chromium-based browsers (Chrome, Edge, Vivaldi, Opera).
- Tested against the new 2025+ YouTube player UI (speed panel with presets and slider, Trusted Types CSP).

## Author

[Deito](https://github.com/r35p3ct)
