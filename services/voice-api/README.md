# Voice API — English in four accents, male or female

    POST http://100.90.163.26:3000/api/tts

```bash
curl -X POST http://100.90.163.26:3000/api/tts \
  -H "Content-Type: application/json" \
  -d '{"voice":"middle_eastern","gender":"female","text":"Hello, this is a test."}' \
  --output hello.wav
```

That returns a 24 kHz mono WAV. `GET http://100.90.163.26:3000/api/tts` lists the voices and
repeats this usage, so the endpoint documents itself.

## The eight voices

| accent | gender | sounds like | engine | how it is produced |
|---|---|---|---|---|
| `indian` | male | Indian man | Maya1 | described in words |
| `indian` | female | Indian woman | Maya1 | described in words |
| `american` | male | American man | Maya1 | described in words |
| `american` | female | American woman | Maya1 | described in words |
| `african` | male | Kenyan man, Kiswahili-speaking | Afro-TTS | clones a real speaker |
| `african` | female | Kenyan woman, Kikuyu-speaking | Afro-TTS | clones a real speaker |
| `middle_eastern` | male | Gulf Arabic, Saudi man | Chatterbox | clones a real speaker |
| `middle_eastern` | female | Levantine Arabic, Lebanese woman | Chatterbox | clones a real speaker |

Accents chosen by ear from the comparison in `H:/H3RemoteStudio/AccentTest/LISTEN` and `FINAL`.
**Gender is a different speaker, not a pitch setting** — for the cloned accents it is a different
reference recording, and for the Maya1 ones a different description. Measured median pitch runs
99-115 Hz for the male voices and 163-224 Hz for the female ones.

## Options

```jsonc
{
  "voice": "african",     // required: an accent, or a full name like "african_female"
  "text": "...",          // required, up to 5000 characters
  "gender": "female",     // optional: male | female
  "seed": 1234,           // optional; same seed + same text = same audio
  "keep": false           // optional; true returns JSON with a path on disk instead of audio
}
```

Two equivalent ways to ask: `voice: "african", gender: "female"`, or `voice: "african_female"`.
Asking for both in a contradictory way (`voice: "indian_male", gender: "female"`) is a 400 rather
than a silent choice.

**Omitting `gender` keeps whatever that accent returned before gender existed** — male for
`indian`, `american` and `african`, female for `middle_eastern` — so calls written earlier still
produce the same voice. New code should pass `gender` explicitly rather than rely on that.

Response headers carry `X-Voice`, `X-Accent`, `X-Gender`, `X-Engine`, `X-Audio-Seconds`,
`X-Generation-Seconds`.

## Speed, and why it varies

Only one engine is held in memory at a time, so the first call to a voice pays a model load:

| | typical |
|---|---|
| same voice again, or another voice on the same engine | **8–14 s** |
| a voice on a different engine (model swap) | **25–35 s** |

**Gender is free — it never swaps the engine.** `indian` and `american` in either gender all run
on Maya1, so any mix of those four is fast. `african` male and female both run on Afro-TTS, and
both `middle_eastern` voices on Chatterbox. What costs a reload is moving between those three
groups. **If you are generating a batch, group your calls by accent** — genders can be
interleaved freely within a group.

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
