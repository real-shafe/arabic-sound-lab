// Mouth diagram (mo-): a schematic side view (sagittal section) of the vocal tract.
// The head faces LEFT, so the lips are on the left and the throat on the right,
// matching the front-to-back order of PLACES used everywhere else on the page (F5, F29).
//
//   const mouth = createMouth({ places: PLACES });
//   panel.append(mouth.el);
//   mouth.setPlace("pha");   // lights the pharynx; setPlace(null) clears it
//   mouth.setMarks([{ place: "vel", label: "1" }, { place: "uvu", label: "2", state: "right" }]);
//                            // numbered badges joined to their places; setMarks([]) clears them
//
// Everything is drawn with cubic Bézier paths in a 300 × 304 viewBox: the head is a faint tissue
// tint, the airway (nose, mouth, pharynx, larynx, windpipe, food pipe) is cut out of it, and the
// articulators sit on top. Colors come only from CSS variables (css/mouth.css), so the drawing
// follows the light and dark themes. Nothing touches the DOM until createMouth() is called.

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW_W = 300;
const VIEW_H = 304;

/** Place ids in front-to-back order (lips → glottis). */
const ORDER = ["lab", "int", "alv", "pal", "vel", "uvu", "pha", "glo"];

/** Used when `places` is missing an entry, so the diagram never renders blank names. */
const FALLBACK = {
  lab: { short: "Lips", name: "Lips" },
  int: { short: "Teeth", name: "Between the teeth" },
  alv: { short: "Ridge", name: "Teeth and gum ridge" },
  pal: { short: "Palate", name: "Hard palate" },
  vel: { short: "Velum", name: "Soft palate" },
  uvu: { short: "Uvula", name: "Uvula" },
  pha: { short: "Pharynx", name: "Pharynx" },
  glo: { short: "Glottis", name: "Glottis" },
};

/** Accessible title of the drawing for each lit place. */
const MADE_AT = {
  lab: "Made at the lips",
  int: "Made between the teeth",
  alv: "Made at the teeth and gum ridge",
  pal: "Made at the hard palate",
  vel: "Made at the soft palate",
  uvu: "Made at the uvula",
  pha: "Made at the pharynx",
  glo: "Made at the glottis",
};

const TITLE_NONE = "Side view of the mouth and throat";
const DESC =
  "Schematic cross-section of the head seen from the side, facing left. The lips and front teeth are on the left; " +
  "the gum ridge, hard palate, soft palate and uvula run along the roof of the mouth above the tongue; " +
  "the pharynx, epiglottis and glottis are in the throat on the right, above the split into windpipe and food pipe.";

/** Rough advance width of one label character (15.5-unit semibold UI font), used to check that a label fits. */
const LABEL_CHAR_W = 8.8;

// ---------------------------------------------------------------------------------------------
// Path helpers (pure string work, safe at import time). Paths are absolute M/C/L only.
// ---------------------------------------------------------------------------------------------

/** Drops the leading moveto so path pieces can be chained into one outline. */
const tail = (d) => d.replace(/^M[^CL]*/, "");

/** Reverses an absolute path made of one M followed by C and L commands. */
function reversePath(d) {
  const segs = [];
  let cur = null;
  for (const [, cmd, args] of d.matchAll(/([MCL])([^MCLZ]*)/g)) {
    const nums = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === "M") {
      cur = [nums[0], nums[1]];
      continue;
    }
    const step = cmd === "C" ? 6 : 2;
    for (let i = 0; i + step <= nums.length; i += step) {
      const p = nums.slice(i, i + step);
      const to = [p[step - 2], p[step - 1]];
      segs.push({ cmd, from: cur, c1: [p[0], p[1]], c2: [p[2], p[3]], to });
      cur = to;
    }
  }
  let out = `M${cur[0]} ${cur[1]}`;
  for (const s of segs.reverse()) {
    out += s.cmd === "C" ? `C${s.c2.join(" ")} ${s.c1.join(" ")} ${s.from.join(" ")}` : `L${s.from.join(" ")}`;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Geometry (viewBox units). Head facing left: x grows toward the back of the head, y downward.
// ---------------------------------------------------------------------------------------------

/** Roof of the mouth, oral surface, front to back. Each piece starts where the previous one ends. */
const ROOF = {
  alv: "M62.5 124.5C64.5 124.2 66.6 122.6 67.9 120.3C69.5 117.4 72.5 113.6 76.6 110.9C78.2 109.8 79.6 108.6 81 107",
  pal: "M81 107C88 99.4 100 96.5 114 96.5C126 96.5 137 99 147 103.5",
  vel: "M147 103.5C155 107 162 113 167 120.5",
  uvu: "M167 120.5C170 126 171 134 172.5 140C173.5 144.5 178 145.5 180 141.5C181.5 137 181 128 179 120",
};
const ROOF_ORAL = ROOF.alv + tail(ROOF.pal) + tail(ROOF.vel) + tail(ROOF.uvu);

/** From the back of the uvula along the nasal surface of the soft and hard palate to the front of the upper jaw. */
const NASAL_FLOOR = "C176 111 166 102 149 95.5C130 90 105 89 88 92C72 95 58 99 50 102";
const PALATE = `${ROOF_ORAL}${NASAL_FLOOR}C50.5 108 51.5 115 52.5 122.5Z`;

/** Nasal roof sweeping back into the back wall of the pharynx, split so the pharynx piece can light up. */
const BACK_WALL = {
  top: "M55.4 68C80 54 130 50 168 58C192 64 205 78 208.5 98C211 116 210.5 128 210 140",
  pha: "M210 140C209.4 160 207.6 185 205.5 210",
  low: "M205.5 210C204.5 225 203.6 240 203 255C202 275 201.5 290 201 304",
};

const FACE_UPPER =
  "M75.4 0C68.5 18 64 34 63 46C62.5 53 61 58 58.5 62C52 74 40 88 27 99C21 104 21.5 112 28.5 114C34 115.5 41 116 46 118";
const NOSE_WING = "M29.5 108C32 102.5 40 101 44 107.5";
const FACE_LOWER =
  "M44 170C40 176 36 186 38 196C40 206 50 213 64 214C92 214 120 216 138 222C146 226 147 236 146 246C145 262 147 284 148 304";
/** Back of the head and neck, drawn softly so the whole reads as a head facing left. */
const HEAD_BACK = "M250 0C278 30 296 84 296 132C296 170 288 196 288 228C288 258 292 284 294 304";

const UPPER_LIP_OUTER = "M46 118C41 124 35 131 32.5 138C31.5 142 33.5 146.5 39 147.5";
const LOWER_LIP_OUTER = "M39 147.5C33 148.5 30.5 153 31.5 159C32.5 165 38 168.5 44 170";
const UPPER_LIP = `${UPPER_LIP_OUTER}C43 147.5 46 147 47.5 145.5C49 138 51 130 52.5 122.5C50.5 120.5 48 119 46 118Z`;
const LOWER_LIP = `${LOWER_LIP_OUTER}C48 171.5 51 172 54.5 171.5C53.5 164 52.5 157 52 152C48 149.5 43 148 39 147.5Z`;

/** Head silhouette: face profile, bottom edge, back of the head, top edge. */
const HEAD =
  FACE_UPPER + tail(UPPER_LIP_OUTER) + tail(LOWER_LIP_OUTER) + tail(FACE_LOWER) + "L294 304" +
  tail(reversePath(HEAD_BACK)) + "Z";

const UPPER_TOOTH =
  "M52.5 122.5C51 130 49 138 47.5 145C47.3 146.6 49.5 147.4 51.5 146.8C54 141 57 135 59.5 130C61 127.5 62 126 62.5 124.5Z";
const LOWER_TOOTH =
  "M52 151.5C53 150 55.5 149.5 56.5 151C59 156 61 162 62.5 169C60 170.5 57 171 54.5 171C53.5 164 52.5 157 52 151.5Z";
/** Tongue at rest: tip behind the lower teeth, blade, body under the palate, root down to the epiglottis.
 *  The upper surface is drawn firmly; the underside (floor of the mouth) only softly. */
const TONGUE_TOP =
  "M60 156.5C64 151 69 147 75 143C83 137.5 88 128 97 122C105 116.5 113 112 124 111C136 110 147 112 155 117.5" +
  "C163 123 168.5 134.5 170.5 148C172 160 172 175 170 188C169 195 167.5 200.5 166 205";
const TONGUE_UNDER =
  "M166 205C150 212 122 212 100 207C88 204 80 200 76.5 194C73.5 187 70.5 178 67.5 168C66 163 63.5 159.5 60 156.5";
/** Only the free underside of the tip gets a line; the rest of the tongue fades into the floor of the mouth. */
const TONGUE_TIP_UNDER = "M67.5 168C66 163 63.5 159.5 60 156.5";
const TONGUE = TONGUE_TOP + tail(TONGUE_UNDER) + "Z";

const CONCHAE = [
  "M84 66C102 59 126 58 144 63C128 68 104 69.5 84 66Z",
  "M72 80C92 72 122 71 142 77C126 83 98 85 72 80Z",
];

const EPIGLOTTIS =
  "M166.5 207C171 200 176 191 181 184C183 181 186 179 188 180.5C189 183 186 189 182.5 196C179 203 176 211 173.5 219Z";
const ARYEPIGLOTTIC = "M188 180.5C192 192 193.5 208 191 222";
const LARYNX_FRONT = "M173.5 219C170 228 167.5 236 166.5 244C165.8 252 165.5 262 165.5 272L165.5 304";
/** Back wall of the larynx, continuing down as the wall between the windpipe (front) and the food pipe (back). */
const LARYNX_BACK =
  "M191 222C188.5 230 187 238 187 246C187 255 187 262 187 268C185.6 272 185 276 185 282L185 304L190.5 304" +
  "L190.8 283C191 277 192 272 193.5 266C194.5 255 194.5 240 193.5 228C193 225 192.2 223 191 222Z";
const THYROID = "M168.5 224C164.5 233 161.5 244 161.5 258L165.6 258C165.6 247 167.6 236 171.2 226.5Z";
const RINGS = [262, 273, 284, 295];
const FOLDS = [
  "M166.6 242C169.6 243.4 172.6 244.9 174.6 246C172.6 247.1 169.6 248.6 166.4 250Z",
  "M187 242C184.4 243.4 181.4 244.9 179 246C181.4 247.1 184.4 248.6 187 250Z",
];

/** The airway, cut out of the head tint (even-odd fill) so it shows whatever is behind the diagram:
 *  nose, nasal cavity, pharynx, food pipe, windpipe, larynx and mouth. Where it runs under a filled
 *  structure (teeth, epiglottis, tongue, palate) the edge is hidden by that structure. */
const AIRWAY =
  BACK_WALL.top + tail(BACK_WALL.pha) + tail(BACK_WALL.low) + "L165.5 304" + tail(reversePath(LARYNX_FRONT)) +
  "L166 205" + tail(reversePath(TONGUE_TOP)) + "L56 150L54 140L62.5 124.5" + tail(ROOF_ORAL) + NASAL_FLOOR +
  "C45 104 40 108 37.5 112C34 109 33.5 104 36 99C42 89 50 78 55.4 68Z";

/** Marker centers: where each place's articulation happens. */
const MARKERS = {
  lab: [35, 147.5], // where the lips meet
  int: [52.5, 148.6], // between the upper and lower incisor edges
  alv: [69, 118.4], // crest of the gum ridge behind the upper teeth
  pal: [114, 96.5], // top of the hard palate vault
  vel: [158, 110.5], // middle of the soft palate
  uvu: [176, 143], // tip of the uvula
  pha: [190, 165], // middle of the pharynx, between tongue root and back wall
  glo: [176.8, 246], // the gap between the vocal folds
};

/** Interactive hit circles: radius, plus small offsets from the marker so neighbors (lips and teeth,
 *  uvula and pharynx) do not overlap. Each target is at least 24 CSS px wide from a 260 px rendering up. */
const HIT_R = 14;
const HIT_OFFSET = { lab: [-8, 0], int: [3.5, 1.4], uvu: [-2, -2], pha: [2, 3] };

/** Leader line points (from the marker outward), label anchor, the width available for the label (`room`),
 *  and whether the label sits on the head tint (`inside`) or on the open background. */
const CALLOUTS = {
  lab: { pts: [[35, 147.5], [14, 147.5], [14, 229]], x: 8, y: 245, anchor: "start", room: 128, inside: false },
  int: { pts: [[52.5, 148.6], [22, 204], [22, 229]], x: 8, y: 245, anchor: "start", room: 128, inside: false },
  alv: { pts: [[69, 118.4], [84, 34]], x: 76, y: 26, anchor: "start", room: 200, inside: true },
  pal: { pts: [[114, 96.5], [114, 34]], x: 114, y: 26, anchor: "middle", room: 84, inside: true },
  vel: { pts: [[158, 110.5], [166, 34]], x: 166, y: 26, anchor: "middle", room: 180, inside: true },
  uvu: { pts: [[176, 143], [214, 143]], x: 219, y: 148.5, anchor: "start", room: 78, inside: true },
  pha: { pts: [[190, 165], [214, 165]], x: 219, y: 170.5, anchor: "start", room: 78, inside: true },
  glo: { pts: [[176.8, 246], [214, 214]], x: 219, y: 219.5, anchor: "start", room: 80, inside: true },
};

let uid = 0;

const escText = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const sentence = (s) => {
  const t = String(s || "").trim();
  return !t ? "" : /[.?!]$/.test(t) ? t : `${t}.`;
};

function normalizePlaces(places) {
  const given = new Map();
  if (Array.isArray(places)) for (const p of places) if (p && FALLBACK[p.id]) given.set(p.id, p);
  return ORDER.map((id) => {
    const p = given.get(id) || {};
    const fb = FALLBACK[id];
    const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : fb.name;
    const rawShort = typeof p.short === "string" ? p.short.trim() : "";
    // Prefer the data's short name; fall back to the built-in one when it would not fit beside the drawing.
    const short = rawShort && rawShort.length * LABEL_CHAR_W <= CALLOUTS[id].room ? rawShort : fb.short;
    const desc = typeof p.desc === "string" ? p.desc.trim() : "";
    return { id, name, short, desc };
  });
}

function anatomyMarkup(gradId) {
  const path = (cls, d) => `<path class="${cls}" d="${d}"/>`;
  const rings = RINGS.map((y) => `<rect class="mo-cart" x="161.2" y="${y}" width="4.6" height="6.4" rx="2.3"/>`).join("");
  return `
  <defs>
    <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" class="mo-stop-flesh"/>
      <stop offset="0.55" class="mo-stop-flesh"/>
      <stop offset="1" class="mo-stop-fade"/>
    </linearGradient>
  </defs>
  <g class="mo-anatomy" aria-hidden="true">
    <path class="mo-head" d="${HEAD}${AIRWAY}" fill-rule="evenodd"/>
    ${path("mo-head-line", HEAD_BACK)}
    ${CONCHAE.map((d) => path("mo-concha", d)).join("")}
    ${path("mo-palate", PALATE)}
    ${path("mo-wall", BACK_WALL.top)}${path("mo-wall", BACK_WALL.pha)}${path("mo-wall", BACK_WALL.low)}
    <path class="mo-tongue" d="${TONGUE}" fill="url(#${gradId})"/>
    ${path("mo-fine", TONGUE_TIP_UNDER)}
    ${path("mo-tongue-top", TONGUE_TOP)}
    <ellipse class="mo-cart" cx="154" cy="216.5" rx="6.6" ry="3.2" transform="rotate(-14 154 216.5)"/>
    ${path("mo-cart", THYROID)}
    ${rings}
    ${path("mo-wall", LARYNX_FRONT)}
    ${path("mo-larynx-back", LARYNX_BACK)}
    ${path("mo-fine", ARYEPIGLOTTIC)}
    ${path("mo-epiglottis", EPIGLOTTIS)}
    ${FOLDS.map((d) => path("mo-fold", d)).join("")}
    ${path("mo-tooth", UPPER_TOOTH)}${path("mo-tooth", LOWER_TOOTH)}
    ${path("mo-lip", UPPER_LIP)}${path("mo-lip", LOWER_LIP)}
    ${path("mo-face", FACE_UPPER)}${path("mo-fine", NOSE_WING)}${path("mo-face", FACE_LOWER)}
  </g>`;
}

function highlightMarkup() {
  const hl = (kind, id, d) => `<path class="mo-hl mo-hl-${kind}" data-hl="${id}" d="${d}"/>`;
  return `
  <g class="mo-highlights" aria-hidden="true">
    ${hl("shape", "lab", UPPER_LIP)}${hl("shape", "lab", LOWER_LIP)}
    ${hl("shape", "int", UPPER_TOOTH)}${hl("shape", "int", LOWER_TOOTH)}
    ${hl("line", "alv", ROOF.alv)}
    ${hl("line", "pal", ROOF.pal)}
    ${hl("line", "vel", ROOF.vel)}
    ${hl("line", "uvu", ROOF.uvu)}
    ${hl("line", "pha", BACK_WALL.pha)}
    ${hl("solid", "glo", FOLDS[0])}${hl("solid", "glo", FOLDS[1])}
  </g>`;
}

function markerMarkup(place, interactive) {
  const [x, y] = MARKERS[place.id];
  const [hx, hy] = HIT_OFFSET[place.id] || [0, 0];
  const a11y = interactive
    ? ` tabindex="0" role="button" aria-label="${escText(place.name)}" aria-pressed="false"`
    : ` aria-hidden="true"`;
  return `
    <g class="mo-mk" data-place="${place.id}" transform="translate(${x} ${y})"${a11y}>
      ${interactive ? `<title>${escText(place.short || place.name)}</title><circle class="mo-mk-hit" cx="${hx}" cy="${hy}" r="${HIT_R}"/>` : ""}
      <circle class="mo-mk-halo" r="12.5"/>
      <circle class="mo-mk-dot" r="6"/>
      ${interactive ? `<circle class="mo-mk-focus" r="10.5"/>` : ""}
    </g>`;
}

const leaderPath = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("");

/** Numbered badges (setMarks): where each place's badge sits, the bend of its leader line, and the axis
 *  along which two badges for the same place sit side by side. All eight fit at once without touching. */
const BADGE_R = 14.5;
const BADGES = {
  lab: { c: [20, 238], via: [[14, 147.5], [14, 221]], axis: "x" },
  int: { c: [54, 238], via: [[54, 221]], axis: "x" },
  alv: { c: [80, 24], via: [], axis: "x" },
  pal: { c: [118, 24], via: [], axis: "x" },
  vel: { c: [158, 24], via: [], axis: "x" },
  uvu: { c: [243, 122], via: [[224, 128]], axis: "y" },
  pha: { c: [243, 172], via: [[224, 170]], axis: "y" },
  glo: { c: [243, 224], via: [[224, 229]], axis: "y" },
};
const MARK_STATES = ["idle", "quiet", "right", "wrong"];
const STATE_RANK = { right: 3, wrong: 2, idle: 1, quiet: 0 };

/**
 * Create a mouth diagram.
 * @param {object} [opts]
 * @param {Array<{id:string, short?:string, name?:string, desc?:string}>} [opts.places] PLACES from data.js
 * @param {boolean} [opts.interactive=false] markers become focusable buttons; picking one lights it and calls onPick(id)
 * @param {(id:string) => void} [opts.onPick] called after a marker is clicked or activated with Enter/Space
 * @param {"sm"|"md"|"lg"} [opts.size="md"] maximum rendered width (260 / 340 / 440 CSS px)
 * @returns {{ el: SVGSVGElement, setPlace(id: string|null, opts?: { also?: string|null }): void, setMarks(list: object[]): void, readonly place: string|null }}
 */
export function createMouth({ places, interactive = false, onPick, size = "md" } = {}) {
  const list = normalizePlaces(places);
  const byId = new Map(list.map((p) => [p.id, p]));
  const n = ++uid;
  const titleId = `mo-${n}-title`;
  const descId = `mo-${n}-desc`;
  const sizeClass = ["sm", "md", "lg"].includes(size) ? size : "md";
  const role = interactive ? "group" : "img";

  const markup = `<svg xmlns="${SVG_NS}" class="mo mo--${sizeClass}${interactive ? " mo-interactive" : ""}"
    viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="${VIEW_W}" height="${VIEW_H}"
    role="${role}" aria-labelledby="${titleId}" aria-describedby="${descId}" focusable="false">
    <title id="${titleId}">${TITLE_NONE}</title>
    <desc id="${descId}">${DESC}</desc>
    ${anatomyMarkup(`mo-${n}-tongue`)}
    ${highlightMarkup()}
    <g class="mo-callout" aria-hidden="true">
      <path class="mo-leader-halo" d=""/>
      <path class="mo-leader" d=""/>
      <text class="mo-label" x="0" y="0"></text>
    </g>
    <g class="mo-markers">${list.map((p) => markerMarkup(p, interactive)).join("")}</g>
    <g class="mo-marks" aria-hidden="true"></g>
  </svg>`;

  const tpl = document.createElement("template");
  tpl.innerHTML = markup.trim();
  const svg = tpl.content.firstElementChild;

  const title = svg.querySelector("title");
  const desc = svg.querySelector("desc");
  const callout = svg.querySelector(".mo-callout");
  const leaderHalo = callout.querySelector(".mo-leader-halo");
  const leader = callout.querySelector(".mo-leader");
  const label = callout.querySelector(".mo-label");
  const markers = new Map([...svg.querySelectorAll(".mo-mk")].map((g) => [g.dataset.place, g]));
  const highlights = [...svg.querySelectorAll(".mo-hl")];

  const marksLayer = svg.querySelector(".mo-marks");
  let current = null;
  let marked = false;

  const STATE_CLASSES = MARK_STATES.map((st) => `mo-s-${st}`);
  function clearMarks() {
    marked = false;
    svg.classList.remove("mo-has-marks");
    marksLayer.replaceChildren();
    for (const h of highlights) h.classList.remove("mo-extra", ...STATE_CLASSES);
    for (const g of markers.values()) g.classList.remove(...STATE_CLASSES);
  }

  /**
   * Numbered badges, each joined to the place it names by a leader line. Replaces setPlace's single label.
   * @param {Array<{ place: string, label: string|number, state?: "idle"|"quiet"|"right"|"wrong", extra?: string }>} list
   *   idle is the accent color, quiet is grey and does not light the place, right and wrong are green and red.
   *   `extra` names a second place for the same label, drawn hollow with a dashed leader (the pulled-back
   *   tongue root of an emphatic consonant). Two marks on one place sit side by side.
   */
  function setMarks(list) {
    const marks = (Array.isArray(list) ? list : [])
      .filter((m) => m && byId.has(m.place))
      .map((m) => ({
        place: m.place,
        label: String(m.label ?? ""),
        state: MARK_STATES.includes(m.state) ? m.state : "idle",
        extra: m.extra && byId.has(m.extra) && m.extra !== m.place ? m.extra : null,
      }));
    setPlace(null);
    if (!marks.length) return;
    marked = true;
    svg.classList.add("mo-has-marks");

    // The strongest state wins where two marks share a place.
    const placeState = new Map();
    const count = new Map();
    for (const m of marks) {
      count.set(m.place, (count.get(m.place) || 0) + 1);
      const had = placeState.get(m.place);
      if (!had || STATE_RANK[m.state] > STATE_RANK[had]) placeState.set(m.place, m.state);
    }
    for (const [pid, st] of placeState) {
      const lit = st !== "quiet";
      for (const h of highlights) if (h.dataset.hl === pid) h.classList.add(...(lit ? ["mo-on"] : []), `mo-s-${st}`);
      markers.get(pid)?.classList.add(...(lit ? ["mo-on"] : []), `mo-s-${st}`);
    }

    const seen = new Map();
    let leaders = "";
    let badges = "";
    for (const m of marks) {
      const b = BADGES[m.place];
      const n = count.get(m.place);
      const i = seen.get(m.place) || 0;
      seen.set(m.place, i + 1);
      const off = (i - (n - 1) / 2) * (BADGE_R * 2 + 3);
      const cx = b.c[0] + (b.axis === "x" ? off : 0);
      const cy = b.c[1] + (b.axis === "y" ? off : 0);
      leaders += `<path class="mo-lead mo-s-${m.state}" d="${leaderPath([MARKERS[m.place], ...b.via, [cx, cy]])}"/>`;
      badges += badgeMarkup(m, cx, cy, "");
      if (m.extra) {
        const e = BADGES[m.extra];
        const taken = marks.some((o) => o.place === m.extra);
        const ex = e.c[0] + (taken && e.axis === "x" ? BADGE_R * 2 + 3 : 0);
        const ey = e.c[1] + (taken && e.axis === "y" ? BADGE_R * 2 + 3 : 0);
        for (const h of highlights) if (h.dataset.hl === m.extra && !placeState.has(m.extra)) h.classList.add("mo-on", "mo-extra", `mo-s-${m.state}`);
        leaders += `<path class="mo-lead mo-lead-extra mo-s-${m.state}" d="${leaderPath([MARKERS[m.extra], ...e.via, [ex, ey]])}"/>`;
        badges += badgeMarkup({ ...m, place: m.extra }, ex, ey, " mo-badge-extra");
      }
    }
    marksLayer.innerHTML = leaders + badges;
    title.textContent = marks
      .map((m) => `${m.label}: ${byId.get(m.place).name}${m.extra ? ` and ${byId.get(m.extra).name}` : ""}`)
      .join("; ");
  }

  function badgeMarkup(m, cx, cy, extraClass) {
    return `<g class="mo-badge mo-s-${m.state}${extraClass}" data-place="${m.place}" data-label="${escText(m.label)}">` +
      `<circle cx="${cx}" cy="${cy}" r="${BADGE_R}"/><text x="${cx}" y="${cy}" dy="0.36em">${escText(m.label)}</text></g>`;
  }

  // `also` lights a second place more faintly, e.g. the pharynx for an emphatic consonant,
  // whose tongue root is pulled back while the tip works at the ridge.
  function setPlace(id, { also = null } = {}) {
    if (marked) clearMarks();
    const place = id == null ? null : byId.get(id) || null;
    current = place ? place.id : null;

    if (current) svg.dataset.place = current;
    else delete svg.dataset.place;

    for (const [pid, g] of markers) {
      const on = pid === current;
      g.classList.toggle("mo-on", on);
      if (interactive) g.setAttribute("aria-pressed", on ? "true" : "false");
    }
    for (const h of highlights) {
      h.classList.toggle("mo-on", h.dataset.hl === current);
      h.classList.toggle("mo-also", !!also && also !== current && h.dataset.hl === also);
    }

    if (place) {
      const c = CALLOUTS[place.id];
      const d = leaderPath(c.pts);
      leaderHalo.setAttribute("d", d);
      leader.setAttribute("d", d);
      label.setAttribute("x", String(c.x));
      label.setAttribute("y", String(c.y));
      label.setAttribute("text-anchor", c.anchor);
      label.textContent = place.short;
      callout.classList.toggle("mo-inside", c.inside);
      callout.classList.add("mo-on");
      title.textContent = MADE_AT[place.id];
      const extra = [sentence(`Highlighted: ${place.name}`), sentence(place.desc)].filter(Boolean).join(" ");
      desc.textContent = `${DESC} ${extra}`;
    } else {
      callout.classList.remove("mo-on");
      title.textContent = TITLE_NONE;
      desc.textContent = DESC;
    }
  }

  if (interactive) {
    const markerFrom = (e) => {
      const g = e.target instanceof Element ? e.target.closest(".mo-mk") : null;
      return g && svg.contains(g) ? g : null;
    };
    const pick = (g) => {
      const id = g.dataset.place;
      setPlace(id);
      if (typeof onPick === "function") onPick(id);
    };
    svg.addEventListener("click", (e) => {
      const g = markerFrom(e);
      if (g) pick(g);
    });
    svg.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      const g = markerFrom(e);
      if (!g) return;
      e.preventDefault();
      if (!e.repeat) pick(g);
    });
  }

  return {
    el: svg,
    setPlace,
    setMarks,
    get place() {
      return current;
    },
  };
}
