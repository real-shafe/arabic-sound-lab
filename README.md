# Arabic Sound Lab

Ear training for the sounds of Modern Standard Arabic that English doesn't have, built as a sibling of the [Arabic Keyboard Drill](https://arabic-keyboard-drill.shafe.dev). The mouth diagram is to this page what the keyboard is to that one. Three modes:

- **Ear quiz.** Hear one word of a pair (حَمَل ḥamal / عَمَل ʿamal) and pick which it was. The mouth under the question marks, as 1 and 2, where each word's contrasted sound is made; pairs that differ only in length show two timelines instead. After the answer the two words become replay buttons and one sentence says what tells them apart. Pick a set (throat and back of the mouth, plain vs emphatic, between the teeth, vowel length, doubling) or a single pair.
- **Mouth quiz.** See a letter, hear it in a word, and pick where in the mouth it is made, from eight numbered places.
- **All sounds.** The 28 consonants from the lips to the voice box and the 8 vowels. Tap one to hear it and see how it is made, its shapes, words with it at the start, middle and end, the pairs that train it, what happens to it after al-, and how cities say it. On phones the details open in a sheet over the list; "More about …" in either quiz opens the same sheet over the quiz.

Each quiz is exactly one screen (nothing to scroll to), nothing moves when an answer is shown, and Back steps back inside the site. Every word shows a two-word hint for its sound ("throaty h", "plain h") next to its Latin spelling. The notes (a key to the Latin letters, the marks, the regional table, sources, saving the audio for offline use) are at the bottom of All sounds. Misses are remembered in the browser and asked more often.

Live at **https://arabic-sound-lab.shafe.dev**

All audio is synthetic speech generated ahead of time with [ElevenLabs](https://elevenlabs.io), in two voices. The clips are served as plain files, so the page is fully static and no API key ever reaches the browser.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173  (PORT=8080 npm run dev for another port)
```

The clips and their manifest are committed (`public/clips/`, `public/audio.json`), so the page plays without an ElevenLabs key. The page is plain ES modules with no build step and no runtime dependencies; the scripts and tests need Node 20.12 or later.

## Tests

```bash
npm test
```

This runs Node's built-in test runner over `tests/`:

| File | What it checks |
|------|----------------|
| `tests/data.test.mjs` | `public/data.js`: every Arabic string is Unicode NFC; the 28 consonants (unique letters and slugs, hijāʾī order, places, manners, letter forms with tatweel); each example word really has its letter at the start, in the middle or at the end; the 14 sun and 14 moon letters; one transliteration system with no stray IPA; complete pairs, dialect rows and `COPY` |
| `tests/manifest.test.mjs` | `public/audio.json`: every playable string has a normal and a slow clip in both voices, every file exists and is named by the hash of its bytes, and no clip file is left over |
| `tests/sw.test.mjs` | The service worker's precache list against `public/`, its routing and clip saving (in a sandbox), the self-hosted fonts, `_headers` and the web app manifest |
| `tests/text.test.mjs` | The NFC lookup keys shared by the page, the generator and the tests |
| `tests/pipeline.test.mjs` | The audio pipeline: trimming, loudness, peak limiting, time-stretching, MP3 encoding, fingerprints and manifest helpers, on synthesized signals with no network |

| `tests/ui.test.mjs` | The UI contract, in a real headless Chrome at six screen sizes (360x640 to 1366x650): each quiz fits one screen; nothing a tap changes is off-screen; the page never scrolls by itself; no control moves or resizes when an answer is shown, on the next question, or for another sound; no dead, tiny, overlapping or cut-off controls and no clipped text; keyboard shortcuts; Back; deep links; the letter sheet. Skipped when `playwright-core` or Chrome is missing |

GitHub Actions runs the same tests on every push and pull request (`.github/workflows/test.yml`).

### Simulated users

`tests/ui/sim.mjs` drives one real Chrome page the way a visitor does (look at a screenshot of the screen, tap, scroll, press a key, nothing else) and, behind the user's back, measures every action and logs the moments a visitor would swear at: a tap that changes nothing on screen (`DEAD_TAP`) or only something off-screen (`OFFSCREEN_EFFECT`), the page scrolling by itself (`SCROLL_JUMP`), the tapped control moving away (`MOVED_UNDER_FINGER`), other controls moving (`LAYOUT_SHIFT`), small targets, overlaps, clipped or tiny text.

```bash
node tests/ui/sim.mjs help
node tests/ui/sim.mjs start --dir /tmp/s1 --url http://localhost:5173/ --viewport 390x664 --touch --flags
node tests/ui/sim.mjs tap --dir /tmp/s1 4 --flags      # control 4 of the list it printed
node tests/ui/sim.mjs stop --dir /tmp/s1
node tests/ui/sim.mjs report --out /tmp/report /tmp/s1
```

It is meant to be operated by an agent playing a persona (a first-timer on a phone, a keyboard-only user, someone who hits Back and reload), which records what it thinks with `note --wtf 0..3`. Without `--flags` the user never sees what the driver measured; `report` merges both into `report.md`. The measuring code (`tests/ui/measure.mjs`) is the same that `tests/ui.test.mjs` asserts on.

## Project structure

| Path | What it is |
|------|------------|
| `public/index.html` | The page: title, mode buttons, the quiz card and picture, the list of sounds, the letter sheet, the footer |
| `public/data.js` | Every letter, word, pair, note and line of prose the page teaches, in one place so it can be fact-checked; shared with the audio generator |
| `public/js/app.js` | The three modes (built once, updated in place), reserved heights, questions and scoring, remembered misses, options, keys, history (`#ear`, `#mouth`, `#sounds`, `#ayn`) |
| `public/js/sounds.js` | The page's view of `data.js`: the order and grouping of the sounds, the pair sets, and lookups from a sound to its pairs, regional forms and what happens after al- |
| `public/js/views.js` | HTML for the quiz frames, the list of sounds, a sound's details and the footer notes |
| `public/js/audio.js` | Audio engine: loads `audio.json`, decodes clips with the Web Audio API and plays sequences back to back |
| `public/js/mouth.js` | The side-view mouth diagram: one lit place with its name (`setPlace`), or numbered marks joined to their places (`setMarks`) |
| `public/js/text.js` | NFC lookup keys and diacritic stripping |
| `public/js/ui.js` | Shared helpers: HTML escaping, the screen-reader announcer, saved preferences |
| `public/js/offline.js` | Registers the service worker and the "Save audio for offline use" button |
| `public/css/` | `app.css` (layout and colors, matching the Keyboard Drill), `mouth.css`, `offline.css` and `fonts.css` |
| `public/fonts/` | Self-hosted fonts and their licenses (written by `npm run fonts`) |
| `public/audio.json` | The clip manifest: for each Arabic string, its normal and slow clip in each voice |
| `public/clips/<voice>/` | The MP3 clips, named by the hash of their bytes |
| `public/sw.js` | Service worker for offline use |
| `public/_headers` | Cache headers for Cloudflare |
| `public/favicon.svg`, `public/apple-touch-icon.png`, `public/og.png`, `public/site.webmanifest` | Icons, share image and web app manifest |
| `scripts/generate-audio.mjs` | Voices every playable string with ElevenLabs text-to-speech and writes the clips and `audio.json` |
| `scripts/check-audio.mjs` | Checks the clips: Scribe speech-to-text, loudness and durations |
| `scripts/lib/` | The audio pipeline shared by both scripts: voices and settings (`pipeline.mjs`), signal processing (`dsp.mjs`), MP3 encoding and parsing (`mp3.mjs`) |
| `scripts/copy-fonts.mjs` | Copies the fonts out of `node_modules/@fontsource` and writes `public/css/fonts.css` |
| `scripts/serve.mjs` | Dependency-free static server for local use |
| `tests/` | The tests above; `tests/ui/` holds the simulated-user driver, the shared measuring code and the Chrome launcher |
| `wrangler.jsonc` | Cloudflare Worker config: serves `public/` as static assets |

## How the audio is made

- **Two voices** from the ElevenLabs Voice Library, **Chaouki** (male, the default) and **Asmaa** (female), on the **`eleven_v4`** model with the language set to Arabic. Every playable string is voiced in both, and the page lets you switch.
- **Normalized.** Each string is requested once per voice as raw 24 kHz PCM and processed locally: silence is trimmed (40 ms lead-in, 100 ms tail, short fades), loudness is normalized to −18 LUFS (ITU-R BS.1770, K-weighted and gated) under a −1 dBFS peak ceiling, and the result is encoded as 64 kbps mono MP3, so the two words of a pair sound equally loud.
- **Pre-rendered slow clips.** The slow version is the same audio time-stretched to 0.75× speed with WSOLA, pitch unchanged, so both speeds say exactly the same thing and sound the same in every browser. The browser never stretches audio itself.
- **Content-addressed files.** Each clip is saved as `public/clips/<voice>/<first 12 hex of SHA-1 of the MP3>.mp3`, so a clip's URL changes whenever its sound does, and browsers may cache clips forever.
- **Manifest.** `public/audio.json` maps each string (Unicode NFC) to its clips, with a fingerprint of the settings that made it (voice, model, seed, processing) and its measured loudness. A changed fingerprint means the clip is out of date.
- **Checked with Scribe.** `npm run audio:check` transcribes the clips with ElevenLabs Scribe and flags any whose transcript doesn't match the Arabic, and reports loudness spread, pair differences and slow-to-normal durations. Scribe is noisy on single words: it may write the sound in English letters or pick a more common word, so listen before re-voicing. Isolated syllables such as بَا can only be checked by ear.
- **Seeds.** Requests use a fixed seed, so the same text and settings give the same clip. When a clip comes out wrong, give that string another seed in `SEEDS` in `scripts/lib/pipeline.mjs` and regenerate it.

None of the clips has been checked by a native speaker. Recordings of people, such as those on [Forvo](https://forvo.com/languages/ar/), remain the best reference.

## Regenerate the audio

You only need this after changing words in `public/data.js`, the voices or the processing.

```bash
npx -y @elevenlabs/cli@latest onboard init   # signs in and writes ELEVENLABS_API_KEY to .env.local (git-ignored)
npm run audio -- --dry-run                   # what would be voiced, and the character cost
npm run audio                                # voices anything new or out of date, in both voices
npm run audio:check                          # transcribes the clips with Scribe and reports loudness and durations
npm test                                     # the manifest test confirms every string has its clips
```

- `npm run audio -- --only قَلْب قَلَم` re-renders just those strings.
- `npm run audio -- --voice asmaa` limits a run to one voice.
- `npm run audio -- --force` calls the API again for everything in scope.
- `npm run audio:check -- --no-stt` reports loudness and durations without calling the API.
- The scripts read `ELEVENLABS_API_KEY` from `.env.local` when that file exists, or from the environment. `npm run audio -- --dry-run` and `npm run audio:check -- --no-stt` need no key at all.

Raw API responses are cached in `node_modules/.cache/arabic-sound-lab/tts`, so changing only the processing re-renders the clips without spending characters. Clip files that the manifest no longer uses are deleted. Voice Library voices need a paid ElevenLabs plan when used through the API.

## Deploy

```bash
npm run deploy     # runs the tests, then npx wrangler deploy
```

The site is a static-assets Cloudflare Worker (`wrangler.jsonc`) on the custom domain `arabic-sound-lab.shafe.dev`. Only `public/` is uploaded.

## Caching and offline use

- `public/_headers` lets browsers and Cloudflare cache `/clips/*` and `/fonts/*` for a year as immutable: clip names are hashes of the audio, and `npm run fonts` puts a hash of each font file in its name. `/sw.js` is always revalidated. Everything else (the page, scripts, styles, `audio.json`) uses Cloudflare's default of revalidating on every load, so a deploy shows up straight away.
- The service worker (`public/sw.js`) saves the page, scripts, styles, data, `audio.json` and fonts when it installs. It answers those network first and uses the saved copy only when the request fails (offline or a network error), however slow the network is, so one page load never mixes files from two deploys. It answers clips and fonts from the cache first. Its precache list is explicit; `tests/sw.test.mjs` fails if a script, stylesheet or font is missing from it, and `npm run fonts` rewrites the font entries.
- "Save audio for offline use" at the bottom of the page downloads every clip of the selected voice, both speeds, into the browser's cache. Clips you play are kept too.

## Fonts

Amiri (Arabic), IBM Plex Sans (interface text) and Noto Sans (IPA and transliteration) are self-hosted, and only the weights and character subsets the page uses are shipped. They are copied from the `@fontsource` packages:

```bash
npm run fonts
```

## License

- **Code:** MIT, see [`LICENSE`](LICENSE).
- **Fonts:** Amiri, IBM Plex Sans and Noto Sans are under the SIL Open Font License 1.1; the license files are in `public/fonts/`.
- **Audio:** the clips are synthetic speech generated with ElevenLabs text-to-speech using the Chaouki and Asmaa voices from the ElevenLabs Voice Library. They are not recordings of people.
