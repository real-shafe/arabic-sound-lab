# Arabic Sound Lab

An interactive guide to the sounds of Modern Standard Arabic: consonants laid out from the lips to the throat, minimal pairs, vowel length, sun and moon letters, and how the dialects shift them. Tap any letter or word to hear it.

All speech is generated with [ElevenLabs](https://elevenlabs.io). The clips are made ahead of time and served as plain files, so the page is fully static and the API key never reaches the browser.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

The clips are committed under `public/audio/`, so the page plays without an ElevenLabs key.

## Regenerate the audio

You only need this after changing the words or the voice.

```bash
npx -y @elevenlabs/cli@latest onboard init   # signs in and writes ELEVENLABS_API_KEY to .env.local (git-ignored)
npm run audio                                # voices anything new or changed
npm run audio:check                          # optional: transcribes every clip with Scribe and flags mismatches
```

- `npm run audio -- --force` re-voices everything.
- `npm run audio -- --only قَلْب قَلَم` re-voices just those strings.

## How it fits together

| Path | What it is |
|------|------------|
| `public/index.html` | The page |
| `public/data.js` | Every letter, word and pair the page teaches, shared with the generator |
| `public/audio/manifest.json` | Maps each Arabic string to its clips at normal and slow speed |
| `public/audio/normal/`, `public/audio/slow/` | The MP3 clips |
| `scripts/generate-audio.mjs` | Calls ElevenLabs text-to-speech for each string in `data.js` |
| `scripts/check-audio.mjs` | Calls ElevenLabs speech-to-text to check each clip says what it should |
| `scripts/serve.mjs` | Dependency-free static server for local use |

The voice is **Chaouki**, a native Modern Standard Arabic speaker from the ElevenLabs Voice Library, on the `eleven_v4` model. The page's Slow button plays the same clip at 75% speed with the pitch kept, so both speeds say exactly the same thing. (Slow clips voiced separately by `eleven_multilingual_v2`, which has a speed setting, swapped consonants in contrast pairs, so they were dropped.) To change the voice or model, edit `VOICE` or `MODEL` at the top of `scripts/generate-audio.mjs` and run `npm run audio`: any clip whose settings changed is voiced again.

If `npm run audio:check` flags a clip, try another seed for it in `SEEDS` in the same file. Scribe is noisy on single words: it often writes the right sound in English ("feel" for فِيل) or picks a more common word, so listen before re-voicing. Isolated syllables such as بَا can only be checked by ear.

Voice Library voices need a paid ElevenLabs plan when used through the API.
