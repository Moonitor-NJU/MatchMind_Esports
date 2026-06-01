const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "tournaments.json");
const RULES_FILE = path.join(ROOT, "data", "rules.json");
const ENV_FILE = path.join(ROOT, ".env");

loadEnvFile();

const LIVE_CACHE_TTL_MS = Number(process.env.LIVE_CACHE_TTL_MS || 5 * 60 * 1000);
const NEWS_CACHE_TTL_MS = Number(process.env.NEWS_CACHE_TTL_MS || 15 * 60 * 1000);
let newsCache = null;

const TEAM_AUDIENCE_BASELINES = {
  T1: { heat: 100, aliases: ["t1", "faker"] },
  GEN: { heat: 92, aliases: ["gen", "geng", "gen.g", "generation gaming"] },
  HLE: { heat: 78, aliases: ["hle", "hanwha"] },
  DK: { heat: 76, aliases: ["dk", "dplus", "damwon"] },
  KT: { heat: 72, aliases: ["kt", "kt rolster"] },
  BRO: { heat: 48, aliases: ["bro", "brion"] },
  BLG: { heat: 96, aliases: ["blg", "bilibili gaming", "bin", "knight"] },
  TES: { heat: 92, aliases: ["tes", "top esports", "jackeylove", "369"] },
  JDG: { heat: 86, aliases: ["jdg", "jd gaming", "ruler"] },
  EDG: { heat: 88, aliases: ["edg", "edward gaming"] },
  IG: { heat: 82, aliases: ["ig", "invictus gaming"] },
  WBG: { heat: 84, aliases: ["wbg", "weibo gaming", "the shy", "theshy"] },
  AL: { heat: 64, aliases: ["al", "anyone's legend", "anyone legend"] },
  TT: { heat: 58, aliases: ["tt", "thundertalk"] },
  LGD: { heat: 56, aliases: ["lgd"] },
  WE: { heat: 70, aliases: ["we", "team we"] },
  NIP: { heat: 60, aliases: ["nip", "ninjas in pyjamas"] },
  G2: { heat: 94, aliases: ["g2", "g2 esports", "caps"] },
  FNC: { heat: 88, aliases: ["fnc", "fnatic"] },
  KC: { heat: 86, aliases: ["kc", "karmine corp"] },
  MKOI: { heat: 72, aliases: ["mkoi", "koi", "movistar koi"] },
  VIT: { heat: 76, aliases: ["vit", "vitality", "team vitality"] },
  GX: { heat: 52, aliases: ["gx", "giantx"] },
  C9: { heat: 86, aliases: ["c9", "cloud9"] },
  TL: { heat: 84, aliases: ["tl", "team liquid"] },
  FLY: { heat: 74, aliases: ["fly", "flyquest"] },
  "100T": { heat: 70, aliases: ["100t", "100 thieves"] },
  PSG: { heat: 78, aliases: ["psg", "psg talon"] },
  CFO: { heat: 62, aliases: ["cfo", "ctbc flying oyster"] },
  GAM: { heat: 70, aliases: ["gam", "gam esports"] }
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readRules() {
  try {
    return readJson(RULES_FILE);
  } catch (error) {
    return { profiles: [] };
  }
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
  await enrichWithPandaTournamentMatches(tournaments, baseUrl, token, game);
  await enrichWithPandaStandings(tournaments, baseUrl, token);
  finalizeTournamentData(tournaments);
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

async function enrichWithPandaTournamentMatches(tournaments, baseUrl, token, game) {
  await Promise.all(tournaments
    .filter((tournament) => tournament.rules?.phase === "playoffs")
    .map(async (tournament) => {
      const tournamentId = tournament.externalIds?.pandascoreTournamentId;
      if (!tournamentId) return;
      try {
        const endpoint = new URL(`/tournaments/${tournamentId}/matches`, baseUrl);
        endpoint.searchParams.set("sort", "begin_at");
        endpoint.searchParams.set("per_page", "100");
        const response = await fetch(endpoint, {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`
          }
        });
        if (!response.ok) {
          tournament.bracketWarning = `完整签表接口返回 ${response.status}`;
          return;
        }
        const matches = await response.json();
        mergePandaMatchesIntoTournament(tournament, matches, game);
      } catch (error) {
        tournament.bracketWarning = `完整签表暂不可用：${error.message}`;
      }
    }));
}

function mergePandaMatchesIntoTournament(tournament, rawMatches, game) {
  const colors = ["#0f9f87", "#2563eb", "#e8475b", "#d97706", "#7c3aed", "#111827", "#0891b2", "#db2777"];
  const teamMapById = new Map(tournament.teams.map((team) => [team.id, team]));
  const matchMap = new Map(tournament.matches.map((match) => [match.id, match]));
  for (const raw of Array.isArray(rawMatches) ? rawMatches : []) {
    const descriptor = pandaCompetitionDescriptor(raw, game);
    if (descriptor.id !== tournament.id) continue;
    const opponents = Array.isArray(raw.opponents) ? raw.opponents.slice(0, 2) : [];
    if (opponents.length < 2) continue;
    const left = normalizePandaTeam(opponents[0].opponent, teamMapById, colors);
    const right = normalizePandaTeam(opponents[1].opponent, teamMapById, colors);
    if (!left || !right) continue;
    const result = normalizePandaResult(raw, left.pandaId, right.pandaId);
    matchMap.set(`ps-${raw.id}`, {
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
  tournament.teams = Array.from(teamMapById.values());
  tournament.matches = Array.from(matchMap.values()).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function pandaMatchEndpoints(baseUrl, game, limit, from, to) {
  const configured = csv(process.env.PANDASCORE_LEAGUE_IDS);
  const defaultFocus = (process.env.PANDASCORE_FOCUS || "cn-major").toLowerCase() === "all"
    ? []
    : csv(process.env.PANDASCORE_DEFAULT_LEAGUE_IDS || "294,293,4197,5262,4198,5351");
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
        mergeStandingTeamsIntoTournament(tournament, official);
      } else {
        tournament.standingsWarning = "官方积分榜暂未返回可识别排名字段";
      }
    } catch (error) {
      tournament.standingsWarning = `官方积分榜暂不可用：${error.message}`;
    }
  }));
}

function mergeStandingTeamsIntoTournament(tournament, standings) {
  const existing = new Map(tournament.teams.map((team) => [team.id, team]));
  const colors = ["#0f9f87", "#2563eb", "#e8475b", "#d97706", "#7c3aed", "#111827", "#0891b2", "#db2777"];
  for (const row of standings) {
    if (existing.has(row.id)) continue;
    existing.set(row.id, {
      id: row.id,
      name: row.name,
      region: row.region || "Global",
      color: colors[existing.size % colors.length]
    });
  }
  tournament.teams = Array.from(existing.values());
}

function finalizeTournamentData(tournaments) {
  for (const tournament of tournaments) {
    if (tournament.officialStandings) {
      tournament.officialStandings = tournament.officialStandings.map((row) => ({
        ...row,
        remaining: upcomingMatchesForTeam(tournament, row.name).length
      }));
    }
    if (tournament.rules?.phase === "playoffs") {
      const matchTeams = new Set(tournament.matches.flatMap((match) => match.teams));
      tournament.waitingTeams = tournament.teams
        .filter((team) => !matchTeams.has(team.id))
        .map((team) => team.name);
      if (tournament.waitingTeams.length) {
        const warning = `当前 PandaScore 比赛窗口未包含 ${tournament.waitingTeams.join("、")} 的具体对阵，可能是已在更高轮次等待或完整签表尚未返回。`;
        tournament.bracketWarning = tournament.bracketWarning ? `${tournament.bracketWarning}；${warning}` : warning;
      }
    }
  }
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
  const profile = competitionProfile(descriptor);
  if (profile) {
    return materializeRules(profile.rules, teamCount, profile.id);
  }
  return fallbackCompetitionRules(descriptor, teamCount);
}

function competitionProfile(descriptor) {
  const text = {
    league: String(descriptor.league || "").toLowerCase(),
    serie: String(descriptor.serie || "").toLowerCase(),
    stage: String(descriptor.stage || "").toLowerCase(),
    all: `${descriptor.league} ${descriptor.serie} ${descriptor.stage}`.toLowerCase()
  };
  return readRules().profiles.find((profile) => profileMatches(profile, text)) || null;
}

function profileMatches(profile, text) {
  const match = profile.match || {};
  return ["league", "serie", "stage"].every((field) => {
    const values = match[field];
    if (!values || !values.length) return true;
    return values.some((value) => text[field].includes(String(value).toLowerCase()));
  });
}

function materializeRules(rules, teamCount, profileId) {
  const copy = JSON.parse(JSON.stringify(rules || {}));
  if (copy.playInSlots === "all") copy.playInSlots = teamCount;
  copy.profileId = profileId;
  return copy;
}

function focusConfig(tournament) {
  const profileId = tournament.rules?.profileId;
  return readRules().profiles.find((profile) => profile.id === profileId)?.focus || {};
}

function fallbackCompetitionRules(descriptor, teamCount) {
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
  if (text.includes("lec") && text.includes("playoff")) {
    return {
      format: "LEC Spring 季后赛败者组 BO5",
      phase: "playoffs",
      advanceSlots: 0,
      eliminationSlots: 0,
      labels: {
        lower: "败者组淘汰线",
        final: "后续签表"
      },
      tiebreakers: ["败者组 BO5", "胜者晋级下一轮", "败者淘汰", "官方签表更新"]
    };
  }
  if (text.includes("road to msi")) {
    return {
      format: `${descriptor.league} Road to MSI 资格赛路径`,
      phase: "playoffs",
      advanceSlots: 0,
      eliminationSlots: 0,
      labels: {
        final: "MSI 资格路径",
        watch: "待战队伍"
      },
      tiebreakers: ["资格赛签表", "BO5 胜负关系", "官方晋级规则"]
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
    "lcs",
    "league championship series",
    "lcp",
    "league of legends championship pacific",
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
  if (tournament.rules?.phase === "playoffs") {
    return playoffKeyMatchesFromView(buildPlayoffView(tournament));
  }
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

function playoffKeyMatchesFromView(phaseView) {
  return (phaseView.cards || [])
    .filter((card) => card.status !== "finished")
    .map((card) => {
      const highStake = card.stake?.headline || card.bracket === "败者组" || card.bracket === "决赛";
      return {
        id: card.id,
        startsAt: card.startsAt,
        left: card.left,
        right: card.right,
        importance: highStake ? "高" : "中",
        tag: card.stake?.chips?.[0] || (card.bracket === "败者组" ? "败者组生死战" : `${card.bracket}路径战`),
        reason: card.stake?.body || card.impact || "这场会改变后续签表路径。"
      };
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function localAnalysis(tournament, scenario = {}) {
  const standings = buildStandings(tournament, scenario);
  const teams = qualificationStatus(tournament, standings);
  const phaseView = buildPhaseView(tournament, teams);
  const matches = phaseView.type === "playoffs" ? playoffKeyMatchesFromView(phaseView) : keyMatches(tournament, standings);
  const focusStories = buildFocusStories(tournament, teams, phaseView);
  if (phaseView.type === "playoffs") {
    const focus = matches[0];
    const completed = phaseView.completedCount || 0;
    const upcoming = phaseView.upcomingCount || 0;
    const summary = [
      `${tournament.name}。${focusStories[0]?.headline || "当前重点应看胜败者组路径，而不是积分榜。 "}`.trim(),
      `本阶段是${tournament.rules?.format || "淘汰赛签表"}：已完成 ${completed} 场，待赛 ${upcoming} 场。季后赛 0-0 只代表该签表节点未开赛，不能当作常规赛战绩或官方排名来解读。`,
      focus ? `下一场重点关注 ${focus.left} vs ${focus.right}，${focus.reason}` : "当前接口窗口内没有待赛场次，后续需要等待官方签表更新。",
      "涉及晋级、淘汰、败者组和国际赛名额时，以当前签表、已结束比分和官方规则为准。"
    ].join("\n");
    return { standings: [], teams: [], keyMatches: matches, focusStories, phaseView, summary };
  }
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
    const card = {
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
      loser
    };
    const stake = playoffStakeForCard(tournament, card);
    if (stake) {
      card.stake = stake;
    }
    return card;
  });
  for (const card of cards) {
    card.outcome = buildPlayoffOutcome(tournament, card, cards);
    card.impact = card.stake?.cardImpact || card.stake?.body || card.outcome.summary;
  }
  return {
    type: "playoffs",
    title: "季后赛晋级形势",
    subtitle: tournament.rules?.format || "淘汰赛签表",
    completedCount: finished.length,
    upcomingCount: upcoming.length,
    waitingTeams: tournament.waitingTeams || [],
    warning: tournament.bracketWarning || null,
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

function buildPlayoffOutcome(tournament, card, cards) {
  const rule = playoffOutcomeRule(tournament, card.bracket);
  const winnerNext = card.winner ? nextCardForTeam(cards, card.winner, card.startsAt) : null;
  const loserNext = card.loser ? nextCardForTeam(cards, card.loser, card.startsAt) : null;
  const summary = card.winner
    ? describeResolvedPlayoffOutcome(card, rule, winnerNext, loserNext)
    : describeUpcomingPlayoffOutcome(card, rule);
  return {
    mode: rule.mode,
    source: rule.source,
    winnerPath: rule.winnerPath,
    loserPath: rule.loserPath,
    winnerNext: compactNextCard(winnerNext),
    loserNext: compactNextCard(loserNext),
    summary
  };
}

function playoffOutcomeRule(tournament, bracket) {
  const config = focusConfig(tournament);
  const mode = config.playoffMode || inferPlayoffMode(tournament);
  const source = config.playoffMode ? "项目赛制配置" : "赛制名称推断";
  if (mode === "double_elimination") {
    if (bracket === "胜者组") {
      return {
        mode,
        source,
        winnerPath: "保留胜者组路径，继续争夺更短晋级路线",
        loserPath: "转入败者组，后续容错降低"
      };
    }
    if (bracket === "败者组") {
      return {
        mode,
        source,
        winnerPath: "留在败者组继续晋级",
        loserPath: "被淘汰或结束本阶段赛程"
      };
    }
    if (bracket === "决赛") {
      return {
        mode,
        source,
        winnerPath: "赢下本阶段决赛或进入最终资格位置",
        loserPath: "失去本轮争冠/资格主动权"
      };
    }
  }
  if (mode === "partial_lower_bracket") {
    if (bracket === "败者组") {
      return {
        mode,
        source,
        winnerPath: "从败者组继续向决赛路径推进",
        loserPath: "被淘汰或结束本阶段赛程"
      };
    }
    return {
      mode,
      source,
      winnerPath: "进入后续胜者/决赛路径",
      loserPath: "掉入后续败者组或等待官方签表确认"
    };
  }
  if (mode === "qualification_path") {
    return {
      mode,
      source,
      winnerPath: "继续保留资格赛主动权",
      loserPath: "资格压力显著增加，具体落点以官方签表为准"
    };
  }
  return {
    mode,
    source,
    winnerPath: "进入下一轮或保留后续资格",
    loserPath: "后续落点需要等待官方签表确认"
  };
}

function inferPlayoffMode(tournament) {
  const text = `${tournament.rules?.format || ""} ${tournament.name || ""}`.toLowerCase();
  if (text.includes("双败") || text.includes("double")) return "double_elimination";
  if (text.includes("败者组")) return "partial_lower_bracket";
  if (text.includes("资格") || text.includes("msi")) return "qualification_path";
  return "single_or_unknown";
}

function nextCardForTeam(cards, team, startsAt) {
  const start = Date.parse(startsAt || 0);
  return (cards || [])
    .filter((card) => card.startsAt && Date.parse(card.startsAt) > start && [card.left, card.right].includes(team))
    .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))[0] || null;
}

function compactNextCard(card) {
  if (!card) return null;
  return {
    id: card.id,
    startsAt: card.startsAt,
    bracket: card.bracket,
    left: card.left,
    right: card.right,
    status: card.status,
    score: card.score,
    bestOf: card.bestOf
  };
}

function describeResolvedPlayoffOutcome(card, rule, winnerNext, loserNext) {
  const winnerNextText = winnerNext
    ? `${card.winner} 下一站是 ${winnerNext.bracket} ${winnerNext.left} vs ${winnerNext.right}`
    : `${card.winner} 的下一站当前接口未给出明确占位`;
  const loserNextText = loserNext
    ? `${card.loser} 下一站是 ${loserNext.bracket} ${loserNext.left} vs ${loserNext.right}`
    : `${card.loser} 的后续落点当前接口未给出明确占位`;
  return `按${rule.source}，${card.winner} ${rule.winnerPath}，${card.loser} ${rule.loserPath}。${winnerNextText}；${loserNextText}。`;
}

function describeUpcomingPlayoffOutcome(card, rule) {
  return `按${rule.source}，这场 ${card.bracket} BO${card.bestOf} 的胜者将${rule.winnerPath}，败者将${rule.loserPath}；若官方签表尚未给出下一轮占位，具体对手会在赛后更新。`;
}

function playoffStakeForCard(tournament, card) {
  const stakes = Array.isArray(tournament.rules?.stakes) ? tournament.rules.stakes : [];
  const roundText = `${card.round || ""} ${card.bracket || ""}`.toLowerCase();
  for (const stake of stakes) {
    if (stake.status && stake.status !== card.status) continue;
    const roundIncludes = Array.isArray(stake.roundIncludes) ? stake.roundIncludes : [];
    if (roundIncludes.length && !roundIncludes.some((item) => roundText.includes(String(item).toLowerCase()))) continue;
    if (!card.winner && (stake.headline || stake.body || stake.cardImpact || "").includes("{winner}")) continue;
    return {
      id: stake.id,
      headline: applyStakeTemplate(stake.headline, card),
      body: applyStakeTemplate(stake.body, card),
      cardImpact: applyStakeTemplate(stake.cardImpact, card),
      chips: Array.isArray(stake.chips) ? stake.chips : []
    };
  }
  return null;
}

function applyStakeTemplate(template, card) {
  if (!template) return "";
  return String(template)
    .replaceAll("{winner}", card.winner || "胜者")
    .replaceAll("{loser}", card.loser || "败者")
    .replaceAll("{left}", card.left || "")
    .replaceAll("{right}", card.right || "")
    .replaceAll("{score}", card.score || "");
}

function teamName(tournament, id) {
  return tournament.teams.find((team) => team.id === id)?.name || id;
}

function buildFocusStories(tournament, teams, phaseView) {
  const candidates = detectFocusCandidates(tournament, teams, phaseView)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates.slice(0, 2).map(({ score, order, ...story }) => story);
}

function enrichAnalysisWithAudienceFocus(tournament, analysis, newsItems = []) {
  const audience = buildAudienceFocusCandidates(tournament, analysis, newsItems);
  if (!audience.length) return analysis;
  const existing = Array.isArray(analysis.focusStories) ? analysis.focusStories : [];
  const merged = [...audience, ...existing]
    .filter(uniqueFocusStory)
    .slice(0, 2)
    .map(({ score, ...story }) => story);
  analysis.focusStories = merged;
  analysis.audienceSignals = audience.map(({ score, ...story }) => story);
  analysis.summary = [
    `${tournament.name}。${merged[0]?.headline || firstSummaryLine(analysis.summary)}`,
    ...String(analysis.summary || "").split("\n").filter(Boolean).slice(1)
  ].join("\n");
  return analysis;
}

function uniqueFocusStory(story, index, list) {
  const key = String(story.headline || "").toLowerCase();
  return key && list.findIndex((item) => String(item.headline || "").toLowerCase() === key) === index;
}

function firstSummaryLine(text) {
  return String(text || "").split("\n").filter(Boolean)[0] || "当前焦点随赛程和讨论热度变化。";
}

function buildAudienceFocusCandidates(tournament, analysis, newsItems) {
  const phase = analysis.phaseView;
  const buzz = buildBuzzIndex(newsItems, tournament);
  const candidates = [];
  const matches = phase?.type === "playoffs"
    ? phase.cards.filter((card) => card.status !== "finished")
    : tournament.matches.filter((match) => match.status !== "finished").map((match) => {
      const left = teamName(tournament, match.teams[0]);
      const right = teamName(tournament, match.teams[1]);
      return {
        id: match.id,
        startsAt: match.startsAt,
        round: match.round,
        bracket: "常规赛",
        status: match.status,
        bestOf: match.bestOf,
        left,
        right,
        score: "未赛",
        impact: keyMatches(tournament, analysis.standings).find((item) => item.id === match.id)?.reason || "这场会影响后续排名和观赛热度。"
      };
    });

  for (const match of matches) {
    const leftBuzz = buzz.get(match.left) || { count: 0, headlines: [] };
    const rightBuzz = buzz.get(match.right) || { count: 0, headlines: [] };
    const leftProfile = dynamicAudienceProfile(match.left, match, analysis, leftBuzz);
    const rightProfile = dynamicAudienceProfile(match.right, match, analysis, rightBuzz);
    const heatScore = leftProfile.heat + rightProfile.heat;
    const buzzScore = (leftBuzz.count + rightBuzz.count) * 18;
    const stakesScore = match.bracket === "败者组" ? 30 : match.bracket === "胜者组" ? 16 : 8;
    const timeScore = upcomingTimeScore(match.startsAt);
    const score = heatScore + buzzScore + stakesScore + timeScore;
    const rivalry = sharedAudienceTags(leftProfile, rightProfile);
    const headline = audienceHeadline(match, leftProfile, rightProfile, leftBuzz, rightBuzz, rivalry);
    const body = audienceBody(match, leftProfile, rightProfile, leftBuzz, rightBuzz, rivalry);
    candidates.push({
      score,
      tone: score >= 200 || match.bracket === "败者组" ? "hot" : "watch",
      headline,
      body,
      chips: audienceChips(match, leftProfile, rightProfile, leftBuzz, rightBuzz)
    });
  }

  const finishedStake = phase?.type === "playoffs"
    ? phase.cards.filter((card) => card.status === "finished" && (card.stake || highProfileUpset(card))).map((card) => finishedAudienceStory(card, buzz))
    : [];
  return [...finishedStake, ...candidates]
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

function buildBuzzIndex(newsItems, tournament) {
  const names = new Set(tournament.teams.map((team) => team.name));
  const index = new Map(Array.from(names).map((name) => [name, { count: 0, headlines: [] }]));
  for (const item of newsItems || []) {
    const text = `${item.title || ""} ${item.description || ""}`.toLowerCase();
    for (const name of names) {
      if (!teamMentionedInText(name, text)) continue;
      const current = index.get(name) || { count: 0, headlines: [] };
      current.count += recencyWeight(item.publishedAt);
      if (item.title && current.headlines.length < 2) current.headlines.push(item.title);
      index.set(name, current);
    }
  }
  return index;
}

function teamMentionedInText(team, text) {
  const profile = audienceProfile(team);
  return [team, ...(profile.aliases || [])].some((alias) => keywordMatches(text, alias));
}

function audienceProfile(team) {
  const direct = TEAM_AUDIENCE_BASELINES[team];
  if (direct) return { ...direct, tags: [] };
  const upper = String(team || "").toUpperCase();
  const upperProfile = TEAM_AUDIENCE_BASELINES[upper];
  if (upperProfile) return { ...upperProfile, tags: [] };
  return {
    heat: 42,
    aliases: [String(team || "").toLowerCase()],
    tags: []
  };
}

function dynamicAudienceProfile(team, match, analysis, buzz = { count: 0 }) {
  const base = audienceProfile(team);
  const tags = new Set();
  const heatBoosts = [];
  if (base.heat >= 92) tags.add("顶级关注队");
  else if (base.heat >= 82) tags.add("高关注队");
  else if (base.heat >= 68) tags.add("稳定粉丝盘");
  if (buzz.count >= 3) {
    tags.add("近期标题热队");
    heatBoosts.push(12);
  } else if (buzz.count > 0) {
    tags.add("新闻有声量");
    heatBoosts.push(6);
  }
  if (match.bracket === "败者组") tags.add("生死线压力");
  if (match.bracket === "胜者组") tags.add("主动权战");
  const trajectory = currentTrajectoryTag(team, analysis.phaseView);
  if (trajectory) {
    tags.add(trajectory.tag);
    heatBoosts.push(trajectory.heat);
  }
  if (!tags.size) tags.add("赛区变量");
  return {
    ...base,
    heat: base.heat + heatBoosts.reduce((sum, item) => sum + item, 0),
    tags: Array.from(tags)
  };
}

function currentTrajectoryTag(team, phaseView) {
  if (phaseView?.type !== "playoffs") return null;
  const finished = (phaseView.cards || [])
    .filter((card) => card.status === "finished" && (card.winner === team || card.loser === team))
    .sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)));
  const latest = finished[0];
  if (!latest) return null;
  if (latest.winner === team) {
    const winnerBase = audienceProfile(latest.winner).heat;
    const loserBase = audienceProfile(latest.loser).heat;
    if (loserBase - winnerBase >= 25) return { tag: "刚爆冷高热队", heat: 20 };
    if (latest.bracket === "败者组") return { tag: "败者组续命", heat: 10 };
    return { tag: "胜者组推进", heat: 8 };
  }
  if (latest.loser === team && latest.bracket === "胜者组") return { tag: "刚掉入败者组", heat: 8 };
  if (latest.loser === team) return { tag: "淘汰边缘", heat: 6 };
  return null;
}

function recencyWeight(value) {
  const ageDays = Math.max(0, (Date.now() - Date.parse(value || new Date())) / 86_400_000);
  if (ageDays < 2) return 3;
  if (ageDays < 7) return 2;
  return 1;
}

function upcomingTimeScore(value) {
  const hours = (Date.parse(value || new Date()) - Date.now()) / 3_600_000;
  if (hours < 0) return 0;
  if (hours <= 24) return 18;
  if (hours <= 72) return 10;
  return 4;
}

function sharedAudienceTags(left, right) {
  const tags = [...left.tags, ...right.tags];
  const flowCount = [left, right].filter((profile) =>
    profile.heat >= 78 || profile.tags.some((tag) => tag.includes("流量"))
  ).length;
  if (flowCount >= 2) return "流量对撞";
  if (tags.some((tag) => tag.includes("爆冷")) && tags.some((tag) => tag.includes("强队") || tag.includes("热门"))) return "下克上";
  if (tags.some((tag) => tag.includes("老牌") || tag.includes("情怀"))) return "情怀盘";
  return "";
}

function audienceHeadline(match, leftProfile, rightProfile, leftBuzz, rightBuzz, rivalry) {
  const hotter = leftProfile.heat >= rightProfile.heat ? match.left : match.right;
  const lower = leftProfile.heat >= rightProfile.heat ? match.right : match.left;
  const leftUpset = hasAudienceTag(leftProfile, "刚爆冷");
  const rightUpset = hasAudienceTag(rightProfile, "刚爆冷");
  if (leftBuzz.count + rightBuzz.count >= 3) return `${match.left} vs ${match.right} 是当前讨论度最高的观赛入口。`;
  if (leftUpset && rightUpset) return `${match.left} vs ${match.right} 是两条爆冷线索的正面碰撞。`;
  if (leftUpset || rightUpset) return `${leftUpset ? match.left : match.right} 刚掀翻高热队，下一场成色最值得验。`;
  if (match.bracket === "败者组") {
    if (rivalry === "下克上") return `${lower} 想把 ${hotter} 拖进真正的爆冷局。`;
    return `${hotter} 的流量和 ${lower} 的生死线撞在一起。`;
  }
  if (match.bracket === "淘汰赛") return `${match.left} vs ${match.right} 是资格路径里最有声量的一组对话。`;
  if (match.bracket === "胜者组") {
    if (rivalry === "情怀盘") return `${match.left} vs ${match.right} 是黑马势头和老牌情怀的正面对话。`;
    return `${match.left} vs ${match.right} 不只是晋级战，也是话题队的主动权之争。`;
  }
  return `${match.left} vs ${match.right} 是近期最有观众缘的卡位战。`;
}

function audienceBody(match, leftProfile, rightProfile, leftBuzz, rightBuzz, rivalry) {
  const buzzLine = buzzSummary(match.left, leftBuzz, match.right, rightBuzz);
  const identity = `${match.left} 带着「${displayAudienceTags(leftProfile).join("、")}」标签，${match.right} 的看点是「${displayAudienceTags(rightProfile).join("、")}」。`;
  const stakes = match.bracket === "败者组"
    ? (match.outcome?.summary || "这是败者组高压 BO，具体淘汰/晋级落点以当前规则和官方签表为准。")
    : match.bracket === "胜者组"
      ? (match.outcome?.summary || "这是胜者组路径战，胜负会改变后续签表位置。")
      : match.bracket === "淘汰赛"
        ? "这类资格赛不应按 0-0 积分榜理解，真正看点是谁能先在 BO5 路径里拿到晋级主动权。"
        : "这场会影响排名主动权，适合结合赛前讨论和赛后风向观察。";
  return [identity, rivalry ? `叙事上属于${rivalry}。` : "", buzzLine, stakes].filter(Boolean).join("");
}

function displayAudienceTags(profile) {
  const priority = ["刚爆冷", "生死线", "主动权", "顶级关注", "高关注", "稳定粉丝", "新闻", "赛区变量"];
  return (profile.tags || [])
    .slice()
    .sort((a, b) => {
      const ai = priority.findIndex((item) => a.includes(item));
      const bi = priority.findIndex((item) => b.includes(item));
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    })
    .slice(0, 2);
}

function hasAudienceTag(profile, pattern) {
  return (profile.tags || []).some((tag) => tag.includes(pattern));
}

function buzzSummary(left, leftBuzz, right, rightBuzz) {
  const total = leftBuzz.count + rightBuzz.count;
  if (!total) return "热度主要来自粉丝盘、队伍标签和淘汰赛压力，而不是单纯的积分变化。";
  const sample = [...leftBuzz.headlines, ...rightBuzz.headlines][0];
  return `近期新闻/文章标题中 ${left}、${right} 合计命中约 ${total} 次${sample ? `，代表话题如「${sample}」` : ""}。`;
}

function audienceChips(match, leftProfile, rightProfile, leftBuzz, rightBuzz) {
  const chips = [];
  if (match.bracket) chips.push(match.bracket);
  if (leftBuzz.count + rightBuzz.count) chips.push("新闻热度");
  chips.push(...displayAudienceTags(leftProfile).slice(0, 1), ...displayAudienceTags(rightProfile).slice(0, 1));
  return Array.from(new Set(chips)).slice(0, 4);
}

function highProfileUpset(card) {
  if (!card.winner || !card.loser) return false;
  return audienceProfile(card.loser).heat - audienceProfile(card.winner).heat >= 22;
}

function finishedAudienceStory(card, buzz) {
  const winnerProfile = audienceProfile(card.winner);
  const loserProfile = audienceProfile(card.loser);
  const buzzCount = (buzz.get(card.winner)?.count || 0) + (buzz.get(card.loser)?.count || 0);
  const upset = loserProfile.heat - winnerProfile.heat >= 22;
  const score = 110 + buzzCount * 18 + (card.stake ? 40 : 0) + (upset ? 25 : 0);
  return {
    score,
    tone: "hot",
    headline: card.stake?.headline || `${card.winner} 把 ${card.loser} 的流量局打成转折点。`,
    body: card.stake?.body || `${card.left} ${card.score} ${card.right}。这场的价值不只在赛果：${card.winner} 延续路径，${card.loser} 的高关注度会把后续败者组或淘汰压力继续放大。`,
    chips: card.stake?.chips?.length ? card.stake.chips : ["赛后热议", upset ? "爆冷线索" : "流量局"]
  };
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
  const config = focusConfig(tournament);
  const upcoming = phaseView.cards.filter((card) => card.status !== "finished");
  const finished = phaseView.cards.filter((card) => card.winner);
  const stakeCards = phaseView.cards.filter((card) => card.stake?.headline);
  const lowerNext = upcoming.find((card) => card.bracket === "败者组");
  const upperNext = upcoming.find((card) => card.bracket === "胜者组");
  const next = upcoming[0];
  const lowerTeams = new Set([
    ...finished.filter((card) => card.bracket === "胜者组").map((card) => card.loser),
    ...upcoming.filter((card) => card.bracket === "败者组").flatMap((card) => [card.left, card.right])
  ].filter(Boolean));
  const allowUnderdog = !config.avoid?.includes("underdog_path_without_seed") || hasSeedSignal(phaseView);
  const upsetTeams = allowUnderdog && hasSeedSignal(phaseView) ? underdogSurvivors(tournament, phaseView, lowerTeams) : [];

  for (const card of stakeCards) {
    candidates.push({
      score: 120,
      tone: "hot",
      headline: card.stake.headline,
      body: card.stake.body || `${card.left} ${card.score} ${card.right}。${card.impact}`,
      chips: card.stake.chips?.length ? card.stake.chips : ["关键结果", "晋级权益"]
    });
  }

  if (lowerNext) {
    candidates.push({
      score: 96,
      tone: "hot",
      headline: `${lowerNext.left} vs ${lowerNext.right} 是下一场败者组生死战。`,
      body: `${lowerNext.outcome?.summary || lowerNext.impact} 当前签表已完成：${finishedSummary(finished) || "暂无明确晋级结果"}。`,
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
      body: upperNext.outcome?.summary || upperNext.impact,
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

function hasSeedSignal(phaseView) {
  return phaseView.cards.some((card) => card.bracket === "胜者组") &&
    phaseView.cards.length >= 4;
}

function finishedSummary(finished) {
  return finished.slice(0, 3)
    .map((card) => `${card.left} ${card.score} ${card.right}：${stripTrailingPunctuation(card.impact)}`)
    .join("；");
}

function stripTrailingPunctuation(value) {
  return String(value || "").replace(/[。；;,.，]+$/g, "");
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
  const config = focusConfig(tournament);
  const sorted = teams.slice().sort((a, b) => a.rank - b.rank);
  const advanceSlots = tournament.rules.advanceSlots || Math.min(6, Math.ceil(sorted.length / 2));
  const meaningful = standingsRaceIsMeaningful(tournament, sorted);
  const topCut = meaningful ? closeCutRace(sorted, tournament.rules.byeSlots || 2, tournament.rules.labels?.bye || "前二复活甲") : null;
  const playoffCut = meaningful ? closeCutRace(sorted, advanceSlots, tournament.rules.labels?.advance || "季后赛席位") : null;
  const nextDirect = nextDirectRankingMatch(tournament, sorted, advanceSlots);

  if (topCut && sorted.length >= 4 && shouldUseFocus(config, "bye_cut")) {
    const state = raceState(topCut);
    const scenario = cutRaceScenario(tournament, topCut, sorted, 2, state);
    candidates.push({
      score: state.open ? (topCut.gap <= 1 ? 94 : 76) : 58,
      tone: state.open ? "hot" : "watch",
      headline: state.open
        ? `${topCut.left.name}、${topCut.right.name} 正在争夺${topCut.label}。`
        : `${topCut.label}格局已基本定型：${topCut.left.name} 暂压 ${topCut.right.name}。`,
      body: scenario,
      chips: state.open ? ["前二竞争", "复活甲", "小分"] : ["席位定型", "等待官方确认", "小分"]
    });
  }

  if (playoffCut && playoffCut.slot !== 2 && shouldUseFocus(config, "advance_cut")) {
    const state = raceState(playoffCut);
    const scenario = cutRaceScenario(tournament, playoffCut, sorted, playoffCut.slot, state);
    candidates.push({
      score: state.open ? (playoffCut.gap <= 1 ? 88 : 70) : 56,
      tone: state.open ? "hot" : "watch",
      headline: state.open
        ? `${playoffCut.left.name} 与 ${playoffCut.right.name} 卡在${playoffCut.label}分界线。`
        : `${playoffCut.label}分界线暂时稳定，${playoffCut.left.name} 领先 ${playoffCut.right.name}。`,
      body: scenario,
      chips: state.open ? ["晋级线", "卡位战"] : ["席位观察", "官方排名"]
    });
  }

  if (nextDirect && shouldUseFocus(config, "direct_match")) {
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
      headline: meaningful ? `${tournament.name} 当前主要看官方积分榜稳定性。` : `${tournament.name} 当前刚进入新阶段，先看首轮对阵。`,
      body: meaningful
        ? `排名前列为 ${top.map((team) => `${team.name}(${team.wins}-${team.losses})`).join("、")}，后续焦点会随胜场差和剩余赛程自动切换。`
        : `目前各队战绩还没有拉开，系统不会把 0-0 排名误读成锁定席位或复活甲争夺；真正焦点应放在首轮对阵、赛制路径和队伍近期话题。`,
      chips: meaningful ? ["常规赛", "积分榜"] : ["新阶段", "首轮对阵"]
    });
  }
  return candidates;
}

function standingsRaceIsMeaningful(tournament, sorted) {
  if (focusConfig(tournament).avoid?.includes("standings_table")) return false;
  const finishedMatches = tournament.matches.filter((match) => match.status === "finished").length;
  const playedTeams = sorted.filter((team) => (team.wins || 0) + (team.losses || 0) > 0).length;
  if (!finishedMatches && !playedTeams) return false;
  if (playedTeams < Math.max(2, Math.ceil(sorted.length / 3))) return false;
  return true;
}

function shouldUseFocus(config, key) {
  if (!config.prefer || !config.prefer.length) return true;
  return config.prefer.includes(key);
}

function cutRaceScenario(tournament, race, sorted, slot, state = raceState(race)) {
  const contenders = nearbyContenders(sorted, slot);
  const direct = directMatchAmong(tournament, contenders, slot);
  const leader = race.left;
  const chaser = race.right;
  const scheduleTeams = state.open ? [leader, chaser] : [];
  const scheduleLines = uniqueTeams(scheduleTeams)
    .map((team) => teamScheduleLine(tournament, team))
    .filter(Boolean);
  const gapText = `${leader.name} 当前 ${leader.wins}-${leader.losses}，${chaser.name} 当前 ${chaser.wins}-${chaser.losses}，胜场差 ${race.gap}`;
  const scenarioLines = [];

  if (!state.open) {
    if (state.reason === "no_remaining") {
      scenarioLines.push(`${leader.name} 和 ${chaser.name} 当前窗口内都没有剩余比赛，胜场关系已经无法通过本窗口赛程改变；后续只需等待官方最终排名/小分确认。`);
    } else {
      scenarioLines.push(`${chaser.name} 即使拿满当前窗口剩余胜场，也很难追上 ${leader.name}，这条分界线已经从“争夺”转为“确认排序”。`);
    }
  } else if (race.gap === 0) {
    const leaderRemaining = leader.remaining || 0;
    const chaserRemaining = chaser.remaining || 0;
    if (leaderRemaining && !chaserRemaining) {
      scenarioLines.push(`${leader.name} 还有 ${leaderRemaining} 场，赢下下一场就能把同胜场压力甩给 ${chaser.name}；如果输球，排序仍会被小分/局分拖住。`);
    } else if (!leaderRemaining && chaserRemaining) {
      scenarioLines.push(`${chaser.name} 还有 ${chaserRemaining} 场，赢球就能追到同胜场甚至改变分界线主动权；输球则基本把位置让给 ${leader.name}。`);
    } else {
      scenarioLines.push(`${leader.name} 和 ${chaser.name} 同胜场，下一轮谁丢分都会把主动权让给对方；若都赢，排序大概率继续看小分/局分。`);
    }
  } else if (race.gap === 1) {
    if (!(leader.remaining || 0) && (chaser.remaining || 0)) {
      scenarioLines.push(`${chaser.name} 还有 ${chaser.remaining} 场，下一场赢球可以把差距追到同胜场，随后排序会看小分/局分；输球则很难再撼动 ${leader.name}。`);
    } else {
      scenarioLines.push(`${chaser.name} 需要自己赢球，同时等待 ${leader.name} 丢一场，才能把竞争重新拉回同胜场；如果 ${leader.name} 也赢，${chaser.name} 至少还要继续追小分。`);
    }
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

function uniqueTeams(teams) {
  const seen = new Set();
  return teams.filter((team) => {
    if (!team || seen.has(team.name)) return false;
    seen.add(team.name);
    return true;
  });
}

function raceState(race) {
  const leftRemaining = race.left.remaining || 0;
  const rightRemaining = race.right.remaining || 0;
  const chaserMaxWins = race.right.wins + rightRemaining;
  const leaderMinWins = race.left.wins;
  if (!leftRemaining && !rightRemaining) {
    return { open: false, reason: "no_remaining" };
  }
  if (chaserMaxWins < leaderMinWins) {
    return { open: false, reason: "cannot_catch" };
  }
  return { open: true, reason: "live" };
}

function nearbyContenders(sorted, slot) {
  if (slot === 2) return sorted.slice(0, Math.min(sorted.length, 3));
  const start = Math.max(0, slot - 2);
  const end = Math.min(sorted.length, slot + 1);
  return sorted.slice(start, end);
}

function teamScheduleLine(tournament, team) {
  const matches = upcomingMatchesForTeam(tournament, team.name).slice(0, 2);
  if (!matches.length) return null;
  return `${team.name} 接下来 ${matches.map((match) => `${formatShortDate(match.startsAt)} 对 ${opponentName(tournament, match, team.name)}`).join("、")}`;
}

function upcomingMatchesForTeam(tournament, team) {
  return tournament.matches
    .filter((match) => match.status !== "finished" && match.teams.some((id) => teamName(tournament, id) === team))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function directMatchAmong(tournament, teams, slot) {
  const names = new Set(teams.map((team) => team.name));
  const rankByName = new Map(teams.map((team) => [team.name, team.rank]));
  return tournament.matches
    .filter((match) => match.status !== "finished")
    .map((match) => {
      const left = teamName(tournament, match.teams[0]);
      const right = teamName(tournament, match.teams[1]);
      if (!names.has(left) || !names.has(right)) return null;
      const leftRank = rankByName.get(left);
      const rightRank = rankByName.get(right);
      const crossesCut = (leftRank <= slot && rightRank > slot) || (rightRank <= slot && leftRank > slot);
      const touchesCut = crossesCut && Math.max(leftRank, rightRank) <= slot + 1 && Math.min(leftRank, rightRank) >= Math.max(1, slot - 1);
      if (!touchesCut) return null;
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
      const crossesPlayoffCut = (left.rank <= advanceSlots && right.rank > advanceSlots) ||
        (right.rank <= advanceSlots && left.rank > advanceSlots);
      const crossesTopCut = (left.rank <= 2 && right.rank > 2) ||
        (right.rank <= 2 && left.rank > 2);
      const touchesPlayoffCut = crossesPlayoffCut && Math.max(left.rank, right.rank) <= advanceSlots + 1;
      const touchesTopCut = crossesTopCut && Math.max(left.rank, right.rank) <= 3;
      return { left, right, rankGap, cutPressure, bothNearPlayoff, bothNearTop, touchesPlayoffCut, touchesTopCut, startsAt: match.startsAt };
    })
    .filter(Boolean)
    .filter((item) => item.rankGap <= 3 && (item.touchesPlayoffCut || item.touchesTopCut || item.bothNearTop))
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

function compactContext(tournament, analysis, newsItems = []) {
  const isPlayoffs = analysis.phaseView?.type === "playoffs";
  return JSON.stringify({
    tournament: {
      name: tournament.name,
      game: tournament.game,
      stage: tournament.stage,
      rules: tournament.rules,
      standingsSource: tournament.standingsSource || "schedule-derived",
      standingsWarning: tournament.standingsWarning || null,
      bracketWarning: tournament.bracketWarning || null,
      waitingTeams: tournament.waitingTeams || [],
      contextGuardrail: isPlayoffs
        ? "当前为季后赛/淘汰赛。不要使用 standings、0-0 战绩、排名第几、小分来推断胜者组比赛；只基于 phaseView.cards、已结束比分、未赛 BO、胜败者组路径和规则回答。"
        : "当前为常规赛或积分赛，可以使用 standings/qualification 分析排名和晋级线。"
    },
    standings: isPlayoffs ? [] : analysis.standings,
    qualification: isPlayoffs ? [] : analysis.teams,
    focusStories: analysis.focusStories,
    audienceSignals: analysis.audienceSignals || [],
    webContext: {
      source: "项目抓取的 RSS/网页新闻源和页面新闻轮播，不等同于模型实时联网搜索。",
      relatedNews: relatedNewsForTournament(newsItems, tournament).slice(0, 8)
    },
    phaseView: analysis.phaseView,
    playoffTeamPaths: isPlayoffs ? buildPlayoffTeamPaths(analysis.phaseView) : [],
    keyMatches: analysis.keyMatches.slice(0, 5)
  });
}

function relatedNewsForTournament(newsItems, tournament) {
  const teamNames = new Set((tournament.teams || []).map((team) => team.name).filter(Boolean));
  const tournamentWords = String(tournament.name || "")
    .split(/[ ·:：,，\s]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 2);
  return (newsItems || []).filter((item) => {
    const text = `${item.title || ""} ${item.description || ""}`.toLowerCase();
    return [...teamNames].some((name) => text.includes(String(name).toLowerCase())) ||
      tournamentWords.some((word) => text.includes(word));
  }).map((item) => ({
    title: item.title,
    source: item.source,
    url: item.url,
    publishedAt: item.publishedAt
  }));
}

function buildPlayoffTeamPaths(phaseView) {
  const paths = new Map();
  for (const card of phaseView?.cards || []) {
    for (const side of ["left", "right"]) {
      const name = card[side];
      if (!name) continue;
      if (!paths.has(name)) paths.set(name, { team: name, played: [], upcoming: [] });
      const entry = paths.get(name);
      const opponent = side === "left" ? card.right : card.left;
      if (card.status === "finished") {
        const [leftScoreRaw, rightScoreRaw] = String(card.score || "").split(":").map((value) => Number(value));
        const ownScore = side === "left" ? leftScoreRaw : rightScoreRaw;
        const opponentScore = side === "left" ? rightScoreRaw : leftScoreRaw;
        entry.played.push({
          opponent,
          bracket: card.bracket,
          score: card.score,
          perspectiveScore: Number.isFinite(ownScore) && Number.isFinite(opponentScore) ? `${ownScore}:${opponentScore}` : card.score,
          result: card.winner === name ? "win" : "loss",
          impact: card.impact
        });
      } else {
        entry.upcoming.push({
          opponent,
          bracket: card.bracket,
          startsAt: card.startsAt,
          bestOf: card.bestOf,
          stake: card.stake || null,
          impact: card.impact
        });
      }
    }
  }
  return Array.from(paths.values());
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
          content: "你是面向中国观众的电竞赛事数据分析 Agent。必须基于给定结构化数据回答，不要编造未提供的赛果。若 contextGuardrail 标明当前是季后赛/淘汰赛，严禁把 0-0 当常规赛战绩，严禁说官方排名第几、小分、晋级线胜场差；必须改用 phaseView.cards、已结束比分、未赛 BO、胜败者组路径和 rules 分析。若 standingsSource 不是 official，只能说明这是近期赛程推算，不能宣称锁定晋级或理论淘汰。分析晋级形势时必须同时考虑赛制 rules、官方排名、小分/局分和加赛规则；不确定时明确说明以官方公告为准。用中文，结论明确，适合网页展示。"
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

async function enhanceAnalysisWithLlm(provider, tournament, analysis, newsItems = []) {
  const prompt = [
    "请基于结构化数据输出 JSON，不要输出 Markdown。",
    "JSON 格式：{\"summary\":\"两到四句中文摘要\",\"focusStories\":[{\"tone\":\"hot|watch\",\"headline\":\"一句焦点标题\",\"body\":\"两到三句，必须点明哪些比赛/赛果为什么重要\",\"chips\":[\"标签1\",\"标签2\"]}]}。",
    "优先识别 audienceSignals、rules.stakes、phaseView.cards[].stake、关键晋级权益、国际赛名额、胜败者组路径、还没打的直接影响比赛。",
    "焦点要兼顾观众体验：队伍名气、流量队、近期新闻标题讨论、爆冷/复仇/生死战叙事都要纳入，但不能脱离给定数据。",
    "如果 contextGuardrail 标明是季后赛，绝对不要用 0-0、官方排名、小分和晋级线胜场差做结论；这些字段在季后赛上下文中应视为无效。",
    "可使用 webContext.relatedNews 作为网页舆论参考；没有相关新闻时不要声称模型已全网搜索。",
    "不得编造结构化数据中不存在的赛果；如果规则只来自项目配置，请用“按当前规则配置/以官方公告为准”保持边界。"
  ].join("\n");
  const llm = await callLlm(provider, prompt, compactContext(tournament, analysis, newsItems));
  if (!llm) return false;
  const parsed = parseJsonFromLlm(llm);
  if (!parsed) {
    analysis.summary = llm;
    return true;
  }
  if (typeof parsed.summary === "string" && parsed.summary.trim()) {
    analysis.summary = parsed.summary.trim();
  }
  if (Array.isArray(parsed.focusStories)) {
    const focusStories = parsed.focusStories
      .map(normalizeLlmFocusStory)
      .filter(Boolean)
      .slice(0, 2);
    if (focusStories.length) analysis.focusStories = focusStories;
  }
  analysis.aiEnhanced = true;
  return true;
}

function buildChatPrompt(question) {
  return [
    `用户问题：${question}`,
    "请直接回答，但按中国电竞观众能看懂、愿意看完的赛前专栏风格组织。",
    "如果问题涉及黑马、预测、焦点或谁更值得看，先给明确结论，再分段说明：黑马/话题身份、双方当前路径、关键胜负手、可能翻盘条件、风险和不确定性。",
    "允许有标题感和营销号式表达，但证据必须来自结构化数据里的赛程、比分、签表、晋级权益、新闻标题和 audienceSignals；不要编造未提供的选手数据、赔率、历史交锋或赛果。",
    "如果 contextGuardrail 标明是季后赛，严禁用 0-0、排名第几、小分或积分榜话术；必须基于 phaseView.cards 和 playoffTeamPaths 回答。",
    "可以使用 webContext.relatedNews 作为网页舆论材料；如果没有相关新闻，不要假装已经全网搜索。",
    "如果结构化数据不足以支撑判断，要明确说缺哪类数据，并给出基于现有信息的保守判断。",
    "回答尽量具体到哪些比赛/哪场 BO5/哪支队伍的路径会改变，避免只说“主动权”“复活甲”“晋级形势”这种空话。"
  ].join("\n");
}

function buildPredictionContext(tournament, analysis, match, newsItems = []) {
  const teams = teamMap(tournament);
  const left = teams.get(match.teams[0]);
  const right = teams.get(match.teams[1]);
  const isPlayoffs = analysis.phaseView?.type === "playoffs";
  const standingsById = new Map((analysis.teams || []).map((team) => [team.id, team]));
  const phaseCard = analysis.phaseView?.type === "playoffs"
    ? (analysis.phaseView.cards || []).find((card) => card.id === match.id)
    : null;
  const playoffPaths = isPlayoffs ? buildPlayoffTeamPaths(analysis.phaseView) : [];
  const pathByTeam = new Map(playoffPaths.map((path) => [path.team, path]));
  const relatedNews = (newsItems || []).filter((item) => {
    const text = `${item.title || ""} ${item.description || ""}`.toLowerCase();
    return [left?.name, right?.name, tournament.name].some((name) => name && text.includes(name.toLowerCase()));
  }).slice(0, 8);
  return JSON.stringify({
    tournament: {
      name: tournament.name,
      game: tournament.game,
      stage: tournament.stage,
      rules: tournament.rules,
      standingsSource: tournament.standingsSource || "schedule-derived",
      contextGuardrail: isPlayoffs
        ? "季后赛预测：不要参考 0-0 战绩、官方排名或小分；只看签表路径、已赛 BO5、待赛 BO5、胜败者组权益和网页/新闻上下文。"
        : "常规赛预测：可以参考 standings、胜负场、小分和剩余赛程。"
    },
    match: {
      id: match.id,
      startsAt: match.startsAt,
      round: match.round,
      bestOf: match.bestOf,
      status: match.status,
      left: left?.name,
      right: right?.name,
      phaseImpact: phaseCard?.impact || null,
      stake: phaseCard?.stake || null
    },
    teams: {
      left: {
        profile: left,
        standing: isPlayoffs ? null : standingsById.get(match.teams[0]) || null,
        playoffPath: isPlayoffs ? pathByTeam.get(left?.name) || null : null,
        audience: audienceProfile(left?.name)
      },
      right: {
        profile: right,
        standing: isPlayoffs ? null : standingsById.get(match.teams[1]) || null,
        playoffPath: isPlayoffs ? pathByTeam.get(right?.name) || null : null,
        audience: audienceProfile(right?.name)
      }
    },
    focusStories: analysis.focusStories || [],
    audienceSignals: (analysis.audienceSignals || []).filter((signal) => {
      const text = `${signal.headline || ""} ${signal.body || ""}`;
      return [left?.name, right?.name].some((name) => name && text.includes(name));
    }),
    webContext: {
      source: "项目抓取的 RSS/网页新闻源和页面新闻轮播，不等同于模型实时联网搜索。",
      relatedNews
    }
  });
}

function buildPredictionPrompt() {
  return [
    "请基于结构化数据预测这场未赛比赛的观赛结论，输出中文，不要输出 JSON。",
    "结构必须包含：1）一句话结论，明确更看好谁；2）为什么这场值得看；3）双方胜负手；4）弱势方爆冷条件；5）不确定性。",
    "风格可以接近电竞赛前专栏/营销号标题感，但不要编造结构化数据中没有的选手数据、赔率、历史交锋或外部赛果。",
    "如果 contextGuardrail 标明是季后赛，严禁用 0-0、排名第几、小分来当预测依据；必须说清楚这是 BO 几、胜者/败者路径如何变化。",
    "可以引用 webContext.relatedNews 的标题作为舆论/话题度参考；如果没有相关新闻，就明确说当前网页上下文不足。",
    "如果数据不足，只能说“从当前赛程/签表/排名看”，并说明缺少哪些信息。"
  ].join("\n");
}

async function predictMatch(provider, tournament, analysis, match, newsItems) {
  const local = predictMatchLocally(tournament, analysis, match);
  if (provider === "local") return local;
  const context = buildPredictionContext(tournament, analysis, match, newsItems);
  const llm = await callLlm(provider, buildPredictionPrompt(), context);
  return llm ? llm.trim() : local;
}

function predictMatchLocally(tournament, analysis, match) {
  const teams = teamMap(tournament);
  const left = teams.get(match.teams[0]);
  const right = teams.get(match.teams[1]);
  if (analysis.phaseView?.type === "playoffs") {
    return predictPlayoffMatchLocally(tournament, analysis, match, left, right);
  }
  const standingsById = new Map((analysis.teams || []).map((team) => [team.id, team]));
  const leftRow = standingsById.get(match.teams[0]);
  const rightRow = standingsById.get(match.teams[1]);
  const leftHeat = audienceProfile(left?.name).heat;
  const rightHeat = audienceProfile(right?.name).heat;
  const leftRank = leftRow?.rank || 99;
  const rightRank = rightRow?.rank || 99;
  const rankEdge = rightRank - leftRank;
  const heatEdge = leftHeat - rightHeat;
  const leftScore = rankEdge * 8 + heatEdge * 0.25 + (leftRow?.differential || 0) * 1.5;
  const rightScore = -rankEdge * 8 - heatEdge * 0.25 + (rightRow?.differential || 0) * 1.5;
  const favorite = leftScore >= rightScore ? left : right;
  const underdog = favorite === left ? right : left;
  const confidenceGap = Math.abs(leftScore - rightScore);
  const confidence = confidenceGap >= 22 ? "偏高" : confidenceGap >= 10 ? "中等" : "接近五五开";
  const phaseCard = analysis.phaseView?.type === "playoffs"
    ? (analysis.phaseView.cards || []).find((card) => card.id === match.id)
    : null;
  const stakeText = phaseCard?.stake?.body || phaseCard?.impact || "这场会影响双方后续路径和观众关注度。";
  const bestOfText = `BO${match.bestOf || 3}`;
  return [
    `一句话结论：从当前赛程、排名和热度信号看，我更看好 ${favorite?.name || "排名更靠前的一方"}，但置信度是${confidence}。`,
    `为什么值得看：这是 ${tournament.name} 的 ${bestOfText}，${stakeText}`,
    `胜负手：${favorite?.name || "优势方"} 的优势主要来自当前排序/路径更主动；${underdog?.name || "另一方"} 要赢，需要把比赛打成更高波动的节奏，避免被拖入对手更舒服的运营区间。`,
    `爆冷条件：如果 ${underdog?.name || "弱势方"} 能在前两局拿到 BP 或节奏先手，并把 ${favorite?.name || "优势方"} 拉进连续团战/决策压力，比赛就有变数。`,
    `数据边界：当前本地预测没有实时选手状态、训练赛、赔率和完整历史交锋，只能作为观赛前的方向判断；若切换到 DeepSeek，会结合页面结构化数据生成更完整的赛前分析。`
  ].join("\n\n");
}

function predictPlayoffMatchLocally(tournament, analysis, match, left, right) {
  const phaseCard = (analysis.phaseView?.cards || []).find((card) => card.id === match.id);
  const leftProfile = dynamicAudienceProfile(left?.name, phaseCard || {}, analysis, { count: 0, headlines: [] });
  const rightProfile = dynamicAudienceProfile(right?.name, phaseCard || {}, analysis, { count: 0, headlines: [] });
  const leftPath = buildPlayoffTeamPaths(analysis.phaseView).find((path) => path.team === left?.name);
  const rightPath = buildPlayoffTeamPaths(analysis.phaseView).find((path) => path.team === right?.name);
  const pathEdge = playoffPathMomentum(leftPath) - playoffPathMomentum(rightPath);
  const heatEdge = (leftProfile.heat || 0) - (rightProfile.heat || 0);
  const leftScore = pathEdge * 16 + heatEdge * 0.2;
  const rightScore = -leftScore;
  const favorite = leftScore >= rightScore ? left : right;
  const underdog = favorite === left ? right : left;
  const confidenceGap = Math.abs(leftScore - rightScore);
  const confidence = confidenceGap >= 18 ? "中等偏高" : confidenceGap >= 8 ? "中等" : "接近五五开";
  const bestOfText = `BO${match.bestOf || phaseCard?.bestOf || 5}`;
  const bracketText = phaseCard?.bracket || bracketLabel(match.round);
  const stakeText = phaseCard?.stake?.body || phaseCard?.outcome?.summary || phaseCard?.impact ||
    describeUpcomingPlayoffOutcome({ bracket: bracketText, bestOf: match.bestOf || 5 }, playoffOutcomeRule(tournament, bracketText));
  const favoritePath = favorite === left ? leftPath : rightPath;
  const underdogPath = favorite === left ? rightPath : leftPath;
  return [
    `一句话结论：这是${bracketText}的 ${bestOfText}，不能按 0-0 积分榜理解；从当前签表路径和话题热度看，我更看好 ${favorite?.name || "路径更主动的一方"}，置信度是${confidence}。`,
    `为什么值得看：${stakeText}`,
    `路径状态：${pathSummary(favorite?.name, favoritePath)}；${pathSummary(underdog?.name, underdogPath)}。`,
    `胜负手：${favorite?.name || "优势方"} 要把系列赛打成稳定执行和资源置换，尽量减少乱战波动；${underdog?.name || "另一方"} 的机会在于前两局抢到 BP/节奏先手，把比赛拖进高波动团战。`,
    `爆冷条件：如果 ${underdog?.name || "弱势方"} 能先拿到赛点或连续逼出对手失误，这场就会从“路径优势局”变成真正的压力测试。`,
    "数据边界：本地预测没有实时选手状态、训练赛、赔率和完整舆情搜索；切到 DeepSeek 后会结合页面抓取的相关新闻标题和结构化签表给出更完整判断。"
  ].join("\n\n");
}

function playoffPathMomentum(path) {
  if (!path) return 0;
  let score = 0;
  for (const played of path.played || []) {
    score += played.result === "win" ? 1 : -1;
    if (played.result === "win" && String(played.impact || "").includes("爆冷")) score += 1;
  }
  for (const upcoming of path.upcoming || []) {
    if (upcoming.bracket === "胜者组") score += 1;
    if (upcoming.bracket === "败者组") score -= 1;
  }
  return score;
}

function pathSummary(teamNameValue, path) {
  if (!teamNameValue) return "未知队伍路径暂缺";
  if (!path) return `${teamNameValue} 当前签表路径暂缺，需等待接口补全`;
  const latest = path.played?.slice(-1)[0];
  const next = path.upcoming?.[0];
  const latestText = latest ? `最近一场${latest.result === "win" ? "取胜" : "失利"}，队伍视角比分 ${latest.perspectiveScore || latest.score}` : "当前签表内还没有已结束比赛";
  const nextText = next ? `下一场在${next.bracket}对 ${next.opponent}` : "当前没有待赛节点";
  return `${teamNameValue}：${latestText}；${nextText}`;
}

function parseJsonFromLlm(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeLlmFocusStory(story) {
  if (!story || typeof story !== "object") return null;
  const headline = String(story.headline || "").trim();
  const body = String(story.body || "").trim();
  if (!headline || !body) return null;
  const tone = story.tone === "hot" ? "hot" : "watch";
  const chips = Array.isArray(story.chips)
    ? story.chips.map((chip) => String(chip).trim()).filter(Boolean).slice(0, 4)
    : [];
  return { tone, headline, body, chips };
}

async function getNewsData({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && newsCache && now - newsCache.cachedAt < NEWS_CACHE_TTL_MS) return newsCache.data;
  try {
    const items = await fetchNewsItems();
    const data = {
      items: items.length ? items : fallbackNews(),
      meta: {
        source: items.length ? "RSS/网页新闻源" : "本地赛事焦点",
        updatedAt: new Date().toISOString()
      }
    };
    newsCache = { cachedAt: now, data };
    return data;
  } catch (error) {
    const data = {
      items: fallbackNews(),
      meta: {
        source: "本地赛事焦点",
        warning: `新闻源暂不可用：${error.message}`,
        updatedAt: new Date().toISOString()
      }
    };
    newsCache = { cachedAt: now, data };
    return data;
  }
}

async function fetchNewsItems() {
  const sources = newsSources();
  const batches = await Promise.allSettled(sources.map((source) => fetchNewsSource(source)));
  const items = batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []);
  const deduped = [];
  const seen = new Set();
  for (const item of items.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))) {
    const key = normalizeUrl(item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= 8) break;
  }
  return deduped;
}

function newsSources() {
  const configured = csv(process.env.NEWS_FEEDS);
  const urls = configured.length ? configured : [
    "https://lolesports.com/en-US/news",
    "https://www.dexerto.com/league-of-legends/feed/",
    "https://esports.gg/news/league-of-legends/feed/"
  ];
  return urls.map((url) => ({ url, source: sourceNameFromUrl(url) }));
}

async function fetchNewsSource(source) {
  const text = await fetchText(source.url);
  const rssItems = parseRssItems(text, source);
  const items = rssItems.length ? rssItems : parseLoLEsportsNews(text, source);
  const enriched = [];
  for (const item of items.slice(0, 5)) {
    const image = item.image || await fetchArticleImage(item.url).catch(() => null);
    enriched.push({
      ...item,
      image: image || "/news-placeholder.svg"
    });
  }
  return enriched;
}

function parseLoLEsportsNews(html, source) {
  const items = [];
  const seen = new Set();
  const normalizedHtml = String(html || "")
    .replace(/\\"/g, "\"")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\/", "/");
  const pattern = /"externalTitle":"((?:\\.|[^"\\])*)[\s\S]{0,1600}?"path":\{"__typename":"Slug","current":"((?:\\.|[^"\\])*)"[\s\S]{0,1200}?"displayedPublishDate":"((?:\\.|[^"\\])*)"[\s\S]{0,1600}?"url":"((?:\\.|[^"\\])*)"/g;
  for (const match of normalizedHtml.matchAll(pattern)) {
    const title = decodeJsString(match[1]);
    const path = decodeJsString(match[2]);
    const publishedAt = decodeJsString(match[3]);
    const image = decodeJsString(match[4]);
    const url = path.startsWith("http") ? path : `https://lolesports.com/en-US${path}`;
    if (!title || !path || seen.has(url)) continue;
    seen.add(url);
    items.push({
      title,
      url,
      image,
      source: source.source,
      publishedAt: parseNewsDate(publishedAt)
    });
  }
  return items;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": "MatchMindEsports/1.0"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseRssItems(xml, source) {
  return Array.from(String(xml || "").matchAll(/<item\b[\s\S]*?<\/item>/gi))
    .map((match) => parseRssItem(match[0], source))
    .filter(Boolean);
}

function parseRssItem(itemXml, source) {
  const title = decodeXml(stripTags(xmlValue(itemXml, "title"))).trim();
  const url = decodeXml(xmlValue(itemXml, "link")).trim();
  if (!title || !url) return null;
  const description = decodeXml(xmlValue(itemXml, "description"));
  const image = firstNonEmpty([
    attrValue(itemXml, /<media:content\b[^>]*url=["']([^"']+)["']/i),
    attrValue(itemXml, /<media:thumbnail\b[^>]*url=["']([^"']+)["']/i),
    attrValue(itemXml, /<enclosure\b[^>]*url=["']([^"']+)["'][^>]*(?:type=["']image\/[^"']+["'])?/i),
    attrValue(description, /<img\b[^>]*src=["']([^"']+)["']/i)
  ]);
  return {
    title,
    url,
    image,
    source: source.source,
    publishedAt: parseNewsDate(xmlValue(itemXml, "pubDate") || xmlValue(itemXml, "dc:date"))
  };
}

async function fetchArticleImage(url) {
  const html = await fetchText(url);
  return firstNonEmpty([
    attrValue(html, /<meta\b[^>]*(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["']/i),
    attrValue(html, /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["']/i),
    attrValue(html, /<meta\b[^>]*(?:property|name)=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)
  ]);
}

function xmlValue(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(xml || "").match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match ? match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "") : "";
}

function attrValue(text, pattern) {
  const match = String(text || "").match(pattern);
  return match ? decodeXml(match[1]) : "";
}

function firstNonEmpty(values) {
  return values.find((value) => value && String(value).trim()) || "";
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, "");
}

function decodeXml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function decodeJsString(value) {
  try {
    return JSON.parse(`"${String(value || "").replace(/"/g, '\\"')}"`);
  } catch {
    return String(value || "")
      .replaceAll("\\u0026", "&")
      .replaceAll("\\/", "/")
      .replace(/\\"/g, "\"");
  }
}

function parseNewsDate(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(url || "");
  }
}

function sourceNameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "赛事新闻";
  }
}

function fallbackNews() {
  return [
    {
      title: "实时赛事焦点正在更新",
      source: "MatchMind",
      url: "#analysis",
      image: "/news-placeholder.svg",
      publishedAt: new Date().toISOString()
    }
  ];
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/tournaments") {
    const data = await getTournamentData({ refresh: url.searchParams.get("refresh") === "1" });
    sendJson(res, 200, data);
    return;
  }

  if (url.pathname === "/api/news") {
    const data = await getNewsData({ refresh: url.searchParams.get("refresh") === "1" });
    sendJson(res, 200, data);
    return;
  }

  if (url.pathname === "/api/analyze") {
    const data = await getTournamentData({ refresh: url.searchParams.get("refresh") === "1" });
    const tournament = getTournamentFromData(data, url.searchParams.get("tournament"));
    const analysis = localAnalysis(tournament);
    const news = await getNewsData().catch(() => ({ items: [] }));
    enrichAnalysisWithAudienceFocus(tournament, analysis, news.items);
    const provider = url.searchParams.get("provider") || "local";
    if (provider !== "local") {
      try {
        await enhanceAnalysisWithLlm(provider, tournament, analysis, news.items);
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
    const news = await getNewsData().catch(() => ({ items: [] }));
    enrichAnalysisWithAudienceFocus(tournament, analysis, news.items);
    const provider = body.provider || "local";
    let answer = answerLocally(body.question || "", tournament, analysis);
    if (provider !== "local") {
      try {
        const llm = await callLlm(provider, buildChatPrompt(body.question || ""), compactContext(tournament, analysis, news.items));
        if (llm) answer = llm;
      } catch (error) {
        answer += `\n\n模型接口暂不可用，已使用本地规则引擎回答。错误：${error.message}`;
      }
    }
    sendJson(res, 200, { answer, analysis, meta: data.meta });
    return;
  }

  if (url.pathname === "/api/prediction" && req.method === "POST") {
    const body = await readBody(req);
    const data = await getTournamentData();
    const tournament = getTournamentFromData(data, body.tournamentId);
    const analysis = localAnalysis(tournament);
    const news = await getNewsData().catch(() => ({ items: [] }));
    enrichAnalysisWithAudienceFocus(tournament, analysis, news.items);
    const match = tournament.matches.find((item) => item.id === body.matchId);
    if (!match) {
      sendJson(res, 404, { error: "Match not found" });
      return;
    }
    if (match.status === "finished") {
      sendJson(res, 400, { error: "Only unfinished matches can be predicted" });
      return;
    }
    const provider = body.provider || "local";
    let prediction = predictMatchLocally(tournament, analysis, match);
    let llmError = null;
    try {
      prediction = await predictMatch(provider, tournament, analysis, match, news.items);
    } catch (error) {
      llmError = error.message;
      prediction += `\n\n模型接口暂不可用，已使用本地预测。错误：${error.message}`;
    }
    sendJson(res, 200, { prediction, match, analysis, llmError, meta: data.meta });
    return;
  }

  if (url.pathname === "/api/scenario" && req.method === "POST") {
    const body = await readBody(req);
    const data = await getTournamentData();
    const tournament = getTournamentFromData(data, body.tournamentId);
    const analysis = localAnalysis(tournament, body.scenario || {});
    const news = await getNewsData().catch(() => ({ items: [] }));
    enrichAnalysisWithAudienceFocus(tournament, analysis, news.items);
    const scenarioText = buildScenarioText(tournament, body.scenario || {}, analysis);
    sendJson(res, 200, { tournament, analysis, scenarioText, meta: data.meta, updatedAt: new Date().toISOString() });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function buildScenarioText(tournament, scenario, analysis) {
  const matchId = Object.keys(scenario || {})[0];
  const result = scenario?.[matchId];
  const match = tournament.matches.find((item) => item.id === matchId);
  if (!match || !result) return "";
  const left = teamName(tournament, match.teams[0]);
  const right = teamName(tournament, match.teams[1]);
  if (tournament.rules?.phase === "playoffs") {
    const leftWins = Number(result.left || 0);
    const rightWins = Number(result.right || 0);
    const winner = leftWins > rightWins ? left : right;
    const loser = leftWins > rightWins ? right : left;
    const bracket = bracketLabel(match.round);
    const original = buildPlayoffView(tournament).cards.find((card) => card.id === match.id);
    const baseCard = buildPlayoffView(tournament).cards.find((card) => card.id === match.id);
    const hypotheticalCard = {
      ...(baseCard || {}),
      id: match.id,
      startsAt: match.startsAt,
      round: match.round,
      bracket,
      bestOf: match.bestOf,
      left,
      right,
      score: `${leftWins}:${rightWins}`,
      status: "finished",
      winner,
      loser
    };
    const impact = buildPlayoffOutcome(tournament, hypotheticalCard, buildPlayoffView(tournament).cards).summary;
    const stake = original?.stake?.body ? `关键权益：${original.stake.body}` : "";
    return [
      `假设 ${left} ${leftWins}:${rightWins} ${right}。`,
      `${winner} 获胜，${loser} 失利。${impact}`,
      stake,
      "季后赛推演只解释签表路径变化，不再重算积分榜或 0-0 战绩。"
    ].filter(Boolean).join("\n");
  }
  const top = (analysis.teams || [])
    .slice(0, tournament.rules.advanceSlots)
    .map((team) => `${team.rank}.${team.name}(${team.wins}-${team.losses})`)
    .join("  ");
  return `假设 ${left} ${result.left}:${result.right} ${right}\n晋级区将变为：${top}\n${firstLine(analysis.summary)}`;
}

function answerLocally(question, tournament, analysis) {
  const q = question.toLowerCase();
  const teams = analysis.teams;
  const phaseCard = analysis.phaseView?.type === "playoffs" ? findRelevantPhaseCard(q, analysis.phaseView.cards || []) : null;
  if (phaseCard) {
    const stakeText = phaseCard.stake?.body ? `关键权益：${phaseCard.stake.body}` : phaseCard.impact;
    const statusText = phaseCard.status === "finished"
      ? `已结束，比分 ${phaseCard.left} ${phaseCard.score} ${phaseCard.right}。`
      : `尚未开赛，时间 ${new Date(phaseCard.startsAt).toLocaleString("zh-CN", { hour12: false })}。`;
    return `${phaseCard.left} vs ${phaseCard.right}：${statusText}${stakeText}`;
  }
  if (analysis.phaseView?.type === "playoffs") {
    const mentionedPlayoffTeam = tournament.teams.find((team) => q.includes(team.name.toLowerCase()) || q.includes(team.id.toLowerCase()));
    if (mentionedPlayoffTeam) {
      const path = buildPlayoffTeamPaths(analysis.phaseView).find((item) => item.team === mentionedPlayoffTeam.name);
      const related = (analysis.phaseView.cards || []).filter((card) => [card.left, card.right].includes(mentionedPlayoffTeam.name));
      const latest = related.filter((card) => card.status === "finished").slice(-1)[0];
      const next = related.find((card) => card.status !== "finished");
      const latestText = latest ? `最近一场：${latest.left} ${latest.score} ${latest.right}，${latest.impact}` : "当前签表内还没有已结束比赛。";
      const nextText = next ? `下一场：${new Date(next.startsAt).toLocaleString("zh-CN", { hour12: false })} ${next.left} vs ${next.right}，BO${next.bestOf}，${next.stake?.body || next.impact}` : "当前没有待赛节点。";
      return `${mentionedPlayoffTeam.name} 当前处于${tournament.rules?.format || "季后赛签表"}中，不能用 0-0 积分榜解读。\n${latestText}\n${nextText}\n${pathSummary(mentionedPlayoffTeam.name, path)}`;
    }
  }
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

function findRelevantPhaseCard(question, cards) {
  const normalized = String(question || "").toLowerCase();
  const stakeMatch = cards.find((card) => {
    const terms = [
      card.stake?.headline,
      card.stake?.body,
      ...(card.stake?.chips || [])
    ].filter(Boolean).join(" ").toLowerCase();
    return terms && ["msi", "门票", "权益", "意味着"].some((word) => normalized.includes(word)) &&
      [card.left, card.right].some((name) => normalized.includes(String(name).toLowerCase()));
  });
  if (stakeMatch) return stakeMatch;
  return cards.find((card) => {
    const left = String(card.left || "").toLowerCase();
    const right = String(card.right || "").toLowerCase();
    return normalized.includes(left) && normalized.includes(right);
  }) || null;
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
