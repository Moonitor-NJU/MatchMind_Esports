const COVER_PALETTES = {
  LPL: ["#111827", "#c81e1e", "#f59e0b"],
  LCK: ["#07111f", "#0ea5e9", "#a78bfa"],
  LEC: ["#111827", "#f97316", "#facc15"],
  LCS: ["#0f172a", "#2563eb", "#22c55e"],
  LCP: ["#111827", "#14b8a6", "#e879f9"],
  default: ["#101828", "#0f766e", "#e8475b"]
};

function buildNewsCoverSvg({ title, source, league }) {
  const label = leagueLabelFromText(league || title || source);
  const palette = COVER_PALETTES[label] || COVER_PALETTES.default;
  const [base, accent, glow] = palette;
  const lines = svgTitleLines(title || "赛事焦点");
  const safeSource = escapeSvgText(source || "MatchMind");
  const safeLeague = escapeSvgText(label === "default" ? "MATCHMIND" : label);
  const textLines = lines.map((line, index) =>
    `<text x="44" y="${205 + index * 54}" class="title">${escapeSvgText(line)}</text>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" role="img" aria-label="${escapeSvgText(title || "赛事焦点")}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="${base}"/>
      <stop offset="0.56" stop-color="${accent}"/>
      <stop offset="1" stop-color="#070b13"/>
    </linearGradient>
    <radialGradient id="spot" cx="74%" cy="18%" r="58%">
      <stop offset="0" stop-color="${glow}" stop-opacity="0.62"/>
      <stop offset="0.5" stop-color="${glow}" stop-opacity="0.18"/>
      <stop offset="1" stop-color="${glow}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="34" height="34" patternUnits="userSpaceOnUse">
      <path d="M 34 0 L 0 0 0 34" fill="none" stroke="#ffffff" stroke-opacity="0.06" stroke-width="1"/>
    </pattern>
    <style>
      .source { font: 700 25px Arial, "Microsoft YaHei", sans-serif; fill: rgba(255,255,255,.72); letter-spacing: 1px; }
      .league { font: 800 18px Arial, "Microsoft YaHei", sans-serif; fill: ${glow}; }
      .title { font: 900 48px Arial, "Microsoft YaHei", sans-serif; fill: #ffffff; paint-order: stroke; stroke: rgba(0,0,0,.28); stroke-width: 5px; stroke-linejoin: round; }
      .meta { font: 700 24px Arial, "Microsoft YaHei", sans-serif; fill: rgba(255,255,255,.78); }
    </style>
  </defs>
  <rect width="960" height="540" fill="url(#bg)"/>
  <rect width="960" height="540" fill="url(#grid)"/>
  <rect width="960" height="540" fill="url(#spot)"/>
  <circle cx="820" cy="92" r="144" fill="#fff" opacity=".09"/>
  <circle cx="58" cy="468" r="230" fill="#020617" opacity=".26"/>
  <path d="M0 384 C178 322 300 390 475 333 C640 278 756 292 960 229 L960 540 L0 540 Z" fill="#020617" opacity=".33"/>
  <text x="44" y="82" class="source">MATCHMIND ESPORTS</text>
  <text x="44" y="128" class="league">${safeLeague} · TRENDING</text>
  ${textLines}
  <text x="44" y="458" class="meta">${safeSource}</text>
  <rect x="44" y="478" width="112" height="12" rx="6" fill="${glow}"/>
  <rect x="172" y="478" width="42" height="12" rx="6" fill="#fff" opacity=".6"/>
</svg>`;
}

function svgTitleLines(title) {
  const normalized = String(title || "赛事焦点").replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  const lines = [];
  let current = "";
  for (const char of chars) {
    if ((current + char).length > 16 && lines.length < 1) {
      lines.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) lines.push(current);
  if (!lines.length) lines.push("赛事焦点");
  return lines.slice(0, 2).map((line) => line.length > 18 ? `${line.slice(0, 17)}…` : line);
}

function escapeSvgText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generatedNewsCoverUrl(item, tournament = null) {
  const title = encodeURIComponent(item?.title || "赛事焦点");
  const source = encodeURIComponent(item?.source || tournament?.name || "MatchMind");
  const league = encodeURIComponent(leagueLabelFromTournament(tournament) || leagueLabelFromText(`${item?.title || ""} ${item?.source || ""}`));
  return `/api/news-cover?title=${title}&source=${source}&league=${league}`;
}

function leagueLabelFromTournament(tournament) {
  return leagueLabelFromText(`${tournament?.name || ""} ${tournament?.region || ""}`);
}

function leagueLabelFromText(value) {
  const text = String(value || "").toLowerCase();
  if (/\blpl\b|英雄联盟职业联赛|china|中国/.test(text)) return "LPL";
  if (/\blck\b|korea|韩国/.test(text)) return "LCK";
  if (/\blec\b|emea|europe|欧洲/.test(text)) return "LEC";
  if (/\blcs\b|north america|美洲|北美/.test(text)) return "LCS";
  if (/\blcp\b|pacific|亚太|pcs|vcs|ljl/.test(text)) return "LCP";
  return "default";
}

module.exports = {
  buildNewsCoverSvg,
  generatedNewsCoverUrl,
  leagueLabelFromText,
  leagueLabelFromTournament
};
