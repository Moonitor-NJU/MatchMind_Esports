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
  const limit = clampNumber(process.env.PANDASCORE_MATCH_LIMIT, 10, 100, 50);
  const lookbackDays = clampNumber(process.env.PANDASCORE_LOOKBACK_DAYS, 1, 60, 14);
  const lookaheadDays = clampNumber(process.env.PANDASCORE_LOOKAHEAD_DAYS, 1, 90, 30);
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
      teamCount: tournament.teams.length
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
      const teamList = Array.from(group.teams.values()).map(({ pandaId, ...team }) => team);
      return {
        id: group.descriptor.id,
        name: group.descriptor.name,
        game: game === "lol" ? "League of Legends" : game.toUpperCase(),
        region: group.descriptor.region,
        stage: group.descriptor.stage,
        season: group.descriptor.serie,
        source: `PandaScore 实时赛事 API · ${group.descriptor.league}`,
        rules: {
          format: "按当前赛事组内赛程自动统计",
          advanceSlots: Math.min(4, Math.max(1, Math.ceil(teamList.length / 2))),
          eliminationSlots: Math.min(2, Math.max(0, Math.floor(teamList.length / 4))),
          tiebreakers: ["胜场", "小分净胜", "小分胜场", "官方排名规则以赛事官网为准"]
        },
        teams: teamList,
        matches: group.matches.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      };
    })
    .filter((tournament) => tournament.matches.length)
    .sort(comparePandaTournaments);
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
    league,
    serie,
    stage,
    region,
    name: [league, serie, stage].filter(uniqueLabel).join(" · ")
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
  const advanceSlots = tournament.rules.advanceSlots;
  const eliminationSlots = tournament.rules.eliminationSlots || 0;
  return standings.map((row) => {
    const maxWins = row.wins + row.remaining;
    const teamsAbleToPass = standings.filter((other) => other.id !== row.id && other.wins + other.remaining >= row.wins).length;
    const teamsAlreadyAhead = standings.filter((other) => other.id !== row.id && other.wins > maxWins).length;
    let status = "悬念中";
    let tone = "watch";

    if (row.rank <= advanceSlots && teamsAbleToPass < advanceSlots) {
      status = "已锁定晋级";
      tone = "safe";
    } else if (teamsAlreadyAhead >= advanceSlots) {
      status = "理论淘汰";
      tone = "danger";
    } else if (row.rank <= advanceSlots) {
      status = "晋级主动权";
      tone = "safe";
    } else if (row.rank > standings.length - eliminationSlots) {
      status = "高危边缘";
      tone = "danger";
    }

    const target = standings[Math.max(0, advanceSlots - 1)];
    const winsNeeded = Math.max(0, target.wins + 1 - row.wins);
    return {
      ...row,
      maxWins,
      status,
      tone,
      note: `${row.name} 当前 ${row.wins}-${row.losses}，剩余 ${row.remaining} 场，最高可到 ${maxWins} 胜。${winsNeeded ? `保守估计还需要 ${winsNeeded} 场胜利冲击晋级线。` : "目前已处在晋级线附近。"}`
    };
  });
}

function keyMatches(tournament, standings) {
  const byId = new Map(standings.map((row) => [row.id, row]));
  const advanceSlots = tournament.rules.advanceSlots;
  return tournament.matches
    .filter((match) => match.status !== "finished")
    .map((match) => {
      const left = byId.get(match.teams[0]);
      const right = byId.get(match.teams[1]);
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
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function localAnalysis(tournament, scenario = {}) {
  const standings = buildStandings(tournament, scenario);
  const teams = qualificationStatus(tournament, standings);
  const matches = keyMatches(tournament, standings);
  const safe = teams.filter((team) => team.tone === "safe").slice(0, 3).map((team) => team.name).join("、") || "暂无";
  const danger = teams.filter((team) => team.tone === "danger").slice(0, 3).map((team) => team.name).join("、") || "暂无";
  const focus = matches[0];
  const summary = [
    `${tournament.name} 当前晋级线为前 ${tournament.rules.advanceSlots} 名。${safe} 处在较有利位置，${danger} 需要尽快抢分。`,
    focus ? `下一场重点关注 ${focus.left} vs ${focus.right}，系统判断为${focus.tag}，原因是双方排名和晋级线距离较近。` : "目前没有未结束比赛，晋级形势基本定型。",
    "AI 建议优先观察胜场、小分和直接交手结果；当胜场接近时，一场 2:0 往往比 2:1 更能改变排序。"
  ].join("\n");
  return { standings, teams, keyMatches: matches, summary };
}

function compactContext(tournament, analysis) {
  return JSON.stringify({
    tournament: {
      name: tournament.name,
      game: tournament.game,
      stage: tournament.stage,
      rules: tournament.rules
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
          content: "你是电竞赛事数据分析 Agent。必须基于给定结构化数据回答，不要编造未提供的赛果。用中文，结论明确，适合网页展示。"
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
        const llm = await callLlm(provider, "请输出晋级形势摘要、关键比赛、每个梯队的风险判断。", compactContext(tournament, analysis));
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
