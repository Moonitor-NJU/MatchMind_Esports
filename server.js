const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadEnvFile } = require("./src/env");
const { createStaticHandler, readBody, sendJson } = require("./src/http-utils");
const { callLlm } = require("./src/llm-client");
const { buildNewsCoverSvg, generatedNewsCoverUrl } = require("./src/news-cover");
const { TEAM_AUDIENCE_BASELINES } = require("./src/audience-baselines");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "tournaments.json");
const RULES_FILE = path.join(ROOT, "data", "rules.json");
const ENV_FILE = path.join(ROOT, ".env");

loadEnvFile(ENV_FILE);

const LIVE_CACHE_TTL_MS = Number(process.env.LIVE_CACHE_TTL_MS || 5 * 60 * 1000);
const NEWS_CACHE_TTL_MS = Number(process.env.NEWS_CACHE_TTL_MS || 15 * 60 * 1000);
const ROSTER_CACHE_TTL_MS = Number(process.env.ROSTER_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const RULE_RESEARCH_CACHE_TTL_MS = Number(process.env.RULE_RESEARCH_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const ANALYSIS_CACHE_TTL_MS = Number(process.env.ANALYSIS_CACHE_TTL_MS || 10 * 60 * 1000);
const ROSTER_ANALYSIS_TIMEOUT_MS = Number(process.env.ROSTER_ANALYSIS_TIMEOUT_MS || 9_000);
const RULE_ANALYSIS_TIMEOUT_MS = Number(process.env.RULE_ANALYSIS_TIMEOUT_MS || 12_000);
const newsCache = new Map();
const rosterCache = new Map();
const ruleResearchCache = new Map();
const analysisCache = new Map();
const newsPending = new Map();
const analysisPending = new Map();
const DEFAULT_BILIBILI_NEWS_MID = "1941869599";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, label }), timeoutMs);
  });
  return Promise.race([
    promise.then((data) => ({ data })).catch((error) => ({ error })),
    timeout
  ]).finally(() => clearTimeout(timer));
}

function readRules() {
  try {
    return readJson(RULES_FILE);
  } catch (error) {
    return { profiles: [] };
  }
}

function getTournamentFromData(data, id) {
  if (!id) return data.tournaments[0];
  const tournament = data.tournaments.find((item) => item.id === id);
  if (tournament) return tournament;
  throw new Error(`Requested tournament "${id}" is unavailable in the current data snapshot. Refresh the tournament list before retrying.`);
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
  const proxy = proxyDiagnostics();
  const warnings = [
    meta.warning,
    ...proxy.warnings
  ].filter(Boolean);
  return {
    ...data,
    meta: {
      ...meta,
      warning: warnings.join("；"),
      proxyWarnings: proxy.warnings
    }
  };
}

function proxyDiagnostics() {
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "GIT_HTTP_PROXY", "GIT_HTTPS_PROXY"];
  const values = names
    .map((name) => ({ name, value: String(process.env[name] || process.env[name.toLowerCase()] || "").trim() }))
    .filter((item) => item.value);
  const bad = values.filter((item) => /127\.0\.0\.1:9\b|localhost:9\b|\[?::1\]?:9\b/i.test(item.value));
  return {
    values,
    warnings: bad.length
      ? [`检测到不可用代理 ${bad.map((item) => `${item.name}=${item.value}`).join("、")}，可能导致实时赛事、新闻和搜索源请求失败`]
      : []
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
  await enrichWithPandaTeamRosters(tournaments, baseUrl, token);
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

async function enrichWithPandaTeamRosters(tournaments, baseUrl, token) {
  const teamsByPandaId = new Map();
  for (const tournament of tournaments) {
    for (const team of tournament.teams || []) {
      if (!team.pandaId) continue;
      if (!teamsByPandaId.has(team.pandaId)) teamsByPandaId.set(team.pandaId, []);
      teamsByPandaId.get(team.pandaId).push(team);
    }
  }
  const ids = Array.from(teamsByPandaId.keys()).slice(0, 80);
  await Promise.all(ids.map(async (pandaId) => {
    try {
      const endpoint = new URL(`/teams/${pandaId}`, baseUrl);
      const response = await fetch(endpoint, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`
        }
      });
      if (!response.ok) return;
      const detail = await response.json();
      const roster = normalizePandaRoster(detail);
      if (!roster.length) return;
      for (const team of teamsByPandaId.get(pandaId) || []) {
        team.roster = roster;
        team.rosterSource = "pandascore-team-detail";
      }
    } catch {
      // Roster enrichment is best-effort; schedule and standings should still render.
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
  const roster = normalizePandaRoster(rawTeam);
  if (!teams.has(id)) {
    teams.set(id, {
      id,
      pandaId,
      name: rawTeam.acronym || rawTeam.name,
      region: rawTeam.location || "Global",
      color: colors[teams.size % colors.length],
      roster,
      rosterSource: roster.length ? "pandascore-team-payload" : null
    });
  } else if (roster.length && !(teams.get(id).roster || []).length) {
    teams.set(id, {
      ...teams.get(id),
      roster,
      rosterSource: "pandascore-team-payload"
    });
  }
  return teams.get(id);
}

function normalizePandaRoster(rawTeam) {
  const candidates = [
    rawTeam.players,
    rawTeam.current_roster,
    rawTeam.currentRoster,
    rawTeam.current_videogame?.players,
    rawTeam.current_videogame?.current_roster
  ].find(Array.isArray);
  if (!candidates) return [];
  return candidates
    .map((player) => ({
      name: player.name || player.slug || player.first_name || player.last_name,
      role: player.role || player.position || player.current_videogame?.role || null,
      nationality: player.nationality || player.hometown || null
    }))
    .filter((player) => player.name)
    .filter((player, index, list) => list.findIndex((item) => item.name === player.name) === index)
    .slice(0, 12);
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
    ? `${card.winner} 下一场将对阵 ${winnerNext.left === card.winner ? winnerNext.right : winnerNext.left}`
    : "";
  const loserNextText = loserNext
    ? `${card.loser} 下一场将对阵 ${loserNext.left === card.loser ? loserNext.right : loserNext.left}`
    : "";
  return [
    `${card.winner} ${rule.winnerPath}；${card.loser} ${rule.loserPath}。`,
    winnerNextText ? `${winnerNextText}。` : "",
    loserNextText ? `${loserNextText}。` : ""
  ].filter(Boolean).join("");
}

function describeUpcomingPlayoffOutcome(card, rule) {
  return `这场 ${card.bracket} BO${card.bestOf} 的胜者将${rule.winnerPath}；败者将${rule.loserPath}。`;
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
  const leftTags = displayAudienceTags(leftProfile);
  const rightTags = displayAudienceTags(rightProfile);
  const identity = [
    leftTags.length ? `${match.left} 这边的关键词是 ${leftTags.join("、")}` : "",
    rightTags.length ? `${match.right} 更像是 ${rightTags.join("、")} 的剧本` : ""
  ].filter(Boolean).join("；");
  const stakes = match.bracket === "败者组"
    ? (match.outcome?.summary || "败者组没有太多试错空间，这场更像是决定队伍能不能继续留在牌桌上的 BO。")
    : match.bracket === "胜者组"
      ? (match.outcome?.summary || "胜者组的价值在于少打一轮硬仗，谁赢谁就能把压力甩给对手。")
      : match.bracket === "淘汰赛"
        ? "这类资格赛不能按积分榜理解，真正看点是谁能在 BO5 里先把晋级路线打清楚。"
        : "这场会影响排名主动权，适合结合赛前讨论和赛后风向观察。";
  return [identity ? `${identity}。` : "", rivalry ? `叙事上属于${rivalry}。` : "", buzzLine, stakes].filter(Boolean).join("");
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
  if (!total) return "这场的热度更多来自队伍本身的关注度和淘汰赛压力，而不是冷冰冰的积分变化。";
  const sample = [...leftBuzz.headlines, ...rightBuzz.headlines][0];
  return `最近新闻和社区标题里，${left}、${right} 一共出现约 ${total} 次${sample ? `，比较有代表性的话题是「${sample}」` : ""}。`;
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

function compactContext(tournament, analysis, newsItems = [], rosterData = null, ruleResearch = null) {
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
      source: process.env.TAVILY_API_KEY
        ? "Tavily 实时网页搜索 + 项目抓取的 RSS/赛事新闻源。搜索结果会经过赛区、时效和相关性过滤。"
        : "项目抓取的 RSS/网页新闻源和页面新闻轮播；未配置搜索 API 时不等同于实时全网搜索。",
      relatedNews: relatedNewsForTournament(newsItems, tournament).slice(0, 8)
    },
    rosterContext: rosterContextForTournament(tournament, rosterData),
    ruleResearch: ruleResearch || {
      source: "未执行联网规则检索",
      evidence: []
    },
    phaseView: analysis.phaseView,
    playoffTeamPaths: isPlayoffs ? buildPlayoffTeamPaths(analysis.phaseView) : [],
    keyMatches: analysis.keyMatches.slice(0, 5)
  });
}

function rosterContextForTournament(tournament, rosterData = null) {
  const evidenceByTeam = new Map((rosterData?.teams || []).map((team) => [team.name, team]));
  return {
    source: "PandaScore 队伍 payload + 后端实时网页检索。若为空，代表当前上下文没有可靠阵容，不代表可以使用历史记忆补全。",
    updatedAt: rosterData?.updatedAt || null,
    guardrail: "只有 rosterContext.teams[].roster、rosterContext.teams[].retrievedEvidence 或 webContext.relatedNews 标题/摘要明确出现的选手名才可被提及。缺失时必须写“当前阵容数据不足”，禁止用历史阵容、旧世界赛阵容或训练记忆替代。",
    teams: (tournament.teams || []).map((team) => ({
      name: team.name,
      rosterSource: team.rosterSource || null,
      roster: (team.roster || []).map((player) => ({
        name: player.name,
        role: player.role || null
      })),
      retrievedEvidence: (evidenceByTeam.get(team.name)?.evidence || []).slice(0, 5)
    }))
  };
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

async function enhanceAnalysisWithLlm(provider, tournament, analysis, newsItems = [], rosterData = null, ruleResearch = null) {
  const prompt = [
    "请基于结构化数据输出 JSON，不要输出 Markdown。",
    "JSON 格式：{\"summary\":\"两到四句中文摘要\",\"focusStories\":[{\"tone\":\"hot|watch\",\"headline\":\"一句焦点标题\",\"body\":\"两到三句，必须点明哪些比赛/赛果为什么重要\",\"chips\":[\"标签1\",\"标签2\"]}],\"cardInsights\":[{\"id\":\"比赛id\",\"impact\":\"两到三句独立赛果/赛前权益解读\",\"evidenceIndexes\":[0,2]}]}。",
    "优先识别 ruleResearch.evidence、完整 phaseView.cards、audienceSignals、关键晋级权益、国际赛名额、胜败者组路径和还没打的直接影响比赛。",
    "ruleResearch.evidence 是后端针对当前赛事动态联网检索到的规则/资格证据。涉及国际赛门票、晋级资格、种子和淘汰规则时，必须以这些证据为优先依据；证据不足时明确保留不确定性。",
    "只有 ruleResearch.evidence 中 usableForRules=true 的条目可以证明晋级、淘汰、门票或种子结论。优先采用 scope=current-event 且 confidence=high 的规则证据；sourceType=opinion-community 的内容只能作为舆论背景，绝不能作为规则事实。",
    "international-general 只能证明国际赛事总体名额，不能单独证明某场比赛会锁定门票。conflictsWithBracket=true 的内容与当前签表冲突，必须忽略。只有 medium/low 证据时要写成“根据当前检索资料”，不得把它表述为官方确认。多个可靠来源冲突时必须指出冲突。",
    "如果 phaseView.type 是 playoffs，请为 phaseView.cards 中每一张卡生成独立 cardInsights。你需要读取整张签表，判断该卡位于首轮、中期、败者组生死轮、胜者组决赛、败者组决赛或总决赛，并结合后续具体对手和联网规则证据解释意义。",
    "不同比赛不能复用同一句路径模板。应说明该赛果让队伍还需经过哪些已知对手/轮次、是否失去容错、是否淘汰、是否进入决赛或获得国际赛资格；无法由签表或联网证据确认的事实不得编造。",
    "cardInsights 中凡提到国际赛门票、资格或特殊赛制权益，必须在 evidenceIndexes 中填写实际使用的 ruleResearch.evidence 零基索引；没有证据就不要填写该权益。",
    "可以结合 webContext.relatedNews 和 audienceSignals 概括网上讨论、爆冷评价、强敌压力与观赛叙事，但必须把舆论评价和规则事实区分开，不能用网友观点证明晋级资格。",
    "焦点要兼顾观众体验：队伍名气、流量队、近期新闻标题讨论、爆冷/复仇/生死战叙事都要纳入，但不能脱离给定数据。",
    "写法要像电竞赛前专栏，不要像系统模板。禁止出现“带着标签”“主动权战标签”“按项目赛制配置”“官方签表尚未给出”“本地规则引擎”等内部工程话术。",
    "不要只复述标签；必须直接说人话：这场为什么值得看，谁压力更大，赢了/输了对观众理解赛程有什么影响。",
    "如果 contextGuardrail 标明是季后赛，绝对不要用 0-0、官方排名、小分和晋级线胜场差做结论；这些字段在季后赛上下文中应视为无效。",
    "可使用 webContext.relatedNews 作为网页舆论参考；没有相关新闻时不要声称模型已全网搜索。",
    "可使用 rosterContext.teams[].retrievedEvidence 作为当前阵容/首发/名单变动检索证据；涉及选手名时要说明依据来自这些证据。",
    "严禁凭记忆补当前选手阵容。只有 rosterContext 或 webContext.relatedNews 明确出现的选手名才可以写进分析；如果 roster 和 retrievedEvidence 都为空，必须避免点名并说明当前阵容上下文不足。",
    "不得编造结构化数据中不存在的赛果；如果规则只来自项目配置，请用“按当前规则配置/以官方公告为准”保持边界。"
  ].join("\n");
  const llm = await callLlm(provider, prompt, compactContext(tournament, analysis, newsItems, rosterData, ruleResearch));
  if (!llm) return false;
  const parsed = parseJsonFromLlm(llm);
  if (!parsed) {
    analysis.llmError = "LLM returned non-JSON analysis";
    return false;
  }
  if (typeof parsed.summary === "string" && parsed.summary.trim()) {
    analysis.summary = sanitizeDisplayText(parsed.summary.trim());
  }
  if (Array.isArray(parsed.focusStories)) {
    const focusStories = parsed.focusStories
      .map(normalizeLlmFocusStory)
      .filter(Boolean)
      .slice(0, 2);
    if (focusStories.length) analysis.focusStories = focusStories;
  }
  if (Array.isArray(parsed.cardInsights) && analysis.phaseView?.type === "playoffs") {
    const evidence = ruleResearch?.evidence || [];
    const insights = new Map(parsed.cardInsights
      .map((item) => {
        const indexes = Array.isArray(item?.evidenceIndexes)
          ? item.evidenceIndexes.map(Number).filter((index) => (
            Number.isInteger(index)
            && index >= 0
            && index < evidence.length
            && evidence[index]?.usableForRules === true
          )).slice(0, 3)
          : [];
        return [String(item?.id || ""), {
          impact: sanitizeDisplayText(item?.impact || ""),
          evidence: indexes.map((index) => evidence[index])
        }];
      })
      .filter(([id, item]) => id && item.impact));
    for (const card of analysis.phaseView.cards || []) {
      if (insights.has(card.id)) {
        card.impact = insights.get(card.id).impact;
        card.researchEvidence = insights.get(card.id).evidence;
        card.aiEnhanced = true;
      }
    }
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
    "涉及赛制、淘汰、决赛、国际赛门票和种子时，必须优先依据 ruleResearch.evidence 并结合完整 phaseView.cards 分析；证据不足时明确说明，不能套用旧赛季规则。",
    "只有 ruleResearch.evidence 中 usableForRules=true 的条目可以证明规则结论；sourceType=opinion-community 仅代表舆论，conflictsWithBracket=true 必须忽略。规则证据只有 medium/low 可信度时，不得写成官方确认；多个可靠来源冲突时要明确指出。",
    "可以使用 webContext.relatedNews 作为网页舆论材料；如果没有相关新闻，不要假装已经全网搜索。",
    "可以使用 rosterContext.teams[].retrievedEvidence 作为当前阵容/首发/名单变动检索证据；不要把旧阵容回忆当作事实。",
    "严禁凭记忆补当前选手阵容。只有 rosterContext 或 webContext.relatedNews 明确出现的选手名才可以写进回答；如果 roster 和 retrievedEvidence 都为空，直接说当前阵容上下文不足，不要使用 2021、2023 等历史阵容。",
    "如果结构化数据不足以支撑判断，要明确说缺哪类数据，并给出基于现有信息的保守判断。",
    "回答尽量具体到哪些比赛/哪场 BO5/哪支队伍的路径会改变，避免只说“主动权”“复活甲”“晋级形势”这种空话。"
  ].join("\n");
}

function buildPredictionContext(tournament, analysis, match, newsItems = [], rosterData = null, ruleResearch = null) {
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
  const relatedNews = relatedNewsForMatch(newsItems, tournament, [left?.name, right?.name]).slice(0, 8);
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
      source: process.env.TAVILY_API_KEY
        ? "Tavily 实时网页搜索 + 项目抓取的 RSS/赛事新闻源。搜索结果会经过赛区、时效和相关性过滤。"
        : "项目抓取的 RSS/网页新闻源和页面新闻轮播；未配置搜索 API 时不等同于实时全网搜索。",
      relatedNews
    },
    rosterContext: rosterContextForTournament({ teams: [left, right].filter(Boolean) }, rosterData),
    ruleResearch: ruleResearch || {
      source: "未执行联网规则检索",
      evidence: []
    }
  });
}

function relatedNewsForMatch(newsItems, tournament, teams) {
  const general = relatedNewsForTournament(newsItems, tournament);
  return general
    .map((item) => {
      const text = `${item.title || ""} ${item.description || ""}`.toLowerCase();
      const matchHit = teams.some((name) => name && teamMentionedInText(name, text));
      return { ...item, matchHit };
    })
    .sort((a, b) => Number(b.matchHit) - Number(a.matchHit));
}

async function getRosterData({ tournament, teams = null, newsItems = [], refresh = false } = {}) {
  if (!tournament) return { teams: [], updatedAt: new Date().toISOString(), source: "no-tournament" };
  const selectedTeams = normalizeRosterTeamSelection(tournament, teams);
  const cacheKey = `${tournament.id}:${selectedTeams.map((team) => team.name).sort().join("|")}`;
  const cached = rosterCache.get(cacheKey);
  const now = Date.now();
  if (!refresh && cached && now - cached.cachedAt < ROSTER_CACHE_TTL_MS) return cached.data;

  const searchItems = await fetchRosterSearchItems(tournament, selectedTeams).catch(() => []);
  const teamsWithEvidence = await Promise.all(selectedTeams.map(async (team) => {
    const embeddedRoster = (team.roster || []).map((player) => ({
      name: player.name,
      role: player.role || null,
      source: team.rosterSource || "pandascore-team-payload"
    }));
    const evidencePool = [
      ...searchItems,
      ...(newsItems || []).map((item) => ({ ...item, evidenceKind: "news" }))
    ];
    const evidence = evidencePool
      .map((item) => ({ ...item, rosterScore: rosterEvidenceScore(item, tournament, team.name) }))
      .filter((item) => item.rosterScore > 0)
      .sort((a, b) => b.rosterScore - a.rosterScore || Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
      .filter(uniqueEvidenceUrl)
      .slice(0, 6)
      .map((item) => ({
        title: item.title,
        source: item.source,
        url: item.url,
        publishedAt: item.publishedAt,
        snippet: String(item.description || "").slice(0, 220),
        evidenceKind: item.evidenceKind || "search"
      }));
    const enrichedEvidence = await enrichRosterEvidenceDetails(evidence);
    return {
      name: team.name,
      roster: embeddedRoster,
      evidence: enrichedEvidence,
      confidence: embeddedRoster.length ? "high" : enrichedEvidence.length >= 2 ? "medium" : enrichedEvidence.length ? "low" : "missing"
    };
  }));
  const data = {
    source: "PandaScore roster payload + Bing 国内网页/RSS 阵容检索",
    updatedAt: new Date().toISOString(),
    teams: teamsWithEvidence
  };
  rosterCache.set(cacheKey, { cachedAt: now, data });
  return data;
}

function normalizeRosterTeamSelection(tournament, teams = null) {
  const allTeams = tournament.teams || [];
  if (Array.isArray(teams) && teams.length) {
    const wanted = new Set(teams.map((team) => typeof team === "string" ? team : team?.name).filter(Boolean));
    return allTeams.filter((team) => wanted.has(team.name) || wanted.has(team.id)).slice(0, 6);
  }
  const upcoming = (tournament.matches || [])
    .filter((match) => match.status !== "finished")
    .slice(0, 3)
    .flatMap((match) => match.teams || [])
    .map((id) => allTeams.find((team) => team.id === id))
    .filter(Boolean);
  const highInterest = highInterestTeamsForNews(tournament)
    .map((name) => allTeams.find((team) => team.name === name))
    .filter(Boolean);
  return [...upcoming, ...highInterest, ...allTeams]
    .filter((team, index, list) => list.findIndex((item) => item.id === team.id) === index)
    .slice(0, 8);
}

async function fetchRosterSearchItems(tournament, teams) {
  const sources = rosterSearchSources(tournament, teams);
  const [batches, tavilyItems] = await Promise.all([
    Promise.allSettled(sources.map((source) => fetchRosterSearchSource(source))),
    fetchTavilyRosterItems(tournament, teams).catch(() => [])
  ]);
  return [
    ...batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []),
    ...tavilyItems
  ];
}

async function fetchTavilyRosterItems(tournament, teams) {
  if (!process.env.TAVILY_API_KEY) return [];
  const league = leagueLabelForNews(tournament);
  const year = new Date().getFullYear();
  const missing = teams.filter((team) => !(team.roster || []).length).slice(0, 4);
  const batches = await Promise.allSettled(missing.map((team) =>
    fetchTavilySearch(`${year} ${league} ${team.name} 当前阵容 首发名单 League of Legends`, {
      searchDepth: "basic",
      maxResults: 4,
      evidenceKind: "tavily-roster"
    })
  ));
  return batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []);
}

function rosterSearchSources(tournament, teams) {
  const league = leagueLabelForNews(tournament);
  const year = new Date().getFullYear();
  const queries = new Set();
  for (const team of teams.slice(0, 8)) {
    const name = team.name;
    queries.add(`${league} ${name} ${year} 阵容 英雄联盟`);
    queries.add(`${league} ${name} 首发名单 英雄联盟`);
    queries.add(`${name} ${year} 选手名单 League of Legends`);
    if (leagueKeyFromTournament(tournament) === "lpl") {
      queries.add(`${name} 首发名单 site:lpl.qq.com`);
      queries.add(`${name} 阵容 英雄联盟 site:scoregg.com`);
      queries.add(`${name} 名单变动 英雄联盟 site:weibo.com`);
    }
  }
  return Array.from(queries).slice(0, 28).flatMap((query) => [
    {
      url: `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setlang=zh-cn&cc=CN`,
      source: `Bing网页：${query}`,
      league: leagueKeyFromTournament(tournament)
    },
    {
      url: `https://cn.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setlang=zh-cn&cc=CN`,
      source: `Bing新闻：${query}`,
      league: leagueKeyFromTournament(tournament)
    }
  ]);
}

async function fetchRosterSearchSource(source) {
  const text = await fetchText(source.url);
  return parseRssItems(text, source).map((item) => ({
    ...item,
    league: source.league,
    evidenceKind: "roster-search"
  }));
}

function rosterEvidenceScore(item, tournament, teamNameValue) {
  const text = `${item.title || ""} ${item.description || ""} ${item.url || ""}`.toLowerCase();
  if (!teamMentionedInText(teamNameValue, text)) return 0;
  if (!hasEsportsNewsContext(text, leagueKeyFromTournament(tournament))) return 0;
  const hasRosterTerm = /阵容|首发|名单|选手|大名单|注册名单|出战名单|首发阵容|roster|lineup|starter|starting/i.test(text);
  const isRosterIndexPage = /wiki\.biligame\.com\/lol|liquipedia\.net\/leagueoflegends|lol\.fandom\.com|baike\.baidu\.com/i.test(text);
  if (!hasRosterTerm && !isRosterIndexPage) return 0;
  let score = 20;
  if (hasRosterTerm) score += 40;
  if (/首发名单|首发阵容|出战名单|starting lineup/i.test(text)) score += 18;
  if (/转会|官宣|加入|离队|续约|注册|名单变动|挂牌|签约/i.test(text)) score += 18;
  if (text.includes(String(new Date().getFullYear()))) score += 14;
  if (/lpl\.qq\.com|lol\.qq\.com|scoregg\.com|weibo\.com|bilibili\.com|zhihu\.com|baijiahao\.baidu\.com/i.test(text)) score += 10;
  if (/2021|2022|2023|2024|老阵容|冠军阵容|回顾/i.test(text) && !text.includes(String(new Date().getFullYear()))) score -= 35;
  const ageDays = Math.max(0, (Date.now() - Date.parse(item.publishedAt || new Date())) / 86_400_000);
  score += Math.max(0, 18 - Math.min(ageDays, 30) * 0.6);
  return score;
}

async function enrichRosterEvidenceDetails(evidence) {
  const top = evidence.slice(0, 4);
  const enriched = await Promise.all(top.map(async (item) => {
    const detail = await fetchRosterEvidenceSnippet(item.url).catch(() => "");
    return detail ? { ...item, snippet: detail } : item;
  }));
  return [...enriched, ...evidence.slice(top.length)];
}

async function fetchRosterEvidenceSnippet(url) {
  if (!url || /weibo\.com/i.test(url)) return "";
  const html = await fetchText(url);
  const text = normalizeArticleText(stripTags(html));
  if (!text) return "";
  const rosterTerms = ["首发名单", "首发阵容", "出战名单", "注册名单", "阵容", "选手", "大名单", "roster", "lineup", "players"];
  const lower = text.toLowerCase();
  const indexes = rosterTerms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  const start = indexes.length ? Math.max(0, indexes[0] - 160) : 0;
  return text.slice(start, start + 520);
}

function normalizeArticleText(value) {
  return decodeXml(String(value || ""))
    .replace(/\{[\s\S]{0,500}?\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueEvidenceUrl(item, index, list) {
  const key = normalizeUrl(item.url) || `${item.title}:${item.source}`;
  return list.findIndex((other) => (normalizeUrl(other.url) || `${other.title}:${other.source}`) === key) === index;
}

async function getRuleResearch({ tournament, newsItems = [], refresh = false } = {}) {
  if (!tournament) return { source: "no-tournament", evidence: [], updatedAt: new Date().toISOString() };
  const cacheKey = tournament.id;
  const cached = ruleResearchCache.get(cacheKey);
  const now = Date.now();
  if (!refresh && cached && now - cached.cachedAt < RULE_RESEARCH_CACHE_TTL_MS) return cached.data;
  const sources = tournamentRuleSearchSources(tournament);
  const [batches, searchApiItems] = await Promise.all([
    Promise.allSettled(sources.map((source) => fetchRosterSearchSource(source))),
    fetchRuleSearchApiItems(tournament).catch(() => [])
  ]);
  const candidates = [
    ...batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []),
    ...searchApiItems,
    ...(newsItems || []).map((item) => ({ ...item, evidenceKind: "news-context" }))
  ]
    .map((item) => ({ ...item, score: ruleEvidenceScore(item, tournament) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter(uniqueEvidenceUrl)
    .slice(0, 10);
  const evidence = await Promise.all(candidates.map(async (item) => {
    const snippet = item.evidenceKind?.startsWith("tavily")
      ? cleanSearchSnippet(item.description, 900)
      : await fetchRuleEvidenceSnippet(item.url, item.description).catch(() => cleanSearchSnippet(item.description, 500));
    const enriched = { ...item, description: snippet };
    const sourceType = evidenceSourceType(enriched);
    const scope = evidenceScope(enriched, tournament);
    const conflictsWithBracket = evidenceBracketConflict(enriched, tournament);
    const confidence = evidenceConfidence(enriched, tournament, { sourceType, scope, conflictsWithBracket });
    const usableForRules = evidenceUsableForRules({ sourceType, scope, conflictsWithBracket, confidence });
    return {
      title: item.title,
      source: item.source,
      url: item.url,
      publishedAt: item.publishedAt || null,
      evidenceKind: item.evidenceKind || "web",
      sourceType,
      confidence,
      scope,
      conflictsWithBracket,
      usableForRules,
      snippet
    };
  }));
  const usableEvidence = evidence.filter((item) => item.usableForRules);
  const data = {
    source: "针对当前赛事动态检索的赛制、晋级与资格证据",
    provider: process.env.TAVILY_API_KEY ? "tavily" : process.env.SERPER_API_KEY ? "serper" : "web-rss",
    updatedAt: new Date().toISOString(),
    evidence,
    usableEvidenceCount: usableEvidence.length,
    highConfidenceCount: usableEvidence.filter((item) => item.confidence === "high").length,
    warning: evidence.length
      ? usableEvidence.some((item) => item.confidence === "high")
        ? ""
        : usableEvidence.length
          ? "已找到可用规则资料，但缺少高可信度的当前赛段来源，模型应保留不确定性。"
          : "搜索结果主要是观点文章、背景资料或与当前签表冲突的内容，模型不得用它们证明晋级权益。"
      : "未找到可靠的当前赛事规则证据，模型不得自行补全资格或门票结论。"
  };
  ruleResearchCache.set(cacheKey, { cachedAt: now, data });
  return data;
}

async function fetchRuleSearchApiItems(tournament) {
  const queries = tournamentRuleQueries(tournament).slice(0, 4);
  if (process.env.TAVILY_API_KEY) {
    const batches = await Promise.allSettled(queries.map((query) => fetchTavilySearch(query, {
      searchDepth: "advanced",
      maxResults: 6,
      evidenceKind: "tavily-rule"
    })));
    return batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []);
  }
  if (process.env.SERPER_API_KEY) {
    const batches = await Promise.allSettled(queries.map((query) => fetchSerperSearch(query)));
    return batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []);
  }
  return [];
}

async function fetchTavilySearch(query, options = {}) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      topic: options.topic || "general",
      search_depth: options.searchDepth || "basic",
      max_results: options.maxResults || 6,
      days: options.days,
      include_domains: options.includeDomains,
      exclude_domains: options.excludeDomains,
      include_answer: false,
      include_raw_content: false
    })
  });
  if (!response.ok) throw new Error(`Tavily search failed: ${response.status}`);
  const data = await response.json();
  return (data.results || []).map((item) => ({
    title: item.title,
    url: item.url,
    description: cleanSearchSnippet(item.content, 1200),
    source: sourceNameFromUrl(item.url),
    publishedAt: parseOptionalDate(item.published_date),
    searchScore: Number(item.score || 0),
    evidenceKind: options.evidenceKind || "tavily-search",
    queryKind: options.queryKind || null,
    searchQuery: options.searchQuery || query
  }));
}

async function fetchSerperSearch(query) {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.SERPER_API_KEY
    },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ q: query, gl: "cn", hl: "zh-cn", num: 8 })
  });
  if (!response.ok) throw new Error(`Serper search failed: ${response.status}`);
  const data = await response.json();
  return [...(data.organic || []), ...(data.news || [])].map((item) => ({
    title: item.title,
    url: item.link,
    description: item.snippet || "",
    source: sourceNameFromUrl(item.link),
    publishedAt: parseOptionalDate(item.date),
    evidenceKind: "serper-search"
  }));
}

function cleanSearchSnippet(value, limit = 900) {
  return decodeXml(stripTags(String(value || "")))
    .replace(/(?:window\.|document\.|RLCONF|wg[A-Z]\w*|function\s*\(|const\s+|var\s+)[\s\S]*/i, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function evidenceConfidence(item, tournament, metadata = {}) {
  const text = `${item.title || ""} ${item.description || ""} ${item.url || ""}`.toLowerCase();
  const source = sourceAuthorityScore(item.url, item.source);
  const currentYear = text.includes(String(new Date().getFullYear()));
  const official = source >= 4;
  const sourceType = metadata.sourceType || evidenceSourceType(item);
  const scope = metadata.scope || evidenceScope(item, tournament);
  const conflictsWithBracket = metadata.conflictsWithBracket ?? evidenceBracketConflict(item, tournament);
  if (conflictsWithBracket || sourceType === "opinion-community") return "low";
  const exactSplit = (() => {
    const expected = extractSplitNumber(`${tournament.name || ""} ${tournament.stage || ""}`);
    const actual = extractSplitNumber(text);
    return expected && actual && expected === actual;
  })();
  if ((official && currentYear) || (source >= 2 && exactSplit && currentYear && scope === "current-event")) return "high";
  if (source >= 2 || currentYear || exactSplit) return "medium";
  return "low";
}

function evidenceSourceType(item) {
  const title = String(item.title || "");
  const text = `${title} ${item.description || ""} ${item.url || ""}`.toLowerCase();
  if (/lolesports\.com|riotgames\.com|lpl\.qq\.com|lol\.qq\.com/.test(text)) return "official";
  if (/liquipedia\.net|wikipedia\.org|lol\.fandom\.com/.test(text)) return "structured-reference";
  if (isOpinionEvidence(title, text)) return "opinion-community";
  return "news-report";
}

function isOpinionEvidence(title, text = "") {
  const headline = String(title || "");
  return /前瞻|预测|看好|赔率|盘点|展望|猜想|谁能|谁会|有望|大概率|独一档|去抢吧|署名|稳了|悬念|黑马|爆冷|复仇|生死战|赛前分析|power ranking|prediction|preview|opinion/i.test(headline);
}

function evidenceUsableForRules({ sourceType, scope, conflictsWithBracket, confidence }) {
  if (conflictsWithBracket || sourceType === "opinion-community" || confidence === "low") return false;
  return scope === "current-event" || scope === "current-league-season" || scope === "international-general";
}

function evidenceBracketConflict(item, tournament) {
  if (tournament.rules?.phase !== "playoffs") return false;
  const text = `${item.title || ""} ${item.description || ""}`;
  const claimsLockedInternationalSlot = /(?:已(?:经)?|直接|提前).{0,10}(?:锁定|获得|拿到|晋级|取得|拥有|署名).{0,12}(?:msi|季中冠军赛|国际赛|门票|资格)|(?:msi|季中冠军赛|国际赛|门票|资格).{0,12}(?:已被|已经|锁定|获得|拿到|署名)/i.test(text);
  if (!claimsLockedInternationalSlot) return false;
  const currentCards = buildPlayoffView(tournament).cards || [];
  return (tournament.teams || []).some((team) => {
    if (!teamMentionedInText(team.name, text)) return false;
    return currentCards.some((card) => (
      card.status !== "finished"
      && card.bracket === "败者组"
      && [card.left, card.right].includes(team.name)
    ));
  });
}

function evidenceScope(item, tournament) {
  const text = `${item.title || ""} ${item.description || ""} ${item.url || ""}`.toLowerCase();
  const title = String(item.title || "").toLowerCase();
  if (/mid-season invitational|季中冠军赛|全球总决赛|worlds/i.test(title) && !title.includes(leagueLabelForNews(tournament).toLowerCase())) {
    return "international-general";
  }
  const tournamentText = `${tournament.name || ""} ${tournament.stage || ""}`.toLowerCase();
  const expectedSplit = extractSplitNumber(tournamentText);
  const evidenceSplit = extractSplitNumber(text);
  if (expectedSplit && evidenceSplit === expectedSplit && text.includes(leagueLabelForNews(tournament).toLowerCase())) {
    return "current-event";
  }
  if (text.includes(leagueLabelForNews(tournament).toLowerCase()) && text.includes(String(new Date().getFullYear()))) {
    return "current-league-season";
  }
  if (/msi|worlds|国际赛|季中冠军赛|全球总决赛/i.test(text)) return "international-general";
  return "background";
}

function extractSplitNumber(value) {
  const text = String(value || "").toLowerCase();
  const direct = text.match(/\bsplit\s*(\d+)\b/)?.[1] || text.match(/第\s*(\d+)\s*赛段/)?.[1];
  if (direct) return direct;
  const chinese = text.match(/第\s*([一二三四五六七八九十])\s*赛段/)?.[1];
  return {
    一: "1",
    二: "2",
    三: "3",
    四: "4",
    五: "5",
    六: "6",
    七: "7",
    八: "8",
    九: "9",
    十: "10"
  }[chinese] || null;
}

function sourceAuthorityScore(url, source = "") {
  const text = `${url || ""} ${source || ""}`.toLowerCase();
  if (/lolesports\.com|riotgames\.com|lpl\.qq\.com|lol\.qq\.com/.test(text)) return 4;
  if (/liquipedia\.net|wikipedia\.org|lol\.fandom\.com/.test(text)) return 3;
  if (/qq\.com|163\.com|sohu\.com|sina\.com|bilibili\.com|zhihu\.com|ithome\.com/.test(text)) return 2;
  return 1;
}

function tournamentRuleSearchSources(tournament) {
  return tournamentRuleQueries(tournament).flatMap((query) => [
    {
      url: `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setlang=zh-cn&cc=CN`,
      source: `Bing网页：${query}`,
      league: leagueKeyFromTournament(tournament)
    },
    {
      url: `https://cn.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setlang=zh-cn&cc=CN`,
      source: `Bing新闻：${query}`,
      league: leagueKeyFromTournament(tournament)
    }
  ]);
}

function tournamentRuleQueries(tournament) {
  const league = leagueLabelForNews(tournament);
  const year = new Date().getFullYear();
  const name = String(tournament.name || "").replace(/[·:：]/g, " ");
  const stage = tournament.rules?.phase === "playoffs" ? "季后赛" : "常规赛";
  return [
    `${year} ${name} 赛制 晋级规则`,
    `${year} ${league} ${stage} 赛制 双败 签表`,
    `${year} ${league} ${stage} 国际赛 名额 资格`,
    `${year} ${league} ${stage} MSI 门票 规则`,
    `${year} ${league} ${stage} 总决赛 晋级规则`,
    `${league} ${stage} MSI 名额`,
    `${league} ${stage} 晋级规则`,
    `${league} 总决赛 国际赛资格`,
    `${year} ${league} Split 2 playoffs MSI qualification`,
    `${year} ${league} playoffs MSI slots grand final`,
    `${year} ${league} playoff format double elimination`,
    `${league} Split 2 MSI qualification`,
    `${year} ${league} ${stage} 规则 site:lolesports.com`,
    `${year} ${league} ${stage} 规则 site:qq.com`,
    `${year} ${league} ${stage} 规则 site:weibo.com`
  ];
}

function ruleEvidenceScore(item, tournament) {
  const text = `${item.title || ""} ${item.description || ""} ${item.url || ""}`.toLowerCase();
  const league = leagueLabelForNews(tournament).toLowerCase();
  const currentYear = String(new Date().getFullYear());
  const mentionedYears = Array.from(text.matchAll(/\b20\d{2}\b/g), (match) => match[0]);
  if (mentionedYears.length && !mentionedYears.includes(currentYear)) return 0;
  const tournamentText = `${tournament.name || ""} ${tournament.stage || ""}`.toLowerCase();
  const expectedSplit = extractSplitNumber(tournamentText);
  const evidenceSplit = extractSplitNumber(text);
  if (expectedSplit && evidenceSplit && expectedSplit !== evidenceSplit) return 0;
  if (/赛事官网\s*-\s*腾讯游戏|赛事库|联赛资料|赛程时间表|league overview/i.test(text)) return 0;
  const hasLeague = text.includes(league) || (tournament.teams || []).some((team) => teamMentionedInText(team.name, text));
  if (!hasLeague || !hasEsportsNewsContext(text, leagueKeyFromTournament(tournament))) return 0;
  const ruleTerms = /赛制|规则|晋级|资格|名额|门票|双败|胜者组|败者组|总决赛|种子|format|qualification|qualify|slot|bracket|double elimination|msi|worlds/i;
  if (!ruleTerms.test(text)) return 0;
  let score = 35;
  if (text.includes(currentYear)) score += 20;
  if (/赛制|规则|资格|名额|门票|qualification|format/i.test(text)) score += 25;
  score += sourceAuthorityScore(item.url, item.source) * 8;
  score += Math.round(Number(item.searchScore || 0) * 20);
  if (expectedSplit && evidenceSplit === expectedSplit) score += 25;
  if (evidenceSourceType(item) === "opinion-community") score -= 50;
  if (evidenceBracketConflict(item, tournament)) score -= 80;
  return score;
}

async function fetchRuleEvidenceSnippet(url, fallback = "") {
  if (!url || /weibo\.com/i.test(url)) return String(fallback || "").slice(0, 500);
  const html = await fetchText(url);
  const text = normalizeArticleText(stripTags(html));
  if (!text) return String(fallback || "").slice(0, 500);
  const terms = ["赛制", "晋级", "资格", "名额", "门票", "双败", "胜者组", "败者组", "总决赛", "MSI", "qualification", "format"];
  const lower = text.toLowerCase();
  const indexes = terms.map((term) => lower.indexOf(term.toLowerCase())).filter((index) => index >= 0).sort((a, b) => a - b);
  const start = indexes.length ? Math.max(0, indexes[0] - 180) : 0;
  return text.slice(start, start + 900);
}

function buildPredictionPrompt() {
  return [
    "请基于结构化数据预测这场未赛比赛的观赛结论，输出中文，不要输出 JSON。",
    "结构必须包含：1）一句话结论，明确更看好谁；2）为什么这场值得看；3）双方胜负手；4）弱势方爆冷条件；5）不确定性。",
    "风格可以接近电竞赛前专栏/营销号标题感，但不要编造结构化数据中没有的选手数据、赔率、历史交锋或外部赛果。",
    "如果 contextGuardrail 标明是季后赛，严禁用 0-0、排名第几、小分来当预测依据；必须说清楚这是 BO 几、胜者/败者路径如何变化。",
    "涉及晋级、淘汰、决赛、国际赛门票和种子时，只能使用 ruleResearch.evidence 中 usableForRules=true 的条目，并结合完整签表判断；sourceType=opinion-community 仅可描述舆论，conflictsWithBracket=true 必须忽略。证据不足时不要自行补全规则。",
    "只有 medium/low 可信度规则证据时要保留措辞，不得宣称官方已经确认。",
    "可以引用 webContext.relatedNews 的标题作为舆论/话题度参考；如果没有相关新闻，就明确说当前网页上下文不足。",
    "可以引用 rosterContext.teams[].retrievedEvidence 的标题/摘要作为当前阵容、首发或名单变动依据。",
    "严禁凭记忆补当前选手阵容。只有 rosterContext 或 webContext.relatedNews 明确出现的选手名才可以写进预测；如果没有可靠阵容，就分析队伍路径、赛果和赛程，不要点名。",
    "如果数据不足，只能说“从当前赛程/签表/排名看”，并说明缺少哪些信息。"
  ].join("\n");
}

async function predictMatch(provider, tournament, analysis, match, newsItems, rosterData = null, ruleResearch = null) {
  const local = predictMatchLocally(tournament, analysis, match);
  if (provider === "local") return local;
  const context = buildPredictionContext(tournament, analysis, match, newsItems, rosterData, ruleResearch);
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
  const headline = sanitizeDisplayText(story.headline || "");
  const body = sanitizeDisplayText(story.body || "");
  if (!headline || !body) return null;
  const tone = story.tone === "hot" ? "hot" : "watch";
  const chips = Array.isArray(story.chips)
    ? story.chips.map((chip) => String(chip).trim()).filter(Boolean).slice(0, 4)
    : [];
  return { tone, headline, body, chips };
}

function sanitizeDisplayText(value) {
  return String(value || "")
    .replace(/按项目赛制配置[，,、\s]*/g, "")
    .replace(/官方签表尚未给出[^。；;]*[。；;]?/g, "")
    .replace(/带着[「“][^」”]+[」”]标签[，,、\s]*/g, "")
    .replace(/主动权战标签/g, "主动权")
    .replace(/本地规则引擎/g, "当前规则")
    .replace(/\s+/g, " ")
    .trim();
}

async function getNewsData({ refresh = false, tournament = null } = {}) {
  const now = Date.now();
  const creatorMode = useBilibiliCreatorNews();
  const cacheKey = creatorMode ? `bilibili:${bilibiliNewsMid()}` : tournament?.id || "global-news";
  const cached = newsCache.get(cacheKey);
  if (!refresh && cached && now - cached.cachedAt < NEWS_CACHE_TTL_MS) return cached.data;
  if (newsPending.has(cacheKey)) return newsPending.get(cacheKey);
  const pending = (async () => {
    try {
      const news = await fetchNewsItems(tournament);
      const items = news.items || [];
      const fallbackWarning = newsFallbackWarning(items);
      const proxy = proxyDiagnostics();
      const warnings = [
        fallbackWarning || (items.length
          ? ""
          : creatorMode
            ? "暂未读取到该 B 站作者的视频，请稍后刷新或检查网络。"
            : "暂未抓取到可展示的国内赛事新闻，请稍后刷新。"),
        ...proxy.warnings
      ].filter(Boolean);
      const data = {
        items,
        meta: {
          source: creatorMode
            ? "B站灯火电竞Pro个人主页视频"
            : items.length ? "玩加电竞/LPL官方/国内网页新闻" : "国内新闻源暂无可展示结果",
          warning: warnings.join("；"),
          sourceDiagnostics: news.diagnostics || [],
          proxyWarnings: proxy.warnings,
          updatedAt: new Date().toISOString()
        }
      };
      newsCache.set(cacheKey, { cachedAt: Date.now(), data });
      return data;
    } catch (error) {
      const data = {
        items: [],
        meta: {
          source: "国内新闻源暂不可用",
          warning: [`新闻源暂不可用：${error.message}`, ...proxyDiagnostics().warnings].filter(Boolean).join("；"),
          sourceDiagnostics: [],
          proxyWarnings: proxyDiagnostics().warnings,
          updatedAt: new Date().toISOString()
        }
      };
      newsCache.set(cacheKey, { cachedAt: Date.now(), data });
      return data;
    } finally {
      newsPending.delete(cacheKey);
    }
  })();
  newsPending.set(cacheKey, pending);
  return pending;
}

async function fetchNewsItems(tournament = null) {
  if (useBilibiliCreatorNews()) {
    const startedAt = Date.now();
    const items = await fetchBilibiliCreatorVideos();
    return {
      items,
      diagnostics: [{
        source: "B站个人主页实验源",
        kind: "creator",
        status: items.length ? "ok" : "empty",
        count: items.length,
        elapsedMs: Date.now() - startedAt
      }]
    };
  }
  const sources = [...newsSources(tournament), ...tournamentNewsSources(tournament)];
  const diagnostics = [];
  const [batches, tavilyResult, wanPlusSearchResult] = await Promise.all([
    Promise.allSettled(sources.map((source) => fetchNewsSourceWithDiagnostics(source))),
    fetchOptionalNewsSource("Tavily赛事搜索", "search", () => fetchTavilyNewsItems(tournament)),
    fetchOptionalNewsSource("玩加电竞搜索补充", "report-search", () => fetchWanPlusSearchNewsItems(tournament))
  ]);
  const sourceItems = [];
  for (const batch of batches) {
    if (batch.status === "fulfilled") {
      sourceItems.push(...batch.value.items);
      diagnostics.push(batch.value.diagnostic);
    } else {
      diagnostics.push({
        source: "未知新闻源",
        kind: "web",
        status: "error",
        count: 0,
        error: shortErrorMessage(batch.reason)
      });
    }
  }
  diagnostics.push(tavilyResult.diagnostic, wanPlusSearchResult.diagnostic);
  const items = [
    ...sourceItems,
    ...wanPlusSearchResult.items,
    ...tavilyResult.items
  ];
  const deduped = [];
  const seen = new Set();
  const seenTitles = new Set();
  const tournamentNames = tournament ? new Set((tournament.teams || []).map((team) => team.name)) : null;
  const scored = annotateNewsDiscussionSignals(
    items
      .map((item) => ({ ...item, relevance: newsRelevance(item, tournament, tournamentNames) }))
      .filter((item) => isUsableNewsItem(item, tournament)),
    tournament
  );
  const scoped = tournament ? scored.filter((item) => item.relevance > 0) : scored;
  const preferred = preferDomesticNewsPool(scoped, tournament);
  const pool = preferred.length ? preferred : scoped;
  const officialFillers = tournament
    ? scored.filter((item) => item.relevance <= 0 && isRecentOfficialDomesticNews(item, tournament))
    : [];
  for (const item of pool
    .sort((a, b) => newsSortScore(b, tournament) - newsSortScore(a, tournament))) {
    const key = normalizeUrl(item.url);
    const titleKey = normalizeNewsTitle(item.title).toLowerCase().replace(/\s+/g, "");
    if (!key || seen.has(key) || seenTitles.has(titleKey)) continue;
    seen.add(key);
    seenTitles.add(titleKey);
    deduped.push(item);
    if (deduped.length >= 12) break;
  }
  for (const item of officialFillers
    .sort((a, b) => newsSortScore(b, tournament) - newsSortScore(a, tournament))) {
    const key = normalizeUrl(item.url);
    const titleKey = normalizeNewsTitle(item.title).toLowerCase().replace(/\s+/g, "");
    if (!key || seen.has(key) || seenTitles.has(titleKey)) continue;
    seen.add(key);
    seenTitles.add(titleKey);
    deduped.push({ ...item, officialFiller: true });
    if (deduped.length >= 12) break;
  }
  const ranked = await rankNewsWithLlm(tournament, deduped);
  return { items: ranked, diagnostics };
}

async function fetchNewsSourceWithDiagnostics(source) {
  const startedAt = Date.now();
  try {
    const items = await fetchNewsSource(source);
    return {
      items,
      diagnostic: {
        source: source.source || sourceNameFromUrl(source.url),
        url: source.url,
        kind: source.sourceKind || "web",
        status: items.length ? "ok" : "empty",
        count: items.length,
        elapsedMs: Date.now() - startedAt
      }
    };
  } catch (error) {
    return {
      items: [],
      diagnostic: {
        source: source.source || sourceNameFromUrl(source.url),
        url: source.url,
        kind: source.sourceKind || "web",
        status: "error",
        count: 0,
        error: shortErrorMessage(error),
        elapsedMs: Date.now() - startedAt
      }
    };
  }
}

async function fetchOptionalNewsSource(source, kind, load) {
  const startedAt = Date.now();
  try {
    const items = await load();
    return {
      items,
      diagnostic: {
        source,
        kind,
        status: items.length ? "ok" : "empty",
        count: items.length,
        elapsedMs: Date.now() - startedAt
      }
    };
  } catch (error) {
    return {
      items: [],
      diagnostic: {
        source,
        kind,
        status: "error",
        count: 0,
        error: shortErrorMessage(error),
        elapsedMs: Date.now() - startedAt
      }
    };
  }
}

function useBilibiliCreatorNews() {
  return String(process.env.NEWS_MODE || "aggregate").toLowerCase() === "bilibili-creator";
}

function bilibiliNewsMid() {
  return String(process.env.BILIBILI_NEWS_MID || DEFAULT_BILIBILI_NEWS_MID).trim();
}

async function fetchBilibiliCreatorVideos() {
  const mid = bilibiliNewsMid();
  if (!mid) return [];
  const pageSize = clampNumber(process.env.BILIBILI_NEWS_LIMIT, 4, 20, 10);
  let rssError = null;
  let apiError = null;
  let searchError = null;
  let tavilyError = null;
  const rssItems = await fetchBilibiliCreatorViaRssHub(mid, pageSize).catch((error) => {
    rssError = error;
    return [];
  });
  if (rssItems.length) return rssItems;
  const searchItems = await fetchBilibiliCreatorSearchFallback(mid, pageSize).catch((error) => {
    searchError = error;
    return [];
  });
  if (searchItems.length) return searchItems;
  if (String(process.env.BILIBILI_TAVILY_FALLBACK || "0") === "1") {
    const tavilyItems = await fetchBilibiliCreatorViaTavily(mid, pageSize).catch((error) => {
      tavilyError = error;
      return [];
    });
    if (tavilyItems.length) return tavilyItems;
  }
  try {
    const data = await fetchBilibiliCreatorData(mid, pageSize);
    const videos = data?.data?.list?.vlist || data?.data?.list?.archives || data?.data?.archives || [];
    const normalized = videos
      .map(normalizeBilibiliVideo)
      .filter(Boolean)
      .slice(0, pageSize);
    return normalized.length ? normalized : bilibiliCreatorFallbackItem(mid, { rssError, searchError, tavilyError, apiError: new Error("Bilibili API returned empty video list") });
  } catch (error) {
    apiError = error;
    return bilibiliCreatorFallbackItem(mid, { rssError, searchError, tavilyError, apiError });
  }
}

async function fetchBilibiliCreatorViaRssHub(mid, pageSize) {
  const bases = csv(process.env.RSSHUB_BASE_URLS || process.env.RSSHUB_BASE_URL || "https://rsshub.app");
  const source = process.env.BILIBILI_NEWS_SOURCE_NAME || "灯火电竞Pro";
  let lastError = null;
  for (const base of bases) {
    try {
      const feedUrl = `${String(base).replace(/\/$/, "")}/bilibili/user/video/${encodeURIComponent(mid)}`;
      const xml = await fetchText(feedUrl, { timeoutMs: Number(process.env.RSSHUB_TIMEOUT_MS || 20000) });
      const items = parseRssItems(xml, { source, league: "global", sourceKind: "creator" })
        .map((item) => ({
          ...item,
          source,
          league: "global",
          sourceKind: "creator",
          image: item.image || imageFromBilibiliRssDescription(item.description) || generatedNewsCoverUrl({ title: item.title, source }, null)
        }))
        .filter((item) => item.title && normalizeUrl(item.url))
        .slice(0, pageSize);
      if (items.length) return items;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("RSSHub Bilibili feed unavailable");
}

async function fetchBilibiliCreatorSearchFallback(mid, pageSize) {
  const source = process.env.BILIBILI_NEWS_SOURCE_NAME || "灯火电竞Pro";
  const query = process.env.BILIBILI_NEWS_SEARCH_QUERY || source;
  const endpoint = new URL("https://api.bilibili.com/x/web-interface/search/type");
  endpoint.searchParams.set("search_type", "video");
  endpoint.searchParams.set("keyword", query);
  endpoint.searchParams.set("order", "pubdate");
  endpoint.searchParams.set("page", "1");
  endpoint.searchParams.set("page_size", String(pageSize));
  const data = await fetchBilibiliJson(endpoint.toString(), mid);
  const results = data?.data?.result || [];
  const normalized = results
    .map((video) => normalizeBilibiliSearchVideo(video, source))
    .filter(Boolean)
    .filter((item) => bilibiliSearchItemMatchesCreator(item, source))
    .slice(0, pageSize);
  if (!normalized.length) throw new Error("Bilibili search returned empty video list");
  return normalized;
}

async function fetchBilibiliCreatorViaTavily(mid, pageSize) {
  if (!process.env.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY is not configured");
  const source = process.env.BILIBILI_NEWS_SOURCE_NAME || "灯火电竞Pro";
  const query = process.env.BILIBILI_TAVILY_QUERY || `"${source}" 英雄联盟 LPL 电竞 site:bilibili.com/video`;
  const results = await fetchTavilySearch(query, {
    topic: "general",
    searchDepth: "basic",
    maxResults: Math.max(8, pageSize),
    days: 30,
    includeDomains: ["bilibili.com"],
    evidenceKind: "bilibili-creator-tavily",
    queryKind: "creator"
  });
  const items = results
    .map((item) => normalizeBilibiliTavilyVideo(item, source))
    .filter(Boolean)
    .filter((item) => bilibiliTavilyItemLooksRelevant(item, source))
    .slice(0, pageSize);
  if (!items.length) throw new Error("Tavily did not find usable Bilibili creator videos");
  return items;
}

function normalizeBilibiliTavilyVideo(item, source) {
  const url = normalizeUrl(item.url);
  const title = normalizeNewsTitle(item.title || "");
  if (!title || !/bilibili\.com\/video\//i.test(url)) return null;
  return {
    title,
    url,
    description: stripTags(item.description || ""),
    image: generatedNewsCoverUrl({ title, source }, null),
    source,
    league: "global",
    sourceKind: "creator-search-web",
    publishedAt: item.publishedAt || null,
    searchScore: item.searchScore || 0
  };
}

function bilibiliTavilyItemLooksRelevant(item, source) {
  const title = String(item.title || "");
  const text = `${item.title || ""} ${item.description || ""} ${item.url || ""}`;
  const normalizedTitle = normalizeCreatorName(title);
  const expected = normalizeCreatorName(source);
  if (normalizedTitle.includes(expected)) return true;
  if (/万家灯火|背后还有|不能输|放手一搏|杰克/i.test(text)) return false;
  return false;
}

function bilibiliSearchItemMatchesCreator(item, source) {
  if (String(process.env.BILIBILI_NEWS_STRICT_CREATOR || "1") === "0") return true;
  const expected = normalizeCreatorName(source);
  const text = normalizeCreatorName(`${item.source || ""} ${item.title || ""} ${item.description || ""}`);
  return text.includes(expected);
}

function normalizeCreatorName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[\s_\-·.。・]+/g, "")
    .trim();
}

function imageFromBilibiliRssDescription(description) {
  return resolveBilibiliImage(attrValue(description, /<img\b[^>]*src=["']([^"']+)["']/i));
}

async function fetchBilibiliCreatorData(mid, pageSize) {
  const endpoints = [
    new URL("https://api.bilibili.com/x/space/arc/search"),
    new URL("https://api.bilibili.com/x/space/wbi/arc/search")
  ];
  for (const endpoint of endpoints) {
    endpoint.searchParams.set("mid", mid);
    endpoint.searchParams.set("ps", String(pageSize));
    endpoint.searchParams.set("tid", "0");
    endpoint.searchParams.set("pn", "1");
    endpoint.searchParams.set("keyword", "");
    endpoint.searchParams.set("order", "pubdate");
    endpoint.searchParams.set("platform", "web");
    endpoint.searchParams.set("web_location", "1550101");
    endpoint.searchParams.set("jsonp", "jsonp");
  }
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      return await fetchBilibiliJson(endpoint.toString(), mid);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Bilibili API unavailable");
}

async function fetchBilibiliJson(url, mid = bilibiliNewsMid()) {
  const cookie = String(process.env.BILIBILI_COOKIE || "").trim();
  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    origin: "https://space.bilibili.com",
    referer: `https://space.bilibili.com/${mid}/video`,
    "sec-ch-ua": "\"Chromium\";v=\"125\", \"Not.A/Brand\";v=\"24\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent": process.env.BILIBILI_USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
  };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Bilibili request failed: ${response.status}`);
  const data = await response.json();
  if (data?.code && data.code !== 0) throw new Error(`Bilibili API returned ${data.code}: ${data.message || "unknown"}`);
  return data;
}

function bilibiliCreatorFallbackItem(mid = bilibiliNewsMid(), diagnostics = {}) {
  const source = process.env.BILIBILI_NEWS_SOURCE_NAME || "灯火电竞Pro";
  const diagnosticsText = bilibiliNewsDiagnostics(diagnostics);
  return [{
    title: `${source} B站主页`,
    url: `https://space.bilibili.com/${encodeURIComponent(mid)}/video`,
    description: diagnosticsText
      ? `B站投稿列表暂时没有读到：${diagnosticsText}。点击进入作者主页查看最新视频。`
      : "B站接口暂时未返回投稿列表，点击进入作者主页查看最新视频。",
    image: generatedNewsCoverUrl({ title: `${source} 最新视频`, source }, null),
    source,
    league: "global",
    sourceKind: "creator",
    fallback: true,
    warning: diagnosticsText ? `B站投稿读取失败：${diagnosticsText}` : "B站投稿读取失败",
    publishedAt: null
  }];
}

function newsFallbackWarning(items) {
  const fallback = (items || []).find((item) => item?.fallback && item?.warning);
  return fallback ? fallback.warning : "";
}

function bilibiliNewsDiagnostics({ rssError = null, searchError = null, tavilyError = null, apiError = null } = {}) {
  return [
    rssError ? `RSSHub ${shortErrorMessage(rssError)}` : "",
    searchError ? `B站搜索 ${shortErrorMessage(searchError)}` : "",
    tavilyError ? `Tavily搜索 ${shortErrorMessage(tavilyError)}` : "",
    apiError ? `B站官方接口 ${shortErrorMessage(apiError)}` : ""
  ].filter(Boolean).join("；");
}

function shortErrorMessage(error) {
  const message = error?.message || String(error || "unknown error");
  return message.replace(/\s+/g, " ").slice(0, 180);
}

function normalizeBilibiliVideo(video) {
  const bvid = video.bvid || video.bvid_str;
  const aid = video.aid || video.aid_str;
  const title = normalizeNewsTitle(video.title || video.name);
  if (!title || (!bvid && !aid)) return null;
  const url = bvid
    ? `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`
    : `https://www.bilibili.com/video/av${encodeURIComponent(aid)}`;
  const pic = resolveBilibiliImage(video.pic || video.cover);
  const created = Number(video.created || video.pubdate || video.ctime || 0);
  return {
    title,
    url,
    description: stripTags(video.description || video.desc || ""),
    image: pic || generatedNewsCoverUrl({ title, source: "灯火电竞Pro" }, null),
    source: process.env.BILIBILI_NEWS_SOURCE_NAME || "灯火电竞Pro",
    league: "global",
    sourceKind: "creator",
    publishedAt: created ? new Date(created * 1000).toISOString() : null,
    viewCount: Number(video.play || video.stat?.view || 0),
    commentCount: Number(video.comment || video.stat?.reply || 0)
  };
}

function normalizeBilibiliSearchVideo(video, source) {
  const title = normalizeNewsTitle(stripTags(video.title || video.name || ""));
  const bvid = video.bvid || video.id;
  const aid = video.aid;
  if (!title || (!bvid && !aid)) return null;
  const url = bvid
    ? `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`
    : `https://www.bilibili.com/video/av${encodeURIComponent(aid)}`;
  const publishedAt = Number(video.pubdate || video.senddate || 0);
  return {
    title,
    url,
    description: stripTags(video.description || ""),
    image: resolveBilibiliImage(video.pic || video.cover) || generatedNewsCoverUrl({ title, source }, null),
    source: video.author || source,
    league: "global",
    sourceKind: "creator-search",
    publishedAt: publishedAt ? new Date(publishedAt * 1000).toISOString() : null,
    viewCount: Number(video.play || 0),
    commentCount: Number(video.review || 0)
  };
}

function resolveBilibiliImage(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("http://")) return value.replace(/^http:\/\//i, "https://");
  return resolveUrl(value, "https://www.bilibili.com/");
}

function preferDomesticNewsPool(items, tournament) {
  if (!tournament) return items;
  const domestic = items.filter(isDomesticReachableNewsItem);
  if (leagueKeyFromTournament(tournament) === "lpl") {
    return domestic.length >= 3 ? domestic : items.filter((item) => !isHardBlockedForeignNews(item));
  }
  return domestic.length >= 5 ? domestic : items.filter((item) => !isHardBlockedForeignNews(item));
}

async function fetchTavilyNewsItems(tournament) {
  if (!process.env.TAVILY_API_KEY || !tournament) return [];
  const league = leagueLabelForNews(tournament);
  const stage = tournament.rules?.phase === "playoffs" ? "季后赛" : "常规赛";
  const queries = tavilyNewsQueries(tournament);
  const batches = await Promise.allSettled(queries.map(({ query, queryKind, topic = queryKind === "match" ? "general" : "news" }) => fetchTavilySearch(query, {
    topic,
    searchDepth: queryKind === "match" ? "advanced" : "basic",
    maxResults: 7,
    days: 21,
    evidenceKind: "tavily-news",
    queryKind,
    searchQuery: query
  })));
  const items = batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []);
  const relevant = items
    .filter((item) => strictSearchNewsScope(item, tournament))
    .sort((a, b) => Number(b.searchScore || 0) - Number(a.searchScore || 0))
    .slice(0, 24);
  return Promise.all(relevant.map(async (item) => ({
    ...item,
    league: leagueKeyFromTournament(tournament),
    sourceKind: "search",
    image: await fetchArticleImage(item.url).catch(() => "") || generatedNewsCoverUrl(item, tournament)
  })));
}

async function fetchWanPlusSearchNewsItems(tournament = null) {
  if (!process.env.TAVILY_API_KEY) return [];
  const league = leagueLabelForNews(tournament);
  const stage = tournament?.rules?.phase === "playoffs" ? "季后赛" : "淘汰赛";
  const year = new Date().getFullYear();
  const queries = [
    `${year} ${league} ${stage} 玩加电竞 战报 LPL site:wanplus.cn`,
    `${year} LPL 第二赛段 淘汰赛 战报 玩加电竞 site:wanplus.cn`,
    `${year} LPL 季后赛 战报 零封 晋级 玩加电竞 site:wanplus.cn`
  ];
  const batches = await Promise.allSettled(queries.map((query) => fetchTavilySearch(query, {
    topic: "general",
    searchDepth: "basic",
    maxResults: 6,
    days: 14,
    includeDomains: ["wanplus.cn", "m.wanplus.cn"],
    evidenceKind: "wanplus-search",
    queryKind: "report",
    searchQuery: query
  })));
  const seen = new Set();
  const items = batches
    .flatMap((batch) => batch.status === "fulfilled" ? batch.value : [])
    .map((item) => normalizeWanPlusSearchItem(item, tournament))
    .filter(Boolean)
    .filter((item) => {
      const key = normalizeUrl(item.url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
  return Promise.all(items.map(async (item) => ({
    ...item,
    image: await fetchArticleImage(item.url).catch(() => "") || generatedNewsCoverUrl(item, tournament)
  })));
}

function normalizeWanPlusSearchItem(item, tournament = null) {
  const url = normalizeUrl(item.url);
  const title = normalizeNewsTitle(item.title || "");
  const text = `${title} ${item.description || ""} ${url}`;
  if (!/wanplus\.cn/i.test(url)) return null;
  if (!/战报|零封|晋级|挺进|击败|战胜|横扫|让二追三|LPL|英雄联盟/i.test(text)) return null;
  if (/登录|注册|下载|竞猜|广告|直播|赛程表|数据库/i.test(text)) return null;
  return {
    title,
    url,
    description: cleanSearchSnippet(item.description || title, 240),
    image: "",
    source: "玩加电竞",
    league: leagueKeyFromTournament(tournament) === "global" ? "lpl" : leagueKeyFromTournament(tournament),
    sourceKind: "report-search",
    publishedAt: item.publishedAt || null,
    searchScore: Number(item.searchScore || 0) + 1.5,
    searchQuery: item.searchQuery || ""
  };
}

function tavilyNewsQueries(tournament) {
  const league = leagueLabelForNews(tournament);
  const leagueAlias = leagueSearchAlias(tournament);
  const stage = tournament.rules?.phase === "playoffs" ? "季后赛" : "常规赛";
  const year = new Date().getFullYear();
  const eventName = String(tournament.name || "").replace(/[·:：]/g, " ").replace(/\s+/g, " ").trim();
  const eventStage = String(tournament.stage || stage).trim();
  const queries = [
    { query: `${eventName} ${eventStage} League of Legends latest news results`, queryKind: "event", topic: "general" },
    { query: `${year} ${league} ${stage} 英雄联盟 最新赛果 焦点`, queryKind: "league" },
    { query: `${year} ${leagueAlias} ${stage} League of Legends esports latest results playoffs`, queryKind: "league" },
    { query: `${year} ${league} ${stage} 英雄联盟 热门讨论 前瞻`, queryKind: "discussion", topic: "general" }
  ];
  if (leagueKeyFromTournament(tournament) === "lpl") {
    queries.push(
      { query: `${year} 灯火电竞pro LPL 英雄联盟 季后赛`, queryKind: "creator", topic: "general" },
      { query: `${year} LPL 英雄联盟 季后赛 site:bilibili.com/video`, queryKind: "creator", topic: "general" }
    );
  }
  const matches = [
    ...(tournament.matches || []).filter((match) => match.status !== "finished").slice(0, 3),
    ...(tournament.matches || []).filter((match) => match.status === "finished").slice(-2).reverse()
  ];
  for (const match of matches) {
    const left = teamName(tournament, match.teams[0]);
    const right = teamName(tournament, match.teams[1]);
    const leftSearch = teamSearchName(left);
    const rightSearch = teamSearchName(right);
    queries.push({
      query: `${eventName} ${leftSearch} vs ${rightSearch} League of Legends ${match.status === "finished" ? "result recap" : "preview"}`,
      queryKind: "match"
    });
  }
  for (const team of highInterestTeamsForNews(tournament).slice(0, 2)) {
    queries.push({ query: `${eventName} ${teamSearchName(team)} League of Legends latest news`, queryKind: "team" });
  }
  return queries
    .filter((item, index, list) => list.findIndex((other) => other.query === item.query) === index)
    .slice(0, 8);
}

function teamSearchName(team) {
  const aliases = audienceProfile(team).aliases || [];
  return [String(team || ""), ...aliases]
    .sort((a, b) => String(b).length - String(a).length)[0];
}

function leagueSearchAlias(tournament) {
  return {
    lpl: "LPL China",
    lck: "LCK Korea",
    lec: "LEC EMEA",
    lcs: "LCS North America",
    lcp: "LCP League of Legends Championship Pacific"
  }[leagueKeyFromTournament(tournament)] || leagueLabelForNews(tournament);
}

function newsSources(tournament = null) {
  const configured = csv(process.env.NEWS_FEEDS);
  if (configured.length) return configured.map((url) => ({ url, source: sourceNameFromUrl(url), league: "custom" }));
  const league = leagueKeyFromTournament(tournament);
  const tencentPages = [1, 2, 3].map((page) =>
    `https://apps.game.qq.com/wmp/v3.1/?p0=3&p1=searchNewsKeywordsList&page=${page}&pagesize=16&order=sIdxTime&r0=script&r1=NewsObj&type=iTarget&id=30,35,36&source=web_pc`
  );
  const sources = [
    { url: "https://lolesports.com/zh-CN/news", source: "LoL Esports 中文官网", league: "global" },
    { url: "https://surrenderat20.net/index.html/feed", source: "Surrender@20", league: "global" },
    { url: "https://www.dexerto.com/league-of-legends/feed/", source: "Dexerto", league: "global" },
    { url: "https://esports.gg/news/league-of-legends/feed/", source: "Esports.gg", league: "global" }
  ];
  if (!tournament || league === "lpl") {
    sources.unshift(
      { url: "https://m.wanplus.cn/lol", source: "玩加电竞", league: "lpl", sourceKind: "report" },
      { url: "https://wanplus.cn/lol", source: "玩加电竞", league: "lpl", sourceKind: "report" },
      ...tencentPages.map((url) => ({ url, source: "LPL赛事官网", league: "lpl" })),
      { url: "https://lpl.qq.com/es/news.shtml", source: "LPL赛事官网", league: "lpl" },
      { url: "https://lol.qq.com/main.shtml", source: "英雄联盟官网", league: "lpl" },
      { url: "https://www.scoregg.com/", source: "ScoreGG", league: "lpl" },
      { url: "https://www.hupu.com/tag/309", source: "虎扑LOL专区", league: "lpl" },
      { url: "https://lol.duowan.com/", source: "多玩LOL专区", league: "lpl" },
      { url: "https://lol.178.com/", source: "178LOL专区", league: "lpl" }
    );
  }
  return sources;
}

function tournamentNewsSources(tournament) {
  if (!tournament) return [];
  const league = leagueKeyFromTournament(tournament);
  return tournamentNewsQueries(tournament).flatMap((query) => [
    {
      url: `https://cn.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setlang=zh-cn&cc=CN`,
      source: `Bing新闻：${query}`,
      league
    },
    {
      url: `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setlang=zh-cn&cc=CN`,
      source: `Bing网页：${query}`,
      league
    }
  ]);
}

function tournamentNewsQueries(tournament) {
  const league = leagueLabelForNews(tournament);
  const stage = tournament.rules?.phase === "playoffs" ? "季后赛" : "常规赛";
  const domesticSites = [
    "site:zhihu.com",
    "site:bilibili.com/read",
    "site:baijiahao.baidu.com",
    "site:hupu.com",
    "site:weibo.com",
    "site:qq.com",
    "site:163.com",
    "site:sohu.com",
    "site:sina.com.cn",
    "site:duowan.com",
    "site:178.com",
    "site:lolking.net"
  ];
  if (leagueKeyFromTournament(tournament) === "lpl") {
    domesticSites.unshift("site:m.wanplus.cn", "site:wanplus.cn", "site:lpl.qq.com", "site:lol.qq.com", "site:scoregg.com");
  } else {
    domesticSites.unshift(
      "site:lolesports.com",
      "site:invenglobal.com",
      "site:dexerto.com",
      "site:esports.gg"
    );
  }
  const queries = new Set([
    `${league} ${stage} 英雄联盟 最新`,
    `${league} ${stage} 英雄联盟 热门`,
    `${league} ${stage} 晋级形势`,
    `${league} ${stage} 电竞 自媒体`,
    `${league} ${stage} 赛前 前瞻`,
    `${league} ${stage} 当前阵容`,
    `${league} ${stage} 首发名单`,
    `${league} ${stage} 比赛结果`,
    `${league} ${stage} 赛后分析`,
    `${league} ${stage} 选手采访`,
    `${league} ${stage} 转会消息`,
    `${league} ${stage} 阵容变动`,
    `${league} ${stage} 战术分析`,
    `${league} 焦点战`,
    `${league} 爆冷`,
    `${league} 黑马`,
    `${league} MVP`,
    `${league} 最佳阵容`,
    `${league} 数据统计`,
    `${league} 版本更新`,
    `${league} 赛事看点`,
    `${league} 回顾总结`
  ]);
  for (const site of domesticSites) {
    queries.add(`${league} ${stage} 英雄联盟 ${site}`);
  }
  for (const team of highInterestTeamsForNews(tournament).slice(0, 5)) {
    queries.add(`${league} ${team} 英雄联盟 最新`);
    queries.add(`${league} ${team} 当前阵容 英雄联盟`);
    queries.add(`${league} ${team} 首发名单 英雄联盟`);
    queries.add(`${league} ${team} 名单变动 英雄联盟`);
    queries.add(`${league} ${team} 赛前 前瞻 site:zhihu.com`);
    queries.add(`${league} ${team} 英雄联盟 site:bilibili.com/read`);
    queries.add(`${league} ${team} 英雄联盟 site:bilibili.com/video`);
    queries.add(`${league} ${team} 英雄联盟 site:baijiahao.baidu.com`);
    queries.add(`${league} ${team} 英雄联盟 site:hupu.com`);
    queries.add(`${league} ${team} 比赛分析`);
    queries.add(`${league} ${team} 赛后总结`);
    queries.add(`${league} ${team} 选手状态`);
  }
  const openMatches = (tournament.matches || [])
    .filter((match) => match.status !== "finished")
    .slice(0, 3);
  for (const match of openMatches) {
    const left = teamName(tournament, match.teams[0]);
    const right = teamName(tournament, match.teams[1]);
    queries.add(`${league} ${left} ${right} 预测 英雄联盟`);
    queries.add(`${left} ${right} ${stage} 英雄联盟`);
    queries.add(`${left} ${right} 首发名单 英雄联盟`);
    queries.add(`${left} ${right} 英雄联盟 site:zhihu.com`);
    queries.add(`${left} ${right} 英雄联盟 site:bilibili.com/read`);
    queries.add(`${left} ${right} 英雄联盟 site:bilibili.com/video`);
    queries.add(`${left} ${right} 英雄联盟 site:baijiahao.baidu.com`);
    if (leagueKeyFromTournament(tournament) === "lpl") queries.add(`${left} ${right} 英雄联盟 site:scoregg.com`);
  }
  return Array.from(queries).slice(0, 30);
}

function highInterestTeamsForNews(tournament = null) {
  const teams = (tournament?.teams || []).map((team) => team.name);
  const priorityByLeague = {
    lck: ["T1", "GEN", "HLE", "DK", "KT"],
    lec: ["G2", "KC", "FNC", "MKOI", "VIT"],
    lcs: ["C9", "TL", "FLY", "100T"],
    lcp: ["PSG", "CFO", "GAM"]
  };
  const priority = priorityByLeague[leagueKeyFromTournament(tournament)] || [];
  return [
    ...priority.filter((name) => teams.some((team) => teamMentionedInText(name, team))),
    ...teams
  ].filter(uniqueLabel);
}

function leagueKeyFromTournament(tournament = null) {
  const text = `${tournament?.id || ""} ${tournament?.name || ""} ${tournament?.region || ""}`.toLowerCase();
  if (/\blpl\b|china|中国/.test(text)) return "lpl";
  if (/\blck\b|korea|韩国/.test(text)) return "lck";
  if (/\blec\b|emea|europe|欧洲/.test(text)) return "lec";
  if (/\blcs\b|north america|北美|美洲/.test(text)) return "lcs";
  if (/\blcp\b|pacific|pcs|vcs|ljl|亚太/.test(text)) return "lcp";
  return "global";
}

function leagueLabelForNews(tournament = null) {
  const key = leagueKeyFromTournament(tournament);
  const labels = {
    lpl: "LPL",
    lck: "LCK",
    lec: "LEC",
    lcs: "LCS",
    lcp: "LCP"
  };
  return labels[key] || String(tournament?.name || "").split(/[ ·:：\s]+/)[0] || "英雄联盟赛事";
}

async function fetchNewsSource(source) {
  const text = await fetchText(source.url);
  const tencentItems = parseTencentWmpNews(text, source);
  const rssItems = tencentItems.length ? [] : parseRssItems(text, source);
  const items = rssItems.length ? rssItems : [
    ...tencentItems,
    ...parseWanPlusNewsLinks(text, source),
    ...parseSheepEsportsLinks(text, source),
    ...parseLoLEsportsNews(text, source),
    ...parseGenericNewsLinks(text, source)
  ];
  const enriched = [];
  for (const item of items.slice(0, 5)) {
    const image = item.image || await fetchArticleImage(item.url).catch(() => null);
    enriched.push({
      ...item,
      league: item.league || source.league || "global",
      sourceKind: item.sourceKind || source.sourceKind || "web",
      image: image || generatedNewsCoverUrl(item, null)
    });
  }
  return enriched;
}

function parseWanPlusNewsLinks(html, source) {
  if (!/wanplus\.cn/i.test(source.url || "")) return [];
  const normalized = String(html || "")
    .replace(/\\"/g, "\"")
    .replace(/\\\//g, "/")
    .replace(/&quot;/g, "\"");
  const merged = [];
  const seenMerged = new Set();
  const pushItems = (items) => {
    for (const item of items) {
      const key = normalizeUrl(item.url) || normalizeNewsTitle(item.title);
      if (!key || seenMerged.has(key)) continue;
      seenMerged.add(key);
      merged.push(item);
      if (merged.length >= 12) break;
    }
  };
  pushItems(parseWanPlusAnchorNews(normalized, source));
  const items = [];
  const seen = new Set();
  const titlePattern = /(?:title=["']([^"']*(?:战报|LPL|英雄联盟|季后赛|淘汰赛)[^"']*)["']|>([^<>]*(?:战报|LPL|英雄联盟|季后赛|淘汰赛)[^<>]*)<)/gi;
  for (const match of normalized.matchAll(titlePattern)) {
    const title = normalizeNewsTitle(decodeXml(stripTags(match[1] || match[2] || "")));
    if (!title || !looksLikeWanPlusReportTitle(title)) continue;
    const index = match.index || 0;
    const start = Math.max(0, index - 3000);
    const chunk = normalized.slice(start, Math.min(normalized.length, index + 2200));
    const href = nearestWanPlusHref(chunk, index - start);
    const url = resolveWanPlusUrl(href);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const image = resolveWanPlusImage(nearestImageSrc(chunk));
    items.push({
      title,
      url,
      description: title,
      image,
      source: source.source || "玩加电竞",
      league: source.league || "lpl",
      sourceKind: "report",
      publishedAt: parseWanPlusRelativeTime(chunk)
    });
    if (items.length >= 12) break;
  }
  pushItems(items);
  return merged;
}

function parseWanPlusAnchorNews(html, source) {
  const items = [];
  const seen = new Set();
  const anchorPattern = /<a\b([^>]*\bhref=["'][^"']+["'][^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchorPattern)) {
    const attrs = match[1] || "";
    const inner = match[2] || "";
    const title = normalizeNewsTitle(decodeXml(stripTags(attrValue(attrs, /\btitle=["']([^"']+)["']/i) || inner)));
    if (!title || !looksLikeWanPlusReportTitle(title)) continue;
    const href = attrValue(attrs, /\bhref=["']([^"']+)["']/i);
    const url = resolveWanPlusUrl(href);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const index = match.index || 0;
    const block = wanPlusCardBlock(html, index);
    const image = resolveWanPlusImage(nearestImageSrc(block));
    items.push({
      title,
      url,
      description: title,
      image,
      source: source.source || "玩加电竞",
      league: source.league || "lpl",
      sourceKind: "report",
      publishedAt: parseWanPlusRelativeTime(block)
    });
    if (items.length >= 12) break;
  }
  return items;
}

function wanPlusCardBlock(html, index) {
  const text = String(html || "");
  const before = text.slice(0, index);
  const after = text.slice(index);
  const starts = [
    before.lastIndexOf("<li"),
    before.lastIndexOf("<article"),
    before.lastIndexOf("<div")
  ].filter((value) => value >= 0);
  const start = starts.length ? Math.max(...starts) : Math.max(0, index - 1800);
  const endCandidates = ["</li>", "</article>", "</div>"]
    .map((token) => {
      const position = after.indexOf(token);
      return position >= 0 ? index + position + token.length : -1;
    })
    .filter((value) => value > index);
  const end = endCandidates.length ? Math.min(...endCandidates) : Math.min(text.length, index + 1800);
  return text.slice(start, end);
}

function looksLikeWanPlusReportTitle(title) {
  const text = String(title || "");
  if (text.length < 8 || text.length > 80) return false;
  if (/登录|注册|下载|竞猜|广告|全部|更多|视频|直播/.test(text)) return false;
  return /战报|零封|晋级|挺进|击败|战胜|横扫|让二追三|LPL|英雄联盟|季后赛|淘汰赛/i.test(text);
}

function nearestWanPlusHref(chunk, pivot = 0) {
  const candidates = Array.from(String(chunk || "").matchAll(/href=["']([^"']+)["']/gi))
    .map((match) => ({
      href: decodeXml(match[1]),
      distance: Math.abs((match.index || 0) - pivot)
    }))
    .filter((item) => /(?:article|news|lol|post|detail|match|\/\d{4,})/i.test(item.href))
    .sort((a, b) => a.distance - b.distance);
  return candidates[0]?.href || "";
}

function resolveWanPlusUrl(href) {
  const url = resolveUrl(href, "https://m.wanplus.cn/lol");
  if (!url || !/wanplus\.cn/i.test(url)) return "";
  return url;
}

function nearestImageSrc(chunk) {
  const value = String(chunk || "");
  const images = [
    ...Array.from(value.matchAll(/<img\b[^>]*(?:data-original|data-src|data-lazy-src|data-url|original|_src|src)=["']([^"']+)["'][^>]*>/gi)),
    ...Array.from(value.matchAll(/(?:cover|image|img|thumb|thumbnail|pic|photo|src|url)["']?\s*[:=]\s*["']([^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?)["']/gi)),
    ...Array.from(value.matchAll(/background(?:-image)?\s*:\s*url\((["']?)([^"')]+)\1\)/gi)).map((match) => [match[0], match[2]]),
    ...Array.from(value.matchAll(/srcset=["']([^"']+)["']/gi)).map((match) => [match[0], String(match[1] || "").split(/\s*,\s*/)[0]?.split(/\s+/)[0] || ""])
  ]
    .map((match) => decodeXml(match[1]))
    .map((src) => src.replace(/\\\//g, "/"))
    .filter(Boolean)
    .filter((src) => /\.(?:jpg|jpeg|png|webp)(?:\?|$)/i.test(src))
    .filter((src) => !/logo|avatar|icon|sprite|blank|default|loading|placeholder/i.test(src));
  return images[images.length - 1] || images[0] || "";
}

function resolveWanPlusImage(src) {
  const value = String(src || "").trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("http://")) return value.replace(/^http:\/\//i, "https://");
  return resolveUrl(value, "https://m.wanplus.cn/");
}

function parseWanPlusRelativeTime(chunk) {
  const text = stripTags(String(chunk || "")).replace(/\s+/g, " ");
  const relative = text.match(/(\d+)\s*(分钟|小时|天|周)前|刚刚|昨天/u);
  if (!relative) return null;
  const now = Date.now();
  if (relative[0] === "刚刚") return new Date(now).toISOString();
  if (relative[0] === "昨天") return new Date(now - 86_400_000).toISOString();
  const amount = Number(relative[1] || 0);
  const unit = relative[2];
  const factor = unit === "分钟" ? 60_000 : unit === "小时" ? 3_600_000 : unit === "天" ? 86_400_000 : 7 * 86_400_000;
  return amount ? new Date(now - amount * factor).toISOString() : null;
}

function parseTencentWmpNews(script, source) {
  const match = String(script || "").match(/var\s+NewsObj\s*=\s*(\{[\s\S]*?\});?\s*$/);
  if (!match) return [];
  try {
    const json = JSON.parse(match[1]);
    const result = Array.isArray(json?.msg?.result) ? json.msg.result : [];
    return result.map((item) => {
      const redirect = String(item.sRedirectURL || "").trim();
      const docid = item.iDocID || item.iNewsId;
      const url = redirect
        ? addQueryParam(resolveUrl(redirect, "https://lpl.qq.com/"), "docid", docid)
        : `https://lol.qq.com/news/detail.shtml?type=1&docid=${encodeURIComponent(docid || "")}`;
      const cover = item.sIMG || item.sCoverList?.find((coverItem) => coverItem?.url)?.url || "";
      return {
        title: normalizeNewsTitle(item.sTitle),
        url,
        description: stripTags(item.sDesc || item.sIntro || ""),
        image: resolveProtocolUrl(cover),
        source: "LPL赛事官网",
        league: "lpl",
        sourceKind: "official",
        publishedAt: parseNewsDate(item.sTargetIdxTime || item.sIdxTime)
      };
    }).filter((item) => item.title && item.url);
  } catch {
    return [];
  }
}

function parseSheepEsportsLinks(html, source) {
  if (!/sheepesports\.com/i.test(source.url || "")) return [];
  const seen = new Set();
  const items = [];
  const linkPattern = /href="(\/en\/all\/articles\/([^"\/]+)\/en)"/g;
  for (const match of String(html || "").matchAll(linkPattern)) {
    const path = match[1];
    const slug = match[2];
    if (!slug || seen.has(path)) continue;
    seen.add(path);
    const title = titleFromSlug(slug);
    items.push({
      title,
      url: `https://www.sheepesports.com${path}`,
      description: title,
      image: "",
      source: "Sheep Esports",
      league: "global",
      sourceKind: "editorial",
      publishedAt: null
    });
    if (items.length >= 16) break;
  }
  return items;
}

function titleFromSlug(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (/^(a|an|the|to|with|from|for|and|or|of|in|on|after|before|without)$/.test(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ")
    .replace(/\bmsi\b/ig, "MSI")
    .replace(/\bt1\b/ig, "T1")
    .replace(/\blck\b/ig, "LCK")
    .replace(/\blec\b/ig, "LEC")
    .replace(/\blpl\b/ig, "LPL")
    .replace(/\bg2\b/ig, "G2")
    .replace(/\bkc\b/ig, "KC")
    .replace(/\bvit\b/ig, "VIT");
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

function parseGenericNewsLinks(html, source) {
  const items = [];
  const seen = new Set();
  const baseUrl = source.url;
  const linkPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{6,220}?)<\/a>/gi;
  for (const match of String(html || "").matchAll(linkPattern)) {
    const rawHref = decodeXml(match[1]);
    const title = normalizeNewsTitle(decodeXml(stripTags(match[2])));
    if (!title || !looksLikeEsportsNewsTitle(title)) continue;
    const url = resolveUrl(rawHref, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      title,
      url,
      image: "",
      source: source.source,
      publishedAt: null
    });
    if (items.length >= 8) break;
  }
  return items;
}

function normalizeNewsTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^(更多|查看详情|阅读全文)[:：\s-]*/i, "")
    .trim();
}

function looksLikeEsportsNewsTitle(title) {
  const text = String(title || "").toLowerCase();
  if (/[�]{1,}|\?{3,}/.test(text)) return false;
  if (text.length < 8 || text.length > 90) return false;
  const keywords = [
    "lpl", "lck", "lec", "lcs", "lcp", "msi", "英雄联盟", "季后赛", "常规赛",
    "赛程", "胜者组", "败者组", "晋级", "淘汰", "blg", "tes", "al", "we", "t1", "geng", "gen"
  ];
  return keywords.some((keyword) => text.includes(keyword));
}

function annotateNewsDiscussionSignals(items, tournament) {
  const groups = new Map();
  const annotated = (items || []).map((item) => {
    const topicKey = newsTopicKey(item, tournament);
    const sourceDomain = sourceNameFromUrl(item.url);
    const entry = groups.get(topicKey) || { sources: new Set(), queries: new Set(), count: 0 };
    entry.sources.add(sourceDomain);
    if (item.searchQuery) entry.queries.add(item.searchQuery);
    entry.count += 1;
    groups.set(topicKey, entry);
    return { ...item, topicKey };
  });
  return annotated.map((item) => {
    const group = groups.get(item.topicKey);
    const sourceCoverage = group?.sources.size || 1;
    const queryCoverage = group?.queries.size || 0;
    return {
      ...item,
      sourceCoverage,
      queryCoverage,
      discussionScore: Math.min(36, Math.max(0, sourceCoverage - 1) * 12)
    };
  });
}

function newsTopicKey(item, tournament) {
  const text = `${item.title || ""} ${item.description || ""}`.toLowerCase();
  const teams = (tournament?.teams || [])
    .map((team) => team.name)
    .filter((name) => teamMentionedInText(name, text))
    .sort();
  const angle = /阵容|首发|转会|名单/.test(text)
    ? "roster"
    : /赛果|复盘|击败|战胜|淘汰|晋级|夺冠|横扫|爆冷/.test(text)
      ? "result"
      : /前瞻|预测|焦点|赛前|对阵/.test(text)
        ? "preview"
        : /赛制|规则|门票|资格|名额|msi|worlds/.test(text)
          ? "qualification"
          : "general";
  if (teams.length) return `teams:${teams.join("|")}:${angle}`;
  const titleTokens = normalizeNewsTitle(item.title)
    .toLowerCase()
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !/^(league|legends|esports|英雄联盟|最新|比赛|新闻)$/.test(token))
    .slice(0, 5);
  return `${leagueKeyFromTournament(tournament)}:${titleTokens.join("|") || normalizeUrl(item.url)}`;
}

function resolveUrl(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    if (!/^https?:$/.test(url.protocol)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function resolveProtocolUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  return resolveUrl(value, "https://lpl.qq.com/");
}

function addQueryParam(url, key, value) {
  if (!url || value == null || value === "") return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    return url;
  }
}

function newsRelevance(item, tournament, teamNames = null) {
  if (!tournament) return 0;
  const text = `${item.title || ""} ${item.description || ""}`.toLowerCase();
  const tournamentLeague = leagueKeyFromTournament(tournament);
  if (item.league && item.league !== "global" && item.league !== "custom" && item.league !== tournamentLeague) return 0;
  let score = 0;
  const league = leagueLabelForNews(tournament).toLowerCase();
  const leagueMatched = league && text.includes(league);
  let teamScore = 0;
  if (leagueMatched) score += 20;
  for (const name of teamNames || []) {
    if (teamMentionedInText(name, text)) teamScore += 14;
  }
  score += teamScore;
  if (!leagueMatched && teamScore === 0) return 0;
  if (tournament.rules?.phase === "playoffs" && /季后赛|playoff|胜者组|败者组|淘汰|晋级/.test(text)) score += 12;
  if (/预测|前瞻|焦点|爆冷|门票|msi/i.test(text)) score += 8;
  if (text.includes(String(new Date().getFullYear()))) score += 8;
  const expectedSplit = extractSplitNumber(`${tournament.name || ""} ${tournament.stage || ""}`);
  if (expectedSplit && extractSplitNumber(text) === expectedSplit) score += 16;
  const matchHit = (tournament.matches || []).some((match) => {
    const left = teamName(tournament, match.teams[0]);
    const right = teamName(tournament, match.teams[1]);
    return teamMentionedInText(left, text) && teamMentionedInText(right, text);
  });
  if (matchHit) score += 24;
  return score;
}

function newsSortScore(item, tournament = null) {
  const published = Date.parse(item.publishedAt || "");
  const ageDays = Number.isFinite(published) ? Math.max(0, (Date.now() - published) / 86_400_000) : 30;
  const recency = Math.max(0, 42 - Math.min(ageDays, 14) * 3);
  const domestic = domesticSourceScore(item.url, item.source);
  const visual = item.image && !String(item.image).includes("news-cover?") ? 8 : 0;
  const sourcePenalty = /lolesports|dexerto|esports\.gg|op\.gg/i.test(`${item.url} ${item.source}`) ? -40 : 0;
  const stageBonus = tournament?.rules?.phase === "playoffs" && /季后赛|淘汰|胜者组|败者组|门票|msi|爆冷|黑八/i.test(`${item.title} ${item.description}`) ? 12 : 0;
  const reportBonus = /玩加电竞|wanplus/i.test(`${item.url} ${item.source}`) && /战报|零封|晋级|挺进|击败|战胜|横扫|让二追三/i.test(`${item.title} ${item.description}`) ? 48 : 0;
  const previewBonus = /焦点战预告|首发名单|对阵预告|赛前|前瞻/i.test(item.title || "") ? 14 : 0;
  const oldAnnouncementPenalty = ageDays > 7 && /恭喜.*晋级|晋级.*淘汰赛/i.test(item.title || "") ? -18 : 0;
  const searchQuality = Math.round(Number(item.searchScore || 0) * 18);
  const discussion = Number(item.discussionScore || 0);
  return (item.relevance || 0) + recency + domestic + visual + stageBonus + reportBonus + previewBonus + oldAnnouncementPenalty + sourcePenalty + searchQuality + discussion;
}

function domesticSourceScore(url, source = "") {
  const text = `${url || ""} ${source || ""}`.toLowerCase();
  if (/wanplus\.cn|玩加电竞/.test(text)) return 32;
  if (/lpl\.qq\.com|lol\.qq\.com|scoregg\.com/.test(text)) return 28;
  if (/zhihu\.com|bilibili\.com\/(?:read|video)|b23\.tv|baijiahao\.baidu\.com|weibo\.com/.test(text)) return 26;
  if (/163\.com|sohu\.com|sina\.com\.cn|qq\.com|bilibili\.com/.test(text)) return 20;
  if (/invenglobal\.com|rft\.gg|strafe\.com|bo3\.gg|esportnow\.gg/.test(text)) return 18;
  if (/cn\.bing\.com|bing新闻|bing搜索/i.test(text)) return 10;
  if (/lolesports|dexerto|esports\.gg|op\.gg/.test(text)) return -30;
  return 0;
}

function isDomesticReachableNewsItem(item) {
  return domesticSourceScore(item.url, item.source) >= 18 || /hupu\.com|178\.com|duowan\.com|nga\.cn|tieba\.baidu\.com/i.test(`${item.url} ${item.source}`);
}

function isHardBlockedForeignNews(item) {
  return /youtube\.com|youtu\.be|strafe\.com|egamersworld\.com|kalshi\.com|deadspin\.com|reddit\.com|facebook\.com|instagram\.com|threads\.com|sofascore\.com|rft\.gg/i.test(`${item.url} ${item.source}`);
}

function isRecentOfficialDomesticNews(item, tournament = null) {
  const tournamentLeague = leagueKeyFromTournament(tournament);
  if (item.league && item.league !== "global" && item.league !== "custom" && item.league !== tournamentLeague) return false;
  const text = `${item.url || ""} ${item.source || ""}`.toLowerCase();
  if (!/玩加电竞|wanplus\.cn|lpl赛事官网|lol\.qq\.com|lpl\.qq\.com|scoregg\.com|zhihu\.com|163\.com|sohu\.com|sina\.com\.cn/.test(text)) {
    return false;
  }
  const ageDays = Math.max(0, (Date.now() - Date.parse(item.publishedAt || new Date())) / 86_400_000);
  if (ageDays > 60) return false;
  const title = String(item.title || "");
  if (/百科|赛程、排名|排行榜|直播|官网首页|官方网站/.test(title)) return false;
  return /LPL|英雄联盟|淘汰赛|季后赛|首发|焦点|名单|公告|赛段/i.test(title);
}

async function rankNewsWithLlm(tournament, items) {
  const candidates = items.slice(0, 12);
  if (!candidates.length) return [];
  const provider = process.env.NEWS_RANK_PROVIDER || process.env.DEFAULT_LLM_PROVIDER || "deepseek";
  try {
    const context = JSON.stringify({
      tournament: tournament ? {
        id: tournament.id,
        name: tournament.name,
        stage: tournament.stage,
        phase: tournament.rules?.phase,
        teams: (tournament.teams || []).map((team) => team.name),
        upcomingMatches: (tournament.matches || [])
          .filter((match) => match.status !== "finished")
          .slice(0, 6)
          .map((match) => ({
            startsAt: match.startsAt,
            left: teamName(tournament, match.teams[0]),
            right: teamName(tournament, match.teams[1]),
            bestOf: match.bestOf
          }))
      } : null,
      candidates: candidates.map((item, index) => ({
        index,
        title: item.title,
        source: item.source,
        publishedAt: item.publishedAt,
        ageDays: Math.round(Math.max(0, (Date.now() - Date.parse(item.publishedAt || new Date())) / 86_400_000) * 10) / 10,
        url: item.url,
        description: String(item.description || "").slice(0, 180),
        sourceCoverage: item.sourceCoverage || 1,
        queryCoverage: item.queryCoverage || 0,
        discussionScore: item.discussionScore || 0,
        ruleScore: Math.round(newsSortScore(item, tournament))
      }))
    });
    const prompt = [
      "请从候选新闻中挑选最适合中国英雄联盟观众首页轮播的最新热门新闻。",
      "只允许选择候选列表里已有的 index，不要编造新新闻。",
      "优先级：1 最新；2 国内来源或中文社区；3 与当前赛事/队伍/季后赛/爆冷/MSI名额直接相关；4 标题像真实新闻而不是赛程页/直播页/分类页。",
      "sourceCoverage 表示同一赛事话题被多少个独立网站覆盖，可作为讨论热度信号；但不得仅因标题夸张就判定热门。",
      "如果有最近 7 天内的赛前预告、首发名单、焦点战、赛果复盘，不要把更早的“恭喜晋级”公告排在它们前面。",
      "排除打不开概率高的纯直播页、赛程页、分类页、旧年份内容。",
      "输出 JSON：{\"order\":[0,2,1],\"notes\":{\"0\":\"一句选择理由\"}}，order 最多 8 个。"
    ].join("\n");
    const llm = await callLlm(provider, prompt, context);
    const parsed = parseJsonFromLlm(llm);
    const order = Array.isArray(parsed?.order) ? parsed.order : [];
    const ranked = [];
    const used = new Set();
    for (const value of order) {
      const index = Number(value);
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length || used.has(index)) continue;
      used.add(index);
      ranked.push({
        ...candidates[index],
        aiRanked: true,
        aiReason: parsed?.notes?.[String(index)] || parsed?.notes?.[index] || ""
      });
    }
    for (const item of candidates) {
      if (!used.has(candidates.indexOf(item))) ranked.push(item);
    }
    return diversifyNewsSources(ranked, 8);
  } catch (error) {
    return diversifyNewsSources(candidates.sort((a, b) => newsSortScore(b, tournament) - newsSortScore(a, tournament)), 8);
  }
}

function diversifyNewsSources(items, limit = 8) {
  const selected = [];
  const deferred = [];
  const counts = new Map();
  const maxPerSource = 2;
  for (const item of items) {
    const source = String(item.source || sourceNameFromUrl(item.url) || "unknown");
    const count = counts.get(source) || 0;
    if (count < maxPerSource) {
      selected.push(item);
      counts.set(source, count + 1);
    } else {
      deferred.push(item);
    }
    if (selected.length >= limit) return selected;
  }
  for (const item of deferred) {
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function isUsableNewsItem(item, tournament = null) {
  const title = normalizeNewsTitle(item.title);
  if (!title || /[�]{1,}|\?{3,}/.test(title)) return false;
  if (title.length < 8) return false;
  const url = normalizeUrl(item.url);
  if (!url) return false;
  if (/powerpoint|microsoft365|office\.com|bing\.com\/search/i.test(`${title} ${url}`)) return false;
  if (isHardBlockedForeignNews({ ...item, url })) return false;
  if (/live\.bilibili\.com|huya\.com|douyu\.com|bendibao\.com|redable\.qq\.com/i.test(url)) return false;
  if (/baike\.baidu\.com|wegame\.com|wx\.qq\.com|apifox\.com|games\.qq\.com\/a\//i.test(url)) return false;
  if (/op\.gg|\/leagues\/|scoregg\.com\/match_pc|scoregg\.com\/tournament/i.test(url)) return false;
  if (/^https?:\/\/(?:www\.)?lpl\.qq\.com\/?$/i.test(url)) return false;
  if (/schedule|standings|赛程、排名|戰績、賽程、排名|排名和结果|赛程\|排名|賽程表|积分|排行榜|赛事官网|直播尽在|联赛开始时间/i.test(title)) return false;
  if (/中文直播|官方解说|直播连结|直播链接|实时讨论|直播讨论|live discussion/i.test(title)) return false;
  if (/highlights?(?:\s+all games?|\s+game|\s+g\d|\s*\|)|full game|live score|odds|betting tips?|head to head|chat with youtube|chatyt/i.test(`${title} ${url}`)) return false;
  if (/法律英语|全国统一考试|证书|liquipedia|蜂鸟竞技|wiki|\.qq\.com\/v\//i.test(`${title} ${url}`)) return false;
  if (/^(LCK|LEC|LCS|LCP)联赛\s*-\s*/i.test(title)) return false;
  if (/^lol esports\s*\|?$/i.test(title) || /^league of legends\s*\|?$/i.test(title)) return false;
  if (/^(\d{4})\s*(LPL|LCK|LEC|LCS)(第)?[一二三四五六七八九十0-9]+(赛段|赛季)$/i.test(title.replace(/\s+/g, ""))) return false;
  if (tournament && !newsMatchesTournamentScope(item, tournament)) return false;
  if (tournament && newsConflictsWithTournamentStage(item, tournament)) return false;
  if (/^20\d{2}\s*LPL第[一二三四五六七八九十0-9]+赛段$/i.test(title.replace(/\s+/g, ""))) return false;
  if (/全明星周末/i.test(title) || /\/act\//i.test(url)) return false;
  const currentYear = new Date().getFullYear();
  const yearMatch = title.match(/\b(20\d{2})\b/);
  if (yearMatch && Number(yearMatch[1]) < currentYear) return false;
  const published = Date.parse(item.publishedAt || "");
  if (Number.isFinite(published) && (Date.now() - published) / 86_400_000 > 45) return false;
  if (tournament) {
    const expectedSplit = extractSplitNumber(`${tournament.name || ""} ${tournament.stage || ""}`);
    const actualSplit = extractSplitNumber(`${title} ${item.description || ""}`);
    if (expectedSplit && actualSplit && expectedSplit !== actualSplit) return false;
  }
  if (tournament && String(item.source || "").includes("Bing搜索") && !searchResultLooksCurrent(item, tournament)) return false;
  return true;
}

function newsConflictsWithTournamentStage(item, tournament) {
  const tournamentText = `${tournament.name || ""} ${tournament.stage || ""}`.toLowerCase();
  const text = `${item.title || ""} ${item.description || ""}`.toLowerCase();
  if (!/challenger|academy|\bcl\b|次级联赛|发展联赛/i.test(tournamentText) &&
      /challenger|academy|\blck cl\b|\blpl cl\b|次级联赛|发展联赛/i.test(text)) return true;
  if (/road to msi/.test(tournamentText) && /\bcup\b|first stand|全球先锋赛|先锋赛/.test(text)) return true;
  if (/road to msi/.test(tournamentText) && /\bspring\b|rounds?\s*1-2|regular season|常规赛/.test(text)) return true;
  if (/split\s*2|第\s*[二2]\s*赛段/.test(tournamentText) && /first stand|全球先锋赛|先锋赛/.test(text)) return true;
  if (/spring/.test(tournamentText) && /\bversus\b/.test(text)) return true;
  if (tournament.rules?.phase === "playoffs" && /regular season|常规赛/.test(text)) return true;
  if (!/esports world cup|\bewc\b|世界杯|资格赛|qualifier/.test(tournamentText) &&
      /esports world cup|\bewc\b|世界杯|资格赛|qualifier/.test(text)) return true;
  return false;
}

function newsMatchesTournamentScope(item, tournament) {
  const league = leagueKeyFromTournament(tournament);
  const label = leagueLabelForNews(tournament).toLowerCase();
  const text = `${item.title || ""} ${item.description || ""} ${item.url || ""}`.toLowerCase();
  if (league === "global") return true;
  if (item.league && item.league !== "global" && item.league !== "custom" && item.league !== league) return false;
  const teamHit = (tournament.teams || []).some((team) => teamMentionedInText(team.name, text));
  if (teamHit) return true;
  if (!text.includes(label)) return false;
  return hasEsportsNewsContext(text, league);
}

function strictSearchNewsScope(item, tournament) {
  const text = `${item.title || ""} ${item.description || ""} ${item.url || ""}`.toLowerCase();
  const league = leagueKeyFromTournament(tournament);
  const leagueLabel = leagueLabelForNews(tournament).toLowerCase();
  const hardEsportsContext = /league of legends|英雄联盟|\blol\b|riot games|esports|电竞|季后赛|常规赛|淘汰赛|胜者组|败者组|road to msi|\bmsi\b|\bworlds\b|playoffs/i.test(text);
  if (!hardEsportsContext) return false;
  if (keywordMatches(text, leagueLabel)) return true;
  const strongTeamHits = (tournament.teams || [])
    .map((team) => team.name)
    .filter((name) => String(name).replace(/[^a-z0-9]/gi, "").length >= 3)
    .filter((name) => teamMentionedInText(name, text));
  return strongTeamHits.length > 0;
}

function hasEsportsNewsContext(text, league = "") {
  const value = String(text || "").toLowerCase();
  const esportsTerms = [
    "league of legends", "英雄联盟", "lol", "riot", "esports", "电竞",
    "playoffs", "regular season", "road to msi", "msi", "worlds",
    "季后赛", "常规赛", "胜者组", "败者组", "淘汰赛", "赛段", "首发", "焦点战"
  ];
  if (esportsTerms.some((term) => value.includes(term))) return true;
  const leagueTeams = {
    lck: ["t1", "faker", "gen.g", "geng", "hle", "hanwha", "dk", "dplus", "kt rolster"],
    lec: ["g2", "fnatic", "fnc", "karmine", "kc", "mkoi", "vitality", "lec playoffs"],
    lcs: ["cloud9", "c9", "team liquid", "flyquest", "100 thieves", "lcs playoffs"],
    lcp: ["psg talon", "ctbc", "cfo", "gam esports", "lcp playoffs", "pacific"]
  };
  return (leagueTeams[league] || []).some((term) => value.includes(term));
}

function isVisualNewsFiller(item) {
  const image = String(item.image || "");
  if (!image || image.includes("news-cover?") || image.includes("news-placeholder.svg")) return false;
  const source = String(item.source || "");
  const ageDays = Math.max(0, (Date.now() - Date.parse(item.publishedAt || new Date())) / 86_400_000);
  return ageDays <= 60 && /lolesports|leagueoflegends|riot|英雄联盟/i.test(source);
}

function searchResultLooksCurrent(item, tournament) {
  const currentYear = String(new Date().getFullYear());
  const text = `${item.title || ""} ${item.description || ""} ${item.url || ""}`.toLowerCase();
  if (text.includes(currentYear)) return true;
  const openMatches = (tournament.matches || []).filter((match) => match.status !== "finished");
  return openMatches.some((match) => {
    const left = teamName(tournament, match.teams[0]);
    const right = teamName(tournament, match.teams[1]);
    return teamMentionedInText(left, text) && teamMentionedInText(right, text);
  });
}

async function fetchText(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 9000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": options.userAgent || "MatchMindEsports/1.0"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";
    return decodeResponseText(bytes, contentType);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeResponseText(bytes, contentType = "") {
  const headerCharset = charsetFromText(contentType);
  const asciiPreview = new TextDecoder("latin1").decode(bytes.slice(0, Math.min(bytes.length, 4096)));
  const metaCharset = charsetFromText(asciiPreview);
  const charset = normalizeCharset(headerCharset || metaCharset || "utf-8");
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function charsetFromText(value) {
  const match = String(value || "").match(/charset=["']?\s*([a-z0-9_-]+)/i);
  return match ? match[1] : "";
}

function normalizeCharset(value) {
  const lower = String(value || "").trim().toLowerCase();
  if (["gbk", "gb2312", "gb18030"].includes(lower)) return "gb18030";
  if (["utf8", "utf-8"].includes(lower)) return "utf-8";
  return lower || "utf-8";
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
    description: stripTags(description).trim(),
    image,
    source: String(source.source || "").startsWith("Bing") ? sourceNameFromUrl(url) : source.source,
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
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function parseOptionalDate(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function sourceNameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "赛事新闻";
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/news-cover") {
    const svg = buildNewsCoverSvg({
      title: url.searchParams.get("title") || "赛事焦点",
      source: url.searchParams.get("source") || "MatchMind",
      league: url.searchParams.get("league") || "default"
    });
    res.writeHead(200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400"
    });
    res.end(svg);
    return;
  }

  if (url.pathname === "/api/tournaments") {
    const data = await getTournamentData({ refresh: url.searchParams.get("refresh") === "1" });
    sendJson(res, 200, data);
    return;
  }

  if (url.pathname === "/api/news") {
    const tournamentId = url.searchParams.get("tournament");
    let tournament = null;
    if (tournamentId) {
      const tournamentData = await getTournamentData();
      tournament = getTournamentFromData(tournamentData, tournamentId);
    }
    const data = await getNewsData({ refresh: url.searchParams.get("refresh") === "1", tournament });
    sendJson(res, 200, data);
    return;
  }

  if (url.pathname === "/api/roster") {
    const tournamentId = url.searchParams.get("tournament");
    const tournamentData = await getTournamentData();
    const tournament = getTournamentFromData(tournamentData, tournamentId);
    const news = await getNewsData({ tournament }).catch(() => ({ items: [] }));
    const data = await getRosterData({
      tournament,
      newsItems: news.items,
      refresh: url.searchParams.get("refresh") === "1"
    });
    sendJson(res, 200, data);
    return;
  }

  if (url.pathname === "/api/rule-research") {
    const tournamentData = await getTournamentData();
    const tournament = getTournamentFromData(tournamentData, url.searchParams.get("tournament"));
    const news = await getNewsData({ tournament }).catch(() => ({ items: [] }));
    const data = await getRuleResearch({
      tournament,
      newsItems: news.items,
      refresh: url.searchParams.get("refresh") === "1"
    });
    sendJson(res, 200, data);
    return;
  }

  if (url.pathname === "/api/analyze") {
    const refresh = url.searchParams.get("refresh") === "1";
    const fast = url.searchParams.get("fast") === "1";
    const provider = url.searchParams.get("provider") || "local";
    const data = await getTournamentData({ refresh });
    const tournament = getTournamentFromData(data, url.searchParams.get("tournament"));
    const analysis = localAnalysis(tournament);
    if (fast) {
      sendJson(res, 200, {
        tournament,
        analysis,
        roster: null,
        ruleResearch: null,
        meta: data.meta,
        preview: true,
        updatedAt: new Date().toISOString()
      });
      return;
    }
    const cacheKey = `${tournament.id}:${provider}`;
    const cached = analysisCache.get(cacheKey);
    if (cached?.data?.analysis?.llmError) analysisCache.delete(cacheKey);
    if (!refresh && cached && Date.now() - cached.cachedAt < ANALYSIS_CACHE_TTL_MS) {
      if (!cached.data.analysis?.llmError) {
        sendJson(res, 200, { ...cached.data, cached: true });
        return;
      }
    }
    if (analysisPending.has(cacheKey)) {
      sendJson(res, 200, { ...(await analysisPending.get(cacheKey)), sharedRequest: true });
      return;
    }
    const pending = (async () => {
      const news = await getNewsData({ tournament }).catch(() => ({ items: [] }));
      enrichAnalysisWithAudienceFocus(tournament, analysis, news.items);
      let roster = null;
      let ruleResearch = null;
      if (provider !== "local") {
        const [rosterResult, ruleResult] = await Promise.all([
          withTimeout(getRosterData({ tournament, newsItems: news.items, refresh }), ROSTER_ANALYSIS_TIMEOUT_MS, "roster"),
          withTimeout(getRuleResearch({ tournament, newsItems: news.items, refresh }), RULE_ANALYSIS_TIMEOUT_MS, "ruleResearch")
        ]);
        roster = rosterResult.data || null;
        ruleResearch = ruleResult.data || null;
        analysis.researchWarnings = [
          rosterResult.timedOut ? `阵容检索超过 ${Math.round(ROSTER_ANALYSIS_TIMEOUT_MS / 1000)} 秒，已先使用可用数据生成。` : "",
          ruleResult.timedOut ? `规则检索超过 ${Math.round(RULE_ANALYSIS_TIMEOUT_MS / 1000)} 秒，已先使用可用数据生成。` : "",
          rosterResult.error ? `阵容检索失败：${rosterResult.error.message}` : "",
          ruleResult.error ? `规则检索失败：${ruleResult.error.message}` : ""
        ].filter(Boolean);
      }
      if (provider !== "local") {
        try {
          await enhanceAnalysisWithLlm(provider, tournament, analysis, news.items, roster, ruleResearch);
        } catch (error) {
          analysis.llmError = error.message;
        }
      }
      const responseData = {
        tournament,
        analysis,
        roster,
        ruleResearch,
        meta: data.meta,
        aiStatus: provider === "local" ? "local" : analysis.aiEnhanced ? "ready" : "failed",
        updatedAt: new Date().toISOString()
      };
      if (provider === "local" || analysis.aiEnhanced) {
        analysisCache.set(cacheKey, { cachedAt: Date.now(), data: responseData });
      }
      return responseData;
    })();
    analysisPending.set(cacheKey, pending);
    let responseData;
    try {
      responseData = await pending;
    } finally {
      analysisPending.delete(cacheKey);
    }
    sendJson(res, 200, responseData);
    return;
  }

  if (url.pathname === "/api/chat" && req.method === "POST") {
    const body = await readBody(req);
    const data = await getTournamentData();
    const tournament = getTournamentFromData(data, body.tournamentId);
    const analysis = localAnalysis(tournament, body.scenario || {});
    const news = await getNewsData({ tournament }).catch(() => ({ items: [] }));
    enrichAnalysisWithAudienceFocus(tournament, analysis, news.items);
    const provider = body.provider || "local";
    const roster = provider === "local" ? null : await getRosterData({ tournament, newsItems: news.items }).catch(() => null);
    const ruleResearch = provider === "local" ? null : await getRuleResearch({ tournament, newsItems: news.items }).catch(() => null);
    let answer = answerLocally(body.question || "", tournament, analysis);
    if (provider !== "local") {
      try {
        const llm = await callLlm(provider, buildChatPrompt(body.question || ""), compactContext(tournament, analysis, news.items, roster, ruleResearch));
        if (llm) answer = llm;
      } catch (error) {
        answer += `\n\n模型接口暂不可用，已使用本地规则引擎回答。错误：${error.message}`;
      }
    }
    sendJson(res, 200, { answer, analysis, roster, ruleResearch, meta: data.meta });
    return;
  }

  if (url.pathname === "/api/prediction" && req.method === "POST") {
    const body = await readBody(req);
    const data = await getTournamentData();
    const tournament = getTournamentFromData(data, body.tournamentId);
    const analysis = localAnalysis(tournament);
    const news = await getNewsData({ tournament }).catch(() => ({ items: [] }));
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
    const predictionTeams = (match.teams || []).map((id) => tournament.teams.find((team) => team.id === id)).filter(Boolean);
    const roster = provider === "local"
      ? null
      : await getRosterData({ tournament, teams: predictionTeams, newsItems: news.items }).catch(() => null);
    const ruleResearch = provider === "local" ? null : await getRuleResearch({ tournament, newsItems: news.items }).catch(() => null);
    let prediction = predictMatchLocally(tournament, analysis, match);
    let llmError = null;
    try {
      prediction = await predictMatch(provider, tournament, analysis, match, news.items, roster, ruleResearch);
    } catch (error) {
      llmError = error.message;
      prediction += `\n\n模型接口暂不可用，已使用本地预测。错误：${error.message}`;
    }
    sendJson(res, 200, { prediction, match, analysis, roster, ruleResearch, llmError, meta: data.meta });
    return;
  }

  if (url.pathname === "/api/scenario" && req.method === "POST") {
    const body = await readBody(req);
    const data = await getTournamentData();
    const tournament = getTournamentFromData(data, body.tournamentId);
    const analysis = localAnalysis(tournament, body.scenario || {});
    const news = await getNewsData({ tournament }).catch(() => ({ items: [] }));
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

const serveStatic = createStaticHandler(PUBLIC_DIR);

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

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Close the existing server or start with another port:`);
    console.error(`  $env:PORT=3001; node server.js`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, () => {
  console.log(`Esports AI Schedule app running at http://localhost:${PORT}`);
});
