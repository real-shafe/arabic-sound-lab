// Copies the self-hosted web fonts out of node_modules/@fontsource into
// public/fonts/ and writes public/css/fonts.css (F36). Only the faces the page
// uses are copied:
//
//   Amiri           400          arabic                    Arabic text
//   IBM Plex Sans   400, 600     latin, latin-ext          interface text
//   Noto Sans       400, 600     latin, latin-ext, greek   IPA and transliteration (θ is in greek)
//
// IBM Plex Sans has no ḥ ṭ ṣ ḍ ẓ ḫ ṯ ḏ ʾ ʿ or IPA letters, which is why
// app.css sets .tr in Noto Sans and lists Noto Sans as the fallback
// of --font-ui.
//
// Each package's LICENSE (SIL Open Font License 1.1) is copied next to the
// fonts as public/fonts/LICENSE-<package>.txt. The unicode-range of every face
// is read from the package's own CSS, so the browser only downloads a file
// when the page uses a character from it.
//
// Font files get a hash of their bytes in the name
// (amiri-arabic-400-normal.<8 hex>.woff2), so public/_headers can let browsers
// cache /fonts/* for a year: an updated font is a new URL. The script also
// rewrites the fonts block of the precache list in public/sw.js to match.
//
//   npm run fonts      (after npm install, or after updating an @fontsource package)

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FONTSOURCE = join(ROOT, "node_modules", "@fontsource");
const FONTS_DIR = join(ROOT, "public", "fonts");
const CSS_FILE = join(ROOT, "public", "css", "fonts.css");
const SW_FILE = join(ROOT, "public", "sw.js");

// Subsets are listed in the order fontsource declares them (most specific
// first, latin last), which keeps its overlapping ranges behaving the same.
const FACES = [
  { pkg: "amiri", family: "Amiri", weights: [400], subsets: ["arabic"] },
  { pkg: "ibm-plex-sans", family: "IBM Plex Sans", weights: [400, 600], subsets: ["latin-ext", "latin"] },
  { pkg: "noto-sans", family: "Noto Sans", weights: [400, 600], subsets: ["greek", "latin-ext", "latin"] },
];

const fileName = (pkg, subset, weight) => `${pkg}-${subset}-${weight}-normal.woff2`;
const hashedName = (name, bytes) =>
  name.replace(/\.woff2$/, `.${createHash("sha1").update(bytes).digest("hex").slice(0, 8)}.woff2`);

/** unicode-range of one face, read from the package's <weight>.css. */
function unicodeRange(css, pkg, subset, weight) {
  const want = fileName(pkg, subset, weight);
  for (const block of css.split("@font-face").slice(1)) {
    const src = /src:\s*url\(\.\/files\/([^)]+)\)/.exec(block);
    if (!src || src[1] !== want) continue;
    if (!/font-style:\s*normal/.test(block)) continue;
    const range = /unicode-range:\s*([^;]+);/.exec(block);
    if (!range) throw new Error(`${pkg}/${weight}.css has no unicode-range for ${want}`);
    return range[1].trim();
  }
  throw new Error(`${pkg}/${weight}.css has no @font-face for ${want}`);
}

function fontFace({ comment, family, weight, file, range }) {
  return (
    `/* ${comment} */\n` +
    `@font-face {\n` +
    `  font-family: "${family}";\n` +
    `  font-style: normal;\n` +
    `  font-weight: ${weight};\n` +
    `  font-display: swap;\n` +
    `  src: url("../fonts/${file}") format("woff2");\n` +
    `  unicode-range: ${range};\n` +
    `}`
  );
}

async function main() {
  if (!existsSync(FONTSOURCE)) {
    throw new Error("node_modules/@fontsource is missing. Run npm install first.");
  }
  await mkdir(FONTS_DIR, { recursive: true });
  await mkdir(dirname(CSS_FILE), { recursive: true });

  const wanted = new Set();
  const rules = [];
  let bytes = 0;

  for (const face of FACES) {
    const pkgDir = join(FONTSOURCE, face.pkg);
    if (!existsSync(pkgDir)) throw new Error(`@fontsource/${face.pkg} is not installed. Run npm install.`);
    const version = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")).version;

    for (const weight of face.weights) {
      const css = await readFile(join(pkgDir, `${weight}.css`), "utf8");
      for (const subset of face.subsets) {
        const from = join(pkgDir, "files", fileName(face.pkg, subset, weight));
        if (!existsSync(from)) throw new Error(`missing ${relative(ROOT, from)}`);
        const buf = await readFile(from);
        const file = hashedName(fileName(face.pkg, subset, weight), buf);
        await writeFile(join(FONTS_DIR, file), buf);
        bytes += buf.length;
        wanted.add(file);
        rules.push(fontFace({
          comment: `${face.family} ${weight}, ${subset} (@fontsource/${face.pkg} ${version})`,
          family: face.family,
          weight,
          file,
          range: unicodeRange(css, face.pkg, subset, weight),
        }));
      }
    }

    const license = `LICENSE-${face.pkg}.txt`;
    await copyFile(join(pkgDir, "LICENSE"), join(FONTS_DIR, license));
    wanted.add(license);
  }

  // Remove font files left over from an earlier build (only files this
  // script writes: .woff2 and LICENSE-*.txt).
  for (const name of await readdir(FONTS_DIR)) {
    if (wanted.has(name)) continue;
    if (name.endsWith(".woff2") || /^LICENSE-.+\.txt$/.test(name)) {
      await rm(join(FONTS_DIR, name));
      console.log(`  removed stale public/fonts/${name}`);
    }
  }

  const header =
    "/* Self-hosted fonts (SIL Open Font License 1.1; see public/fonts/LICENSE-*.txt).\n" +
    "   Generated by scripts/copy-fonts.mjs from node_modules/@fontsource. Do not edit by hand. */\n";
  await writeFile(CSS_FILE, header + "\n" + rules.join("\n\n") + "\n");

  const fonts = [...wanted].filter(n => n.endsWith(".woff2")).sort();
  console.log(`Copied ${fonts.length} font files (${(bytes / 1024).toFixed(0)} KB) to public/fonts/ and wrote public/css/fonts.css`);
  await updateServiceWorker(fonts);
}

/** Rewrites the lines between "// fonts:start" and "// fonts:end" in the PRECACHE list of public/sw.js. */
async function updateServiceWorker(fonts) {
  if (!existsSync(SW_FILE)) {
    console.warn("  public/sw.js not found; add the font files to its PRECACHE list by hand");
    return;
  }
  const sw = await readFile(SW_FILE, "utf8");
  const block = /^([ \t]*)\/\/ fonts:start[^\n]*\n[\s\S]*?^[ \t]*\/\/ fonts:end[^\n]*$/m;
  const match = block.exec(sw);
  if (!match) throw new Error("public/sw.js has no // fonts:start … // fonts:end block in PRECACHE");
  const indent = match[1];
  const startLine = match[0].slice(0, match[0].indexOf("\n"));
  const endLine = match[0].slice(match[0].lastIndexOf("\n") + 1);
  const lines = [startLine, ...fonts.map(f => `${indent}"fonts/${f}",`), endLine];
  const next = sw.slice(0, match.index) + lines.join("\n") + sw.slice(match.index + match[0].length);
  if (next !== sw) {
    await writeFile(SW_FILE, next);
    console.log("  updated the font files in the PRECACHE list of public/sw.js");
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exitCode = 1;
});
