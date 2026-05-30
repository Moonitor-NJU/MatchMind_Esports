const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "tournaments.json");
const ENV_FILE = path.join(ROOT, ".env");

loadEnvFile();

const LIVE_CACHE_TTL_MS = Number(process.env.LIVE_CACHE_TTL_MS || 5 * 60 * 1000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg"
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function getTournament(id) {
  const data = readJson(DATA_FILE);
  return data.tournaments.find((item) => item.id === id) || data.tournaments[0];
}

function getTournamentFromData(data, id) {
  return data.tournaments.find((item) => item.id === id) || data.tournaments[0];
}

let liveDataCache = null;

async function getTournamentData(options = {}) {
  const provider = (process.env.REALTIME_PROVIDER || "auto").toLowerCase();
  const now = Date.now();
  if (!options.refresh && liveDataCache && now - liveDataCache.fetchedAt < LIVE_CACHE_TTL_MS) {
    return liveDataCache.data;
  }

  const localData = readJson(DATA_FILE);
  if (provider === "local") {
    return withMeta(localData, {
      mode: "local",
      source: "本地演示数据",
      updatedAt: new Date().toISOString()
    });
  }

  try {
    const realTimeData = await fetchRealTimeData();
    if (realTimeData.tournaments.length) {
      liveDataCache = { fetchedAt: now, data: realTimeData };
      return realTimeData;
    }
    throw new Error("实时接口没有返回可展示的比赛");
  } catch (error) {
    const fallback = withMeta(localData, {
      mode: "fallback",
      source: "本地演示数据",
      updatedAt: new Date().toISOString(),
      warning: `实时赛事接口暂不可用，已回退到本地数据：${error.message}`
    });
    liveDataCache = { fetchedAt: now, data: fallback };
    return fallback;
  }
}

function withMeta(data, meta) {
  return {
    ...data,
    meta
  };
}

async function fetchRealTimeData() {
  const provider = (process.env.REALTIME_PROVIDER || "auto").toLowerCase();
  if (provider === "pandascore" || provider === "auto") {
    return fetchPandaScoreLol();
  }
  throw new Error(`未知实时数据源：${provider}`);
}

async function fetchPandaScoreLol() {
  const token = process.env.PANDASCORE_API_TOKEN || process.env.PANDASCORE_TOKEN;
  if (!token) {
    throw new Error("未配置 PANDASCORE_API_TOKEN，无法拉取 PandaScore 实时赛程");
  }

  const baseUrl = process.env.PANDASCORE_BASE_URL || "https://api.pandascore.co";
  const game = process.env.PANDASCORE_GAME || "lol";
  const limit = clampNumber(process.env.PANDASCORE_MATCH_LIMIT, 10, 100, 100);
  const lookbackDays = clampNumber(process.env.PANDASCORE_LOOKBACK_DAYS, 0, 60, 2);
  const lookaheadDays = clampNumber(process.env.PANDASCORE_LOOKAHEAD_DAYS, 1, 90, 45);
  const now = new Date();
  const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000).toISOString();
  const endpoints = pandaMatchEndpoints(baseUrl, game, limit, from, to);
  const batches = await Promise.all(endpoints.map(async (endpoint) => {
    const response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      throw new Error(`PandaScore request failed: ${response.status}`);
    }
    return response.json();
  }));
  const matches = dedupeMatches(batches.flat());
  const tournaments = normalizePandaScoreMatches(matches, game);
  await enrichWithPandaStandings(tournaments, baseUrl, token);
  return withMeta({ tournaments }, {
    mode: "realtime",
    source: "PandaScore 实时赛事 API",
    updatedAt: new Date().toISOString(),
    queryWindow: { from, to },
    queryCount: endpoints.length,
    rawMatchCount: matches.length,
    matchCount: tournaments.reduce((sum, tournament) => sum + tournament.matches.length, 0),
    competitionCount: tournaments.length,
    competitions: tournaments.map((tournament) => ({
      id: tournament.id,
      name: tournament.name,
      stage: tournament.stage,
      matchCount: tournament.matches.length,
      teamCount: tournament.teams.length,
      standingsSource: tournament.standingsSource || "schedule-derived"
    }))
  });
}

function pandaMatchEndpoints(baseUrl, game, limit, from, to) {
  const configured = csv(process.env.PANDASCORE_LEAGUE_IDS);
  const defaultFocus = (process.env.PANDASCORE_FOCUS || "cn-major").toLowerCase() === "all"
    ? []
    : csv(process.env.PANDASCORE_DEFAULT_LEAGUE_IDS || "294,293,4197,5262");
  const leagueIds = configured.length ? configured : defaultFocus;
  const ids = leagueIds.length ? leagueIds : [null];
  return ids.map((leagueId) => {
    const endpoint = new URL(`/${game}/matches`, baseUrl);
    endpoint.searchParams.set("sort", "begin_at");
    endpoint.searchParams.set("per_page", String(limit));
    endpoint.searchParams.set("range[begin_at]", `${from},${to}`);
    if (leagueId) endpoint.searchParams.set("filter[league_id]", leagueId);
    return endpoint;
  });
}

function dedupeMatches(matches) {
  const byId = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    if (match?.id != null) byId.set(match.id, match);
  }
  return Array.from(byId.values());
}

function normalizePandaScoreMatches(matches, game) {
  const colors = ["#0f9f87", "#2563eb", "#e8475b", "#d97706", "#7c3aed", "#111827", "#0891b2", "#db2777"];
  const groups = new Map();
  const accepted = [];

  for (const raw of Array.isArray(matches) ? matches : []) {
    const opponents = Array.isArray(raw.opponents) ? raw.opponents.slice(0, 2) : [];
    if (opponents.length < 2) continue;

    const descriptor = pandaCompetitionDescriptor(raw, game);
    if (!shouldKeepPandaCompetition(descriptor)) continue;
    accepted.push(raw);
  }

  const sourceMatches = accepted.length ? accepted : Array.isArray(matches) ? matches : [];

  for (const raw of sourceMatches) {
    const opponents = Array.isArray(raw.opponents) ? raw.opponents.slice(0, 2) : [];
    if (opponents.length < 2) continue;

    const descriptor = pandaCompetitionDescriptor(raw, game);
    const key = descriptor.key;
    if (!groups.has(key)) {
      groups.set(key, {
        descriptor,
        teams: new Map(),
        matches: []
      });
    }
    const group = groups.get(key);
    const left = normalizePandaTeam(opponents[0].opponent, group.teams, colors);
    const right = normalizePandaTeam(opponents[1].opponent, group.teams, colors);
    if (!left || !right) continue;
    const result = normalizePandaResult(raw, left.pandaId, right.pandaId);

    group.matches.push({
      id: `ps-${raw.id}`,
      startsAt: raw.begin_at || raw.scheduled_at || raw.original_scheduled_at || new Date().toISOString(),
      status: normalizePandaStatus(raw.status),
      round: raw.name || raw.match_type || descriptor.stage,
      bestOf: Number(raw.number_of_games || raw.games?.length || 3),
      league: descriptor.league,
      serie: descriptor.serie,
      stage: descriptor.stage,
      teams: [left.id, right.id],
      result
    });
  }

  return Array.from(groups.values())
    .map((group) => {
      const teamList = Array.from(group.teams.values());
      return {
        id: group.descriptor.id,
        name: group.descriptor.name,
        game: game === "lol" ? "League of Legends" : game.toUpperCase(),
        region: group.descriptor.region,
        stage: group.descriptor.stage,
        season: group.descriptor.serie,
        source: `PandaScore 实时赛事 API · ${group.descriptor.league}`,
        rules: competitionRules(group.descriptor, teamList.length),
        standingsSource: "schedule-derived",
        externalIds: {
          pandascoreLeagueId: group.descriptor.leagueId,
          pandascoreSerieId: group.descriptor.serieId,
          pandascoreTournamentId: group.descriptor.tournamentId
        },
        teams: teamList,
        matches: group.matches.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      };
    })
    .filter((tournament) => tournament.matches.length)
    .sort(comparePandaTournaments);
}

async function enrichWithPandaStandings(tournaments, baseUrl, token) {
  await Promise.all(tournaments.map(async (tournament) => {
    const tournamentId = tournament.externalIds?.pandascoreTournamentId;
    if (!tournamentId) return;
    try {
      const endpoint = new URL(`/tournaments/${tournamentId}/standings`, baseUrl);
      const response = await fetch(endpoint, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`
        }
      });
      if (!response.ok) {
        tournament.standingsWarning = `官方积分榜接口返回 ${response.status}`;
        return;
      }
      const rawStandings = await response.json();
      const official = normalizePandaStandings(rawStandings, tournament);
      if (official.length) {
        tournament.officialStandings = official;
        tournament.standingsSource = "official";
      } else {
        tournament.standingsWarning = "官方积分榜暂未返回可识别排名字段";
      }
    } catch (error) {
      tournament.standingsWarning = `官方积分榜暂不可用：${error.message}`;
    }
  }));
}

function normalizePandaStandings(rawStandings, tournament) {
  const rows = flattenStandings(rawStandings);
  const byPandaId = new Map(tournament.teams.map((team) => [team.pandaId, team]));
  const byName = new Map(tournament.teams.map((team) => [team.name.toLowerCase(), team]));
  return rows.map((row, index) => {
    const teamLike = row.team || row.opponent || row.participant || row.competitor || row;
    const pandaId = teamLike?.id || row.team_id || row.opponent_id;
    const name = teamLike?.acronym || teamLike?.name || row.team_name || row.name;
    const team = byPandaId.get(pandaId) || byName.get(String(name || "").toLowerCase());
    if (!team && !name) return null;
    const wins = firstNumber(row.wins, row.win, row.victories, row.matches_won, row.total_wins);
    const losses = firstNumber(row.losses, row.loss, row.defeats, row.matches_lost, row.total_losses);
    const mapWins = firstNumber(row.map_wins, row.game_wins, row.for, row.points_for, row.score_for);
    const mapLosses = firstNumber(row.map_losses, row.game_losses, row.against, row.points_against, row.score_against);
    const differential = firstNumber(row.differential, row.diff, row.point_difference, row.score_diff);
    return {
      id: team?.id || `${slugify(name)}-${pandaId || index}`,
      name: team?.name || name,
      region: team?.region || teamLike?.location || "Global",
      wins: wins ?? 0,
      losses: losses ?? 0,
      mapWins: mapWins ?? 0,
      mapLosses: mapLosses ?? 0,
      differential: differential ?? ((mapWins ?? 0) - (mapLosses ?? 0)),
      remaining: firstNumber(row.remaining, row.matches_remaining) ?? 0,
      played: firstNumber(row.played, row.matches_played) ?? ((wins ?? 0) + (losses ?? 0)),
      rank: firstNumber(row.rank, row.position, row.place) ?? index + 1,
      form: Array.isArray(row.form) ? row.form.slice(-5) : [],
      official: true
    };
  }).filter(Boolean).sort((a, b) => a.rank - b.rank);
}

function flattenStandings(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (Array.isArray(item.standings)) return flattenStandings(item.standings);
      if (Array.isArray(item.rows)) return flattenStandings(item.rows);
      if (Array.isArray(item.teams)) return flattenStandings(item.teams);
      return [item];
    });
  }
  if (!value || typeof value !== "object") return [];
  return flattenStandings(value.standings || value.rows || value.teams || []);
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pandaCompetitionDescriptor(raw, game) {
  const league = raw.league?.name || game.toUpperCase();
  const serie = raw.serie?.full_name || raw.serie?.name || "近期赛程";
  const stage = raw.tournament?.name || raw.tournament?.slug || "赛程";
  const region = raw.league?.region || raw.serie?.league?.region || "Global";
  const id = [
    game,
    raw.league?.id || slugify(league),
    raw.serie?.id || slugify(serie),
    raw.tournament?.id || slugify(stage)
  ].map((part) => slugify(part)).join("-");
  return {
    id,
    key: id,
    tournamentId: raw.tournament?.id,
    leagueId: raw.league?.id,
    serieId: raw.serie?.id,
    league,
    serie,
    stage,
    region,
    name: [league, serie, stage].filter(uniqueLabel).join(" · ")
  };
}

function competitionRules(descriptor, teamCount) {
  const text = `${descriptor.league} ${descriptor.serie} ${descriptor.stage}`.toLowerCase();
  if (text.includes("lpl") && text.includes("playoff")) {
    return {
      format: "LPL Split 2 季后赛双败 BO5",
      phase: "playoffs",
      advanceSlots: 0,
      eliminationSlots: 0,
      labels: {
        upper: "胜者组",
        lower: "败者组",
        final: "决赛路径"
      },
      tiebreakers: ["双败淘汰赛签表", "胜者组晋级", "败者组续命", "BO5 胜负关系"]
    };
  }
  if (text.includes("lpl") && (text.includes("ascend") || text.includes("登峰"))) {
    return {
      format: "LPL Split 2 登峰组",
      phase: "regular",
      advanceSlots: 4,
      playInSlots: 4,
      eliminationSlots: 0,
      labels: {
        advance: "季后赛直通区",
        playIn: "骑士之路区"
      },
      tiebreakers: ["官方积分榜排名", "胜场", "小分/局分", "官方加赛规则"]
    };
  }
  if (text.includes("lpl") && (text.includes("nirvana") || text.includes("涅槃"))) {
    return {
      format: "LPL Split 2 涅槃组",
      phase: "regular",
      advanceSlots: 0,
      playInSlots: teamCount,
      eliminationSlots: 0,
      labels: {
        playIn: "骑士之路竞争区"
      },
      tiebreakers: ["官方积分榜排名", "胜场", "小分/局分", "官方加赛规则"]
    };
  }
  return {
    format: "按官方赛事组展示，排名优先使用官方积分榜",
    phase: text.includes("playoff") || text.includes("qualifier") ? "playoffs" : "regular",
    advanceSlots: Math.min(4, Math.max(1, Math.ceil(teamCount / 2))),
    eliminationSlots: 0,
    labels: {
      advance: "排名前列",
      watch: "观察区"
    },
    tiebreakers: ["官方积分榜排名", "胜场", "小分/局分", "赛事官网规则"]
  };
}

function uniqueLabel(value, index, list) {
  const normalized = String(value || "").toLowerCase();
  return value && list.findIndex((item) => String(item || "").toLowerCase() === normalized) === index;
}

function shouldKeepPandaCompetition(descriptor) {
  if ((process.env.PANDASCORE_FOCUS || "cn-major").toLowerCase() === "all") return true;
  const text = `${descriptor.league} ${descriptor.serie} ${descriptor.stage}`.toLowerCase();
  const include = csv(process.env.PANDASCORE_INCLUDE_KEYWORDS || [
    "lpl",
    "league of legends pro league",
    "lck",
    "league of legends champions korea",
    "lec",
    "league of legends emea championship",
    "msi",
    "mid-season",
    "world championship",
    "worlds",
    "ewc",
    "esports world cup",
    "first stand",
    "demacia"
  ].join(","));
  const exclude = csv(process.env.PANDASCORE_EXCLUDE_KEYWORDS || [
    "lplol",
    "academy",
    "challenger",
    "challengers",
    "division 2",
    "secondary"
  ].join(","));
  return include.some((keyword) => keywordMatches(text, keyword)) &&
    !exclude.some((keyword) => text.includes(keyword.toLowerCase()));
}

function keywordMatches(text, keyword) {
  const normalized = keyword.toLowerCase().trim();
  if (!normalized) return false;
  if (/^[a-z0-9]+$/.test(normalized)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalized)}([^a-z0-9]|$)`).test(text);
  }
  return text.includes(normalized);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function comparePandaTournaments(a, b) {
  const priority = (value) => {
    const text = `${value.name} ${value.stage}`.toLowerCase();
    const keywords = ["lpl", "lck", "ewc", "esports world cup", "msi", "world", "lec"];
    const index = keywords.findIndex((keyword) => keywordMatches(text, keyword));
    return index === -1 ? keywords.length : index;
  };
  const byPriority = priority(a) - priority(b);
  if (byPriority) return byPriority;
  const aLive = a.matches.some((match) => match.status === "live") ? 0 : 1;
  const bLive = b.matches.some((match) => match.status === "live") ? 0 : 1;
  if (aLive !== bLive) return aLive - bLive;
  const aNext = a.matches[0]?.startsAt || "";
  const bNext = b.matches[0]?.startsAt || "";
  return aNext.localeCompare(bNext);
}

function normalizePandaTeam(rawTeam, teams, colors) {
  if (!rawTeam) return null;
  const pandaId = rawTeam.id;
  const id = `${slugify(rawTeam.acronym || rawTeam.slug || rawTeam.name || "team")}-${pandaId}`;
  if (!teams.has(id)) {
    teams.set(id, {
      id,
      pandaId,
      name: rawTeam.acronym || rawTeam.name,
      region: rawTeam.location || "Global",
      color: colors[teams.size % colors.length]
    });
  }
  return teams.get(id);
}

function normalizePandaResult(match, leftPandaId, rightPandaId) {
  if (match.status !== "finished") return null;
  const resultByTeam = new Map((match.results || []).map((item) => [item.team_id, item.score]));
  const left = resultByTeam.get(leftPandaId);
  const right = resultByTeam.get(rightPandaId);
  if (left == null || right == null) return null;
  return { left, right };
}

function normalizePandaStatus(status) {
  return {
    running: "live",
    not_started: "scheduled",
    finished: "finished",
    canceled: "finished"
  }[status] || "scheduled";
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugify(value) {
  return String(value || "team")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "team";
}

function teamMap(tournament) {
  return new Map(tournament.teams.map((team) => [team.id, team]));
}

function buildStandings(tournament, scenario = {}) {
  if (tournament.officialStandings && !Object.keys(scenario).length) {
    return tournament.officialStandings.map((row) => ({
      ...row,
      form: row.form || []
    }));
  }

  const teams = teamMap(tournament);
  const rows = tournament.teams.map((team) => ({
    id: team.id,
    name: team.name,
    region: team.region,
    wins: 0,
    losses: 0,
    mapWins: 0,
    mapLosses: 0,
    differential: 0,
    remaining: 0,
    played: 0,
    form: []
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const match of tournament.matches) {
    const override = scenario[match.id];
    const result = override || match.result;
    const left = byId.get(match.teams[0]);
    const right = byId.get(match.teams[1]);
    if (!left || !right) continue;

    if (!result || result.left == null || result.right == null) {
      left.remaining += 1;
      right.remaining += 1;
      continue;
    }

    const leftWon = result.left > result.right;
    const rightWon = result.right > result.left;
    left.played += 1;
    right.played += 1;
    left.mapWins += result.left;
    left.mapLosses += result.right;
    right.mapWins += result.right;
    right.mapLosses += result.left;
    left.differential = left.mapWins - left.mapLosses;
    right.differential = right.mapWins - right.mapLosses;
    if (leftWon) {
      left.wins += 1;
      right.losses += 1;
      left.form.push("W");
      right.form.push("L");
    } else if (rightWon) {
      right.wins += 1;
      left.losses += 1;
      right.form.push("W");
      left.form.push("L");
    }
  }

  return rows.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.differential !== a.differential) return b.differential - a.differential;
    if (b.mapWins !== a.mapWins) return b.mapWins - a.mapWins;
    return a.name.localeCompare(b.name);
  }).map((row, index) => ({
    ...row,
    rank: index + 1,
    form: row.form.slice(-5)
  }));
}

function qualificationStatus(tournament, standings) {
  if (tournament.standingsSource !== "official") {
    return standings.map((row) => ({
      ...row,
      maxWins: row.wins + row.remaining,
      status: "近期赛程推算",
      tone: "watch",
      note: `${row.name} 的战绩来自当前接口返回的近期赛程，不等同于完整赛段官方积分榜。晋级结论需要结合官方积分榜和赛制。`
    }));
  }

  if (tournament.rules?.labels?.playIn && !tournament.rules?.advanceSlots) {
    return standings.map((row) => ({
      ...row,
      maxWins: row.wins + row.remaining,
      status: tournament.rules.labels.playIn,
      tone: "watch",
      note: `${row.name} 当前官方排名第 ${row.rank}。${tournament.rules.format} 的晋级/骑士之路归属以官方最终排名和加赛规则为准。`
    }));
  }

  const advanceSlots = tournament.rules.advanceSlots;
  const playInSlots = tournament.rules.playInSlots || 0;
  const labels = tournament.rules.labels || {};
  return standings.map((row) => {
    let status = labels.watch || "观察区";
    let tone = "watch";

    if (row.rank <= advanceSlots) {
      status = labels.advance || "晋级区";
      tone = "safe";
    } else if (playInSlots && row.rank <= advanceSlots + playInSlots) {
      status = labels.playIn || "附加赛区";
      tone = "watch";
    }

    const target = standings[Math.max(0, advanceSlots - 1)];
    const winGap = target ? row.wins - target.wins : 0;
    return {
      ...row,
      maxWins: row.wins + row.remaining,
      status,
      tone,
      note: `${row.name} 当前官方排名第 ${row.rank}，战绩 ${row.wins}-${row.losses}。${target ? `与第 ${advanceSlots} 名胜场差为 ${winGap}。` : ""}具体晋级结论需结合 ${tournament.rules.format} 和官方小分/加赛规则。`
    };
  });
}

function keyMatches(tournament, standings) {
  const byId = new Map(standings.map((row) => [row.id, row]));
  const advanceSlots = tournament.rules.advanceSlots || Math.max(1, Math.ceil(standings.length / 2));
  return tournament.matches
    .filter((match) => match.status !== "finished")
    .map((match) => {
      const left = byId.get(match.teams[0]);
      const right = byId.get(match.teams[1]);
      if (!left || !right) return null;
      const rankPressure = Math.abs(left.rank - advanceSlots) + Math.abs(right.rank - advanceSlots);
      const importance = rankPressure <= 2 ? "高" : rankPressure <= 5 ? "中" : "低";
      const tag = importance === "高" ? "晋级关键战" : importance === "中" ? "排名影响战" : "常规赛程";
      return {
        id: match.id,
        startsAt: match.startsAt,
        left: left.name,
        right: right.name,
        importance,
        tag,
        reason: `${left.name} 排名第 ${left.rank}，${right.name} 排名第 ${right.rank}。这场比赛会影响晋级线附近的胜场差和小分。`
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function localAnalysis(tournament, scenario = {}) {
  const standings = buildStandings(tournament, scenario);
  const teams = qualificationStatus(tournament, standings);
  const matches = keyMatches(tournament, standings);
  const phaseView = buildPhaseView(tournament, teams);
  const focusStories = buildFocusStories(tournament, teams, phaseView);
  const safe = teams.filter((team) => team.tone === "safe").slice(0, 3).map((team) => team.name).join("、") || "暂无";
  const playIn = teams.filter((team) => team.status.includes("骑士") || team.status.includes("附加")).slice(0, 4).map((team) => team.name).join("、") || "暂无";
  const focus = matches[0];
  const sourceText = tournament.standingsSource === "official"
    ? "当前积分榜来自 PandaScore 官方 standings 接口。"
    : "当前积分榜只根据接口返回的近期赛程推算，不代表完整赛段官方排名。";
  const ruleText = tournament.rules?.labels?.advance
    ? `${tournament.rules.format}：${tournament.rules.labels.advance}${tournament.rules.labels.playIn ? `，其余关注${tournament.rules.labels.playIn}` : ""}。`
    : `${tournament.rules?.format || "赛制"}，具体晋级规则以官方公告为准。`;
  const summary = [
    `${tournament.name}。${focusStories[0]?.headline || `${sourceText}${ruleText}`}`,
    tournament.rules.advanceSlots ? `目前 ${safe} 位于${tournament.rules.labels?.advance || "排名前列"}；${playIn !== "暂无" ? `${playIn} 位于${tournament.rules.labels?.playIn || "观察区"}。` : "其他队伍仍需结合后续赛程和小分判断。"}` : `当前所有队伍都需要结合${tournament.rules.labels?.playIn || "后续阶段"}规则判断。`,
    focus ? `下一场重点关注 ${focus.left} vs ${focus.right}，原因是双方官方/推算排名接近关键分界。` : "目前没有未结束比赛，或当前接口窗口内没有后续赛程。",
    "不要仅凭最近几场结果宣称锁定晋级或理论淘汰；需要同时看官方积分、赛制分区、小分和加赛规则。"
  ].join("\n");
  return { standings, teams, keyMatches: matches, focusStories, phaseView, summary };
}

function buildPhaseView(tournament, teams) {
  if (tournament.rules?.phase === "playoffs") {
    return buildPlayoffView(tournament);
  }
  return {
    type: "standings",
    title: "积分榜",
    subtitle: tournament.standingsSource === "official" ? "官方积分榜" : "近期赛程推算榜",
    rows: teams
  };
}

function buildPlayoffView(tournament) {
  const finished = tournament.matches.filter((match) => match.status === "finished");
  const upcoming = tournament.matches.filter((match) => match.status !== "finished");
  const cards = tournament.matches.map((match) => {
    const left = teamName(tournament, match.teams[0]);
    const right = teamName(tournament, match.teams[1]);
    const bracket = bracketLabel(match.round);
    const result = match.result;
    const winner = result ? (result.left > result.right ? left : right) : null;
    const loser = result ? (result.left > result.right ? right : left) : null;
    return {
      id: match.id,
      startsAt: match.startsAt,
      round: match.round,
      bracket,
      status: match.status,
      bestOf: match.bestOf,
      left,
      right,
      score: result ? `${result.left}:${result.right}` : "未赛",
      winner,
      loser,
      impact: playoffImpact(bracket, winner, loser)
    };
  });
  return {
    type: "playoffs",
    title: "季后赛晋级形势",
    subtitle: tournament.rules?.format || "淘汰赛签表",
    completedCount: finished.length,
    upcomingCount: upcoming.length,
    cards
  };
}

function bracketLabel(round = "") {
  const text = round.toLowerCase();
  if (text.includes("upper")) return "胜者组";
  if (text.includes("lower")) return "败者组";
  if (text.includes("final")) return "决赛";
  if (text.includes("semi")) return "半决赛";
  if (text.includes("quarter")) return "四分之一决赛";
  return "淘汰赛";
}

function playoffImpact(bracket, winner, loser) {
  if (!winner) return `${bracket}待战，胜者继续冲击下一轮，败者将根据签表进入败者组或结束赛程。`;
  if (bracket === "胜者组") return `${winner} 留在胜者组推进，${loser} 掉入败者组，后续容错明显降低。`;
  if (bracket === "败者组") return `${winner} 续命晋级，${loser} 被淘汰或结束本阶段。`;
  return `${winner} 晋级，${loser} 进入下一条签表路径或结束赛程。`;
}

function teamName(tournament, id) {
  return tournament.teams.find((team) => team.id === id)?.name || id;
}

function buildFocusStories(tournament, teams, phaseView) {
  const candidates = detectFocusCandidates(tournament, teams, phaseView)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates.slice(0, 2).map(({ score, order, ...story }) => story);
}

function detectFocusCandidates(tournament, teams, phaseView) {
  const candidates = [];
  const add = (candidate) => candidates.push({ order: candidates.length, ...candidate });
  if (phaseView.type === "playoffs") {
    playoffFocusCandidates(tournament, phaseView).forEach(add);
  } else {
    regularFocusCandidates(tournament, teams).forEach(add);
  }
  if (!candidates.length) {
    add(fallbackFocus(tournament, teams, phaseView));
  }
  return candidates;
}

function playoffFocusCandidates(tournament, phaseView) {
  const candidates = [];
  const upcoming = phaseView.cards.filter((card) => card.status !== "finished");
  const finished = phaseView.cards.filter((card) => card.winner);
  const lowerNext = upcoming.find((card) => card.bracket === "败者组");
  const upperNext = upcoming.find((card) => card.bracket === "胜者组");
  const next = upcoming[0];
  const lowerTeams = new Set([
    ...finished.filter((card) => card.bracket === "胜者组").map((card) => card.loser),
    ...upcoming.filter((card) => card.bracket === "败者组").flatMap((card) => [card.left, card.right])
  ].filter(Boolean));
  const upsetTeams = underdogSurvivors(tournament, phaseView, lowerTeams);

  if (lowerNext) {
    candidates.push({
      score: 96,
      tone: "hot",
      headline: `${lowerNext.left} vs ${lowerNext.right} 是下一场败者组生死战。`,
      body: `${lowerNext.bracket} BO${lowerNext.bestOf} 容错已经见底，胜者续命，败者基本结束本阶段；这比普通积分榜更能说明当前形势。`,
      chips: ["败者组", "生死战", `BO${lowerNext.bestOf}`]
    });
  }

  if (upsetTeams.length) {
    candidates.push({
      score: 90,
      tone: "hot",
      headline: `${upsetTeams.join("、")} 仍在淘汰赛路径中制造变数。`,
      body: next ? `下一场 ${next.left} vs ${next.right} 会继续检验不同签表位置的队伍能否跨过当前对手。` : `当前已完成 ${finished.length} 场，后续重点看这些队伍能否在败者组或胜者组延续表现。`,
      chips: ["爆冷线索", "签表压力"]
    });
  }

  if (upperNext) {
    candidates.push({
      score: 82,
      tone: "watch",
      headline: `${upperNext.left} vs ${upperNext.right} 决定胜者组下一段主动权。`,
      body: `胜者继续保留更高容错和更短晋级路径，败者会被迫转入败者组或承受更高淘汰风险。`,
      chips: ["胜者组", "晋级路径", `BO${upperNext.bestOf}`]
    });
  }

  if (!upcoming.length) {
    candidates.push({
      score: 70,
      tone: "watch",
      headline: `${tournament.name} 当前接口窗口内没有待赛场次。`,
      body: `已完成 ${finished.length} 场，重点应回看胜负路径和后续官方签表更新，而不是积分榜。`,
      chips: ["淘汰赛", "等待更新"]
    });
  }
  return candidates;
}

function underdogSurvivors(tournament, phaseView, lowerTeams) {
  const seedMap = seedOrderFromOpeningMatches(phaseView.cards);
  const names = new Set();
  for (const card of phaseView.cards) {
    const leftSeed = seedMap.get(card.left);
    const rightSeed = seedMap.get(card.right);
    for (const name of [card.left, card.right]) {
      const seed = seedMap.get(name);
      if (seed && seed > Math.ceil(seedMap.size / 2) && (card.status !== "finished" || lowerTeams.has(name))) {
        names.add(name);
      }
    }
    if (card.winner && leftSeed && rightSeed) {
      const winnerSeed = seedMap.get(card.winner);
      const loserSeed = seedMap.get(card.loser);
      if (winnerSeed > loserSeed) names.add(card.winner);
    }
  }
  return Array.from(names).slice(0, 4);
}

function seedOrderFromOpeningMatches(cards) {
  const firstRound = cards.filter((card) => card.round.toLowerCase().includes("quarter") || card.round.toLowerCase().includes("round 1"));
  const names = [];
  for (const card of firstRound.length ? firstRound : cards) {
    for (const name of [card.left, card.right]) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return new Map(names.map((name, index) => [name, index + 1]));
}

function regularFocusCandidates(tournament, teams) {
  const candidates = [];
  const sorted = teams.slice().sort((a, b) => a.rank - b.rank);
  const advanceSlots = tournament.rules.advanceSlots || Math.min(6, Math.ceil(sorted.length / 2));
  const topCut = closeCutRace(sorted, 2, "前二复活甲");
  const playoffCut = closeCutRace(sorted, advanceSlots, tournament.rules.labels?.advance || "季后赛席位");
  const nextDirect = nextDirectRankingMatch(tournament, sorted, advanceSlots);

  if (topCut && sorted.length >= 4) {
    const scenario = cutRaceScenario(tournament, topCut, sorted, 2);
    candidates.push({
      score: topCut.gap <= 1 ? 94 : 76,
      tone: topCut.gap <= 1 ? "hot" : "watch",
      headline: `${topCut.left.name}、${topCut.right.name} 正在争夺${topCut.label}。`,
      body: scenario,
      chips: ["前二竞争", "复活甲", "小分"]
    });
  }

  if (playoffCut && playoffCut.slot !== 2) {
    const scenario = cutRaceScenario(tournament, playoffCut, sorted, playoffCut.slot);
    candidates.push({
      score: playoffCut.gap <= 1 ? 88 : 70,
      tone: playoffCut.gap <= 1 ? "hot" : "watch",
      headline: `${playoffCut.left.name} 与 ${playoffCut.right.name} 卡在${playoffCut.label}分界线。`,
      body: scenario,
      chips: ["晋级线", "卡位战"]
    });
  }

  if (nextDirect) {
    candidates.push({
      score: 84,
      tone: "hot",
      headline: `${nextDirect.left.name} vs ${nextDirect.right.name} 是近期直接卡位战。`,
      body: `双方排名第 ${nextDirect.left.rank} 和第 ${nextDirect.right.rank}，靠近关键分界；这类直接交手比普通赛程更能改变主动权。`,
      chips: ["直接对话", "关键赛程"]
    });
  }

  if (!candidates.length && sorted.length) {
    const top = sorted.slice(0, 3);
    candidates.push({
      score: 50,
      tone: "watch",
      headline: `${tournament.name} 当前主要看官方积分榜稳定性。`,
      body: `排名前列为 ${top.map((team) => `${team.name}(${team.wins}-${team.losses})`).join("、")}，后续焦点会随胜场差和剩余赛程自动切换。`,
      chips: ["常规赛", "积分榜"]
    });
  }
  return candidates;
}

function cutRaceScenario(tournament, race, sorted, slot) {
  const contenders = nearbyContenders(sorted, slot);
  const scheduleLines = contenders
    .map((team) => teamScheduleLine(tournament, team))
    .filter(Boolean);
  const direct = directMatchAmong(tournament, contenders);
  const leader = race.left;
  const chaser = race.right;
  const gapText = `${leader.name} 当前 ${leader.wins}-${leader.losses}，${chaser.name} 当前 ${chaser.wins}-${chaser.losses}，胜场差 ${race.gap}`;
  const scenarioLines = [];

  if (race.gap === 0) {
    scenarioLines.push(`${leader.name} 和 ${chaser.name} 同胜场，下一轮谁丢分都会把主动权让给对方；若都赢，排序大概率继续看小分/局分。`);
  } else if (race.gap === 1) {
    scenarioLines.push(`${chaser.name} 需要自己赢球，同时等待 ${leader.name} 丢一场，才能把竞争重新拉回同胜场；如果 ${leader.name} 也赢，${chaser.name} 至少还要继续追小分。`);
  } else {
    scenarioLines.push(`${chaser.name} 已经落后 ${race.gap} 个胜场，短期内必须连续拿分，同时等待前面的队伍连续失误。`);
  }

  if (direct) {
    scenarioLines.push(`最直接的变数是 ${direct.left.name} vs ${direct.right.name}，这场会直接改变分界线两侧的胜场关系。`);
  }
  if (scheduleLines.length) {
    scenarioLines.push(`近期重点赛程：${scheduleLines.join("；")}。`);
  }
  return `${gapText}。${scenarioLines.join("")}`;
}

function nearbyContenders(sorted, slot) {
  if (slot === 2) return sorted.slice(0, Math.min(sorted.length, 3));
  const start = Math.max(0, slot - 3);
  const end = Math.min(sorted.length, slot + 2);
  return sorted.slice(start, end);
}

function teamScheduleLine(tournament, team) {
  const matches = upcomingMatchesForTeam(tournament, team.name).slice(0, 2);
  if (!matches.length) return `${team.name} 当前窗口内暂无待赛，主动权取决于竞争对手赛果`;
  return `${team.name} 接下来 ${matches.map((match) => `${formatShortDate(match.startsAt)} 对 ${opponentName(tournament, match, team.name)}`).join("、")}`;
}

function upcomingMatchesForTeam(tournament, team) {
  return tournament.matches
    .filter((match) => match.status !== "finished" && match.teams.some((id) => teamName(tournament, id) === team))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function directMatchAmong(tournament, teams) {
  const names = new Set(teams.map((team) => team.name));
  return tournament.matches
    .filter((match) => match.status !== "finished")
    .map((match) => {
      const left = teamName(tournament, match.teams[0]);
      const right = teamName(tournament, match.teams[1]);
      if (!names.has(left) || !names.has(right)) return null;
      return { left: teams.find((team) => team.name === left), right: teams.find((team) => team.name === right), startsAt: match.startsAt };
    })
    .filter(Boolean)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] || null;
}

function opponentName(tournament, match, team) {
  return match.teams.map((id) => teamName(tournament, id)).find((name) => name !== team) || "待定";
}

function formatShortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待定";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai"
  }).format(date);
}

function closeCutRace(sorted, slot, label) {
  if (!slot || sorted.length <= slot) return null;
  const left = sorted[slot - 1];
  const right = sorted[slot];
  if (!left || !right) return null;
  return {
    slot,
    label,
    left,
    right,
    gap: Math.abs(left.wins - right.wins)
  };
}

function nextDirectRankingMatch(tournament, sorted, advanceSlots) {
  const rankByName = new Map(sorted.map((team) => [team.name, team]));
  const candidates = tournament.matches
    .filter((match) => match.status !== "finished")
    .map((match) => {
      const left = rankByName.get(teamName(tournament, match.teams[0]));
      const right = rankByName.get(teamName(tournament, match.teams[1]));
      if (!left || !right) return null;
      const rankGap = Math.abs(left.rank - right.rank);
      const playoffPressure = Math.max(Math.abs(left.rank - advanceSlots), Math.abs(right.rank - advanceSlots));
      const topPressure = Math.max(Math.abs(left.rank - 2), Math.abs(right.rank - 2));
      const cutPressure = Math.min(playoffPressure, topPressure);
      const bothNearPlayoff = left.rank <= advanceSlots + 2 && right.rank <= advanceSlots + 2;
      const bothNearTop = left.rank <= 4 && right.rank <= 4;
      return { left, right, rankGap, cutPressure, bothNearPlayoff, bothNearTop, startsAt: match.startsAt };
    })
    .filter(Boolean)
    .filter((item) => item.cutPressure <= 1 || (item.rankGap <= 3 && (item.bothNearPlayoff || item.bothNearTop)))
    .sort((a, b) => a.cutPressure - b.cutPressure || a.rankGap - b.rankGap || a.startsAt.localeCompare(b.startsAt));
  return candidates[0] || null;
}

function fallbackFocus(tournament, teams, phaseView) {
  if (phaseView.type === "playoffs") {
    return {
      score: 10,
      tone: "watch",
      headline: `${tournament.name} 已进入淘汰赛阶段。`,
      body: "当前更应关注胜败者组路径、待战场次和淘汰风险，而不是积分榜。",
      chips: ["淘汰赛", "晋级路径"]
    };
  }
  const top = teams.slice().sort((a, b) => a.rank - b.rank).slice(0, 3);
  return {
    score: 10,
    tone: "watch",
    headline: `${tournament.name} 当前仍以官方积分榜为主。`,
    body: `排名前列为 ${top.map((team) => `${team.name}(${team.wins}-${team.losses})`).join("、")}，后续焦点会随赛程更新。`,
    chips: ["常规赛", "积分榜"]
  };
}

function compactContext(tournament, analysis) {
  return JSON.stringify({
    tournament: {
      name: tournament.name,
      game: tournament.game,
      stage: tournament.stage,
      rules: tournament.rules,
      standingsSource: tournament.standingsSource || "schedule-derived",
      standingsWarning: tournament.standingsWarning || null
    },
    standings: analysis.standings,
    qualification: analysis.teams,
    focusStories: analysis.focusStories,
    phaseView: analysis.phaseView,
    keyMatches: analysis.keyMatches.slice(0, 5)
  });
}

async function callLlm(provider, prompt, context) {
  const providers = {
    deepseek: {
      key: process.env.DEEPSEEK_API_KEY,
      url: "https://api.deepseek.com/chat/completions",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat"
    },
    qwen: {
      key: process.env.DASHSCOPE_API_KEY,
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      model: process.env.QWEN_MODEL || "qwen-plus"
    },
    kimi: {
      key: process.env.MOONSHOT_API_KEY,
      url: "https://api.moonshot.cn/v1/chat/completions",
      model: process.env.KIMI_MODEL || "moonshot-v1-8k"
    },
    zhipu: {
      key: process.env.ZHIPU_API_KEY,
      url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: process.env.ZHIPU_MODEL || "glm-4-flash"
    }
  };
  const config = providers[provider] || providers.deepseek;
  if (!config.key) return null;

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.key}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "你是面向中国观众的电竞赛事数据分析 Agent。必须基于给定结构化数据回答，不要编造未提供的赛果。若 standingsSource 不是 official，只能说明这是近期赛程推算，不能宣称锁定晋级或理论淘汰。分析晋级形势时必须同时考虑赛制 rules、官方排名、小分/局分和加赛规则；不确定时明确说明以官方公告为准。用中文，结论明确，适合网页展示。"
        },
        {
          role: "user",
          content: `结构化数据：${context}\n\n任务：${prompt}`
        }
      ]
    })
  });
  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status}`);
  }
  const json = await response.json();
  return json.choices?.[0]?.message?.content || null;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/tournaments") {
    const data = await getTournamentData({ refresh: url.searchParams.get("refresh") === "1" });
    sendJson(res, 200, data);
    return;
  }

  if (url.pathname === "/api/analyze") {
    const data = await getTournamentData({ refresh: url.searchParams.get("refresh") === "1" });
    const tournament = getTournamentFromData(data, url.searchParams.get("tournament"));
    const analysis = localAnalysis(tournament);
    const provider = url.searchParams.get("provider") || "local";
    if (provider !== "local") {
      try {
        const llm = await callLlm(provider, "请输出晋级形势摘要、关键比赛、每个梯队的风险判断。若不是官方积分榜，必须避免使用锁定晋级、理论淘汰等确定性措辞。", compactContext(tournament, analysis));
        if (llm) analysis.summary = llm;
      } catch (error) {
        analysis.llmError = error.message;
      }
    }
    sendJson(res, 200, { tournament, analysis, meta: data.meta, updatedAt: new Date().toISOString() });
    return;
  }

  if (url.pathname === "/api/chat" && req.method === "POST") {
    const body = await readBody(req);
    const data = await getTournamentData();
    const tournament = getTournamentFromData(data, body.tournamentId);
    const analysis = localAnalysis(tournament, body.scenario || {});
    const provider = body.provider || "local";
    let answer = answerLocally(body.question || "", tournament, analysis);
    if (provider !== "local") {
      try {
        const llm = await callLlm(provider, `用户问题：${body.question}\n请直接回答，并指出依据。`, compactContext(tournament, analysis));
        if (llm) answer = llm;
      } catch (error) {
        answer += `\n\n模型接口暂不可用，已使用本地规则引擎回答。错误：${error.message}`;
      }
    }
    sendJson(res, 200, { answer, analysis, meta: data.meta });
    return;
  }

  if (url.pathname === "/api/scenario" && req.method === "POST") {
    const body = await readBody(req);
    const data = await getTournamentData();
    const tournament = getTournamentFromData(data, body.tournamentId);
    const analysis = localAnalysis(tournament, body.scenario || {});
    sendJson(res, 200, { tournament, analysis, meta: data.meta, updatedAt: new Date().toISOString() });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function answerLocally(question, tournament, analysis) {
  const q = question.toLowerCase();
  const teams = analysis.teams;
  const mentioned = teams.find((team) => q.includes(team.name.toLowerCase()) || q.includes(team.id.toLowerCase()));
  if (mentioned) {
    const next = tournament.matches.find((match) => match.status !== "finished" && match.teams.includes(mentioned.id));
    const nextText = next ? `下一场是 ${new Date(next.startsAt).toLocaleString("zh-CN", { hour12: false })} 对阵 ${next.teams.map((id) => tournament.teams.find((team) => team.id === id).name).join(" vs ")}。` : "当前没有剩余赛程。";
    return `${mentioned.name} 当前排名第 ${mentioned.rank}，战绩 ${mentioned.wins}-${mentioned.losses}，小分 ${mentioned.differential >= 0 ? "+" : ""}${mentioned.differential}，状态为「${mentioned.status}」。${mentioned.note}${nextText}`;
  }
  if (q.includes("关键") || q.includes("值得看") || q.includes("焦点")) {
    const focus = analysis.keyMatches[0];
    return focus ? `最值得看的是 ${focus.left} vs ${focus.right}。重要性：${focus.importance}。${focus.reason}` : "目前没有未结束比赛，暂时没有新的焦点战。";
  }
  if (q.includes("晋级") || q.includes("形势") || q.includes("排名")) {
    return analysis.summary;
  }
  return `我已读取 ${tournament.name} 的赛程、积分和晋级规则。你可以问某支队伍的晋级条件、今晚哪场最关键，或者“如果某队赢了会怎样”。\n\n${analysis.summary}`;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const type = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
    } else {
      serveStatic(req, res);
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Esports AI Schedule app running at http://localhost:${PORT}`);
});
