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
  const limit = clampNumber(process.env.PANDASCORE_MATCH_LIMIT, 10, 100, 80);
  const lookbackDays = clampNumber(process.env.PANDASCORE_LOOKBACK_DAYS, 0, 60, 2);
  const lookaheadDays = clampNumber(process.env.PANDASCORE_LOOKAHEAD_DAYS, 1, 90, 21);
  const now = new Date();
  const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000).toISOString();
  const endpoint = new URL(`/${game}/matches`, baseUrl);
  endpoint.searchParams.set("sort", "begin_at");
  endpoint.searchParams.set("per_page", String(limit));
  endpoint.searchParams.set("range[begin_at]", `${from},${to}`);
  for (const id of csv(process.env.PANDASCORE_LEAGUE_IDS)) {
    endpoint.searchParams.append("filter[league_id]", id);
  }

  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(`PandaScore request failed: ${response.status}`);
  }
  const matches = await response.json();
  const tournaments = normalizePandaScoreMatches(matches, game);
  await enrichWithPandaStandings(tournaments, baseUrl, token);
  return withMeta({ tournaments }, {
    mode: "realtime",
    source: "PandaScore 实时赛事 API",
    updatedAt: new Date().toISOString(),
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
  if (text.includes("lpl") && (text.includes("ascend") || text.includes("登峰"))) {
    return {
      format: "LPL Split 2 登峰组",
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
    "academy",
    "challenger",
    "challengers",
    "division 2",
    "secondary"
  ].join(","));
  return include.some((keyword) => text.includes(keyword.toLowerCase())) &&
    !exclude.some((keyword) => text.includes(keyword.toLowerCase()));
}

function comparePandaTournaments(a, b) {
  const priority = (value) => {
    const text = `${value.name} ${value.stage}`.toLowerCase();
    const keywords = ["lpl", "lck", "ewc", "esports world cup", "msi", "world", "lec"];
    const index = keywords.findIndex((keyword) => text.includes(keyword));
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
    `${tournament.name}。${sourceText}${ruleText}`,
    tournament.rules.advanceSlots ? `目前 ${safe} 位于${tournament.rules.labels?.advance || "排名前列"}；${playIn !== "暂无" ? `${playIn} 位于${tournament.rules.labels?.playIn || "观察区"}。` : "其他队伍仍需结合后续赛程和小分判断。"}` : `当前所有队伍都需要结合${tournament.rules.labels?.playIn || "后续阶段"}规则判断。`,
    focus ? `下一场重点关注 ${focus.left} vs ${focus.right}，原因是双方官方/推算排名接近关键分界。` : "目前没有未结束比赛，或当前接口窗口内没有后续赛程。",
    "不要仅凭最近几场结果宣称锁定晋级或理论淘汰；需要同时看官方积分、赛制分区、小分和加赛规则。"
  ].join("\n");
  return { standings, teams, keyMatches: matches, summary };
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
