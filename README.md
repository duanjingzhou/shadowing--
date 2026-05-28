# Shadowing Studio

A local-first web app for English shadowing practice.

## What it does

- Loads a YouTube video from a URL or video ID.
- Loads YouTube captions through the local app server when captions are available.
- Lets you set an A-B repeat segment.
- Records your shadowing take with the browser microphone.
- Replays the latest recording.
- Saves each recording as a downloadable `.webm` file.
- Tracks segment duration, take duration, and timing difference.
- Saves practice segments and notes in local storage.
- Keeps recording metadata and audio blobs in browser storage.

## Run it

### Easiest local use

Double-click `index.html`.

This mode supports YouTube playback, recording, replay, and downloading takes.
The separate subtitle text list needs the local server mode below, but YouTube's
built-in CC subtitles can still be used inside the player.

### Full local mode

From this folder:

```sh
python3 server.py 5173
```

Then open:

```txt
http://localhost:5173
```

Microphone recording needs `localhost` or another secure browser context. If the in-app
browser blocks microphone permissions, open the same URL in Chrome or Safari.
