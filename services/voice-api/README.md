# Voice API — English in four accents

    POST http://100.90.163.26:3000/api/tts

```bash
curl -X POST http://100.90.163.26:3000/api/tts \
  -H "Content-Type: application/json" \
  -d '{"voice":"middle_eastern","text":"Hello, this is a test."}' \
  --output hello.wav
```

That returns a 24 kHz mono WAV. `GET http://100.90.163.26:3000/api/tts` lists the voices and
repeats this usage, so the endpoint documents itself.

## The four voices

| `voice` | sounds like | engine | how the accent is produced |
|---|---|---|---|
| `indian` | Indian immigrant speaking English | Maya1 | described in words, no reference audio |
| `american` | General American | Maya1 | described in words, no reference audio |
| `african` | Kenyan, Kiswahili-speaking | Afro-TTS | clones a real Kenyan speaker |
| `middle_eastern` | Levantine Arabic, Lebanese | Chatterbox | clones a real Lebanese speaker |

Chosen by ear from the full comparison in `H:/H3RemoteStudio/AccentTest/LISTEN` and `FINAL`.

## Options

```jsonc
{
  "voice": "african",     // required
  "text": "...",          // required, up to 5000 characters
  "seed": 1234,           // optional; same seed + same text = same audio
  "keep": false           // optional; true returns JSON with a path on disk instead of audio
}
```

Response headers carry `X-Voice`, `X-Engine`, `X-Audio-Seconds`, `X-Generation-Seconds`.

## Speed, and why it varies

Only one engine is held in memory at a time, so the first call to a voice pays a model load:

| | typical |
|---|---|
| same voice again, or another voice on the same engine | **8–14 s** |
| a voice on a different engine (model swap) | **25–35 s** |

`indian` and `american` share an engine, so alternating those two is fast. Alternating
`african` and `middle_eastern` reloads a model every time. **If you are generating a batch,
group your calls by voice** — it is several times faster.

## Sharing the graphics card

This machine has one 4090, and an H3 film render stages about 20 GB of it. A voice model on top
of that is an out-of-memory crash, not a slowdown. So the voice service takes the same machine-wide
lock (`H:/KathaluStudio/gpu.lock`) that Kathalu's renders use, and holds it while a model is warm.

- If a film is rendering, a voice request **waits** (up to 10 minutes) and then returns
  **503** naming what is holding the card. Retry after the render.
- A warm voice model lets go of the card after **180 seconds** idle, so a film queued behind
  the voice waits at most that long.

Tune with `VOICEAPI_IDLE_UNLOAD_S` and `VOICEAPI_GPU_WAIT_S`.

## How it is wired

```
your script  ->  :3000 /api/tts        (Kathalu app, on Tailscale)
                      |  proxies to
                 :8200 /tts            (this service, localhost only)
                      |  one warm child process at a time
                 Maya1 | Chatterbox | Afro-TTS     (three separate venvs)
```

The three engines need mutually incompatible versions of `transformers`, so they cannot share a
Python process. Each runs in its own venv as a child process taking one JSON job per stdin line —
the same shape `_speak_indicspeak.py` already uses in Kathalu.

**Each worker gets its HF cache and TEMP set explicitly.** `start-h3-studio.ps1` points `HF_HOME`
and `TEMP` at IndicF5's directories for the narration service and never resets them, so a worker
that inherited the environment picked up the wrong cache and hung on load. Do not remove those
explicit values from `ENGINES` in `server.py`.

## Running it

Started by `H:\KathaluStudio\app\scripts\start-h3-studio.ps1` alongside ComfyUI, IndicF5 and the
website, and watched by `watch-h3-studio.ps1`, which restarts it within a minute if port 8200 goes
quiet. Logs: `H:\KathaluStudio\app\work\voice-api.{stdout,stderr}.log`.

To restart by hand: `schtasks /Run /TN "KathaluStudioStart"`.

## Licensing, worth knowing before publishing

The two cloned voices come from research corpora with non-commercial terms: the Kenyan speaker
from **AfriSpeech-200** (CC BY-NC-SA 4.0, card says research purposes only) and the Lebanese
speaker from the **Speech Accent Archive** (CC BY-NC-SA 2.0). Fine for testing and personal work.
Check them before putting these two voices in anything published or monetised. `indian` and
`american` have no such constraint — Maya1 is Apache 2.0 and invents those voices outright.
