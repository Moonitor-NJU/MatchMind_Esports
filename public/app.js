const state = {
  tournaments: [],
  tournament: null,
  analysis: null,
  meta: null,
  newsMeta: null,
  news: [],
  newsIndex: 0,
  newsTimer: null,
  newsPreloaded: new Set(),
  filter: "all",
  provider: "deepseek",
  analysisRequestId: 0,
  aiUpdating: false,
  aiStatus: "idle",
  modelError: "",
  refreshing: false,
  aiEngineTab: "prediction",
  activeNav: "#overview",
  predictionCards: {},
  predictionCardRequests: new Set()
};

const els = {
  tournamentSelect: document.querySelector("#tournamentSelect"),
  providerSelect: document.querySelector("#providerSelect"),
  sourceText: document.querySelector("#sourceText"),
  sourceDiagnostics: document.querySelector("#sourceDiagnostics"),
  gameLabel: document.querySelector("#gameLabel"),
  tournamentTitle: document.querySelector("#tournamentTitle"),
  refreshButton: document.querySelector("#refreshButton"),
  heroSummary: document.querySelector("#heroSummary"),
  agentStatus: document.querySelector("#agentStatus"),
  liveCount: document.querySelector("#liveCount"),
  keyCount: document.querySelector("#keyCount"),
  advanceSlots: document.querySelector("#advanceSlots"),
  advanceSlotsLabel: document.querySelector("#advanceSlotsLabel"),
  newsStage: document.querySelector("#newsStage"),
  newsRail: document.querySelector("#newsRail"),
  tickerText: document.querySelector("#tickerText"),
  tournamentTabs: document.querySelector("#tournamentTabs"),
  focusStrip: document.querySelector("#focusStrip"),
  scheduleFilter: document.querySelector("#scheduleFilter"),
  matchList: document.querySelector("#matchList"),
  phaseEyebrow: document.querySelector("#phaseEyebrow"),
  phaseTitle: document.querySelector("#phaseTitle"),
  standingsTableWrap: document.querySelector("#standingsTableWrap"),
  standingsBody: document.querySelector("#standingsBody"),
  phaseCards: document.querySelector("#phaseCards"),
  analysisText: document.querySelector("#analysisText"),
  keyMatches: document.querySelector("#keyMatches"),
  scenarioMatch: document.querySelector("#scenarioMatch"),
  scoreButtons: document.querySelector("#scoreButtons"),
  scenarioResult: document.querySelector("#scenarioResult"),
  aiEngineSummary: document.querySelector("#aiEngineSummary"),
  aiEngineTitle: document.querySelector("#aiEngineTitle"),
  aiEngineTabs: document.querySelector("#aiEngineTabs"),
  chatLog: document.querySelector("#chatLog"),
  chatForm: document.querySelector("#chatForm"),
  questionInput: document.querySelector("#questionInput"),
  quickQuestions: document.querySelector("#quickQuestions")
};

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function statusText(status) {
  return {
    live: "进行中",
    scheduled: "未开始",
    finished: "已结束"
  }[status] || status;
}

function teamById(id) {
  return state.tournament.teams.find((team) => team.id === id);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

async function loadTournaments(options = {}) {
  const data = await requestJson(`/api/tournaments${options.refresh ? "?refresh=1" : ""}`);
  state.tournaments = data.tournaments;
  state.meta = data.meta || null;
  state.newsIndex = 0;
  els.tournamentSelect.innerHTML = sortedVisibleTournaments()
    .map((item) => `<option value="${item.id}">${item.name}</option>`)
    .join("");
  renderTournamentTabs();
  const preferredId = preferredTournamentId();
  await loadAnalysis(preferredId, options);
}

function preferredTournamentId() {
  if (state.tournaments.some((item) => item.id === state.tournament?.id && !isDemoTournament(item))) {
    return state.tournament.id;
  }
  const firstRealTournament = sortedVisibleTournaments()[0];
  if (firstRealTournament) return firstRealTournament.id;
  return state.tournaments.find((item) => !isDemoTournament(item))?.id || state.tournaments[0]?.id;
}

function isDemoTournament(tournament) {
  return /演示组|demo/i.test(`${tournament?.id || ""} ${tournament?.name || ""} ${tournament?.source || ""}`);
}

async function loadNews(options = {}) {
  setAgentStep("news", "active");
  const params = new URLSearchParams();
  if (options.refresh) params.set("refresh", "1");
  const data = await requestJson(`/api/news${params.toString() ? `?${params.toString()}` : ""}`);
  state.news = data.items || [];
  state.newsMeta = data.meta || null;
  state.newsIndex = 0;
  state.newsPreloaded.clear();
  renderNews();
  renderHeader();
  setAgentStep("news", state.news.length ? "done" : "warn");
}

async function loadAnalysis(tournamentId = state.tournament?.id, options = {}) {
  const requestId = ++state.analysisRequestId;
  const previousTournamentId = state.tournament?.id;
  const switchingTournament = previousTournamentId && tournamentId && previousTournamentId !== tournamentId;
  if (switchingTournament) {
    clearTournamentPanels();
  }
  els.heroSummary.textContent = "正在读取赛程...";
  setAgentStep("schedule", "active");
  const previewParams = new URLSearchParams({
    tournament: tournamentId,
    provider: "local",
    fast: "1"
  });
  const preview = await requestJson(`/api/analyze?${previewParams.toString()}`);
  if (requestId !== state.analysisRequestId) return;
  state.aiUpdating = state.provider !== "local";
  setAgentStep("schedule", "done");
  setAgentStep("preview", "done");
  setAgentStep("news", "active");
  setAgentStep("research", state.provider === "local" ? "idle" : "active");
  setAgentStep("model", state.provider === "local" ? "idle" : "active");
  applyAnalysisData(preview, { switchingTournament });
  loadNews({ refresh: options.refresh }).catch(() => {
    state.news = [];
    renderNews();
    setAgentStep("news", "warn");
  });
  if (state.provider === "local") {
    state.aiUpdating = false;
    state.aiStatus = "local";
    state.modelError = "";
    setAgentStep("research", "idle");
    setAgentStep("model", "idle");
    renderHeader();
    return;
  }
  const params = new URLSearchParams({
    tournament: tournamentId,
    provider: state.provider
  });
  if (options.refresh) params.set("refresh", "1");
  let data;
  try {
    data = await requestJson(`/api/analyze?${params.toString()}`);
  } catch (error) {
    if (requestId !== state.analysisRequestId) return;
    state.aiUpdating = false;
    state.aiStatus = "failed";
    state.modelError = error.message;
    setAgentStep("research", "warn");
    setAgentStep("model", "warn");
    renderHeader();
    renderAnalysis();
    els.heroSummary.textContent = `模型分析失败：${friendlyModelError(error.message)}`;
    return;
  }
  if (requestId !== state.analysisRequestId) return;
  state.aiUpdating = false;
  const hasResearchWarning = (data.analysis?.researchWarnings || []).length > 0;
  setAgentStep("research", hasResearchWarning ? "warn" : data.ruleResearch || data.roster ? "done" : "warn");
  setAgentStep("model", data.aiStatus === "ready" && data.analysis?.aiEnhanced ? "done" : "warn");
  applyAnalysisData(data);
  if (data.analysis?.llmError || data.aiStatus !== "ready" || !data.analysis?.aiEnhanced) {
    els.heroSummary.textContent = `完整 AI 分析暂未接管页面，当前展示本地分析：${friendlyModelError(data.analysis?.llmError || data.aiStatus || "AI did not return usable structured analysis")}`;
  }
  loadNews({ refresh: options.refresh }).catch(() => setAgentStep("news", "warn"));
}

const AGENT_STEPS = [
  { id: "schedule", label: "赛程" },
  { id: "preview", label: "本地预览" },
  { id: "news", label: "新闻" },
  { id: "research", label: "规则/阵容" },
  { id: "model", label: "AI 生成" }
];

function setAgentStep(id, status) {
  state.agentSteps = state.agentSteps || Object.fromEntries(AGENT_STEPS.map((step) => [step.id, "idle"]));
  state.agentSteps[id] = status;
  renderAgentStatus();
}

function renderAgentStatus() {
  if (!els.agentStatus) return;
  const steps = state.agentSteps || {};
  const stepHtml = AGENT_STEPS.map((step) => {
    const status = steps[step.id] || "idle";
    return `<span class="${status}"><i></i>${step.label}</span>`;
  }).join("");
  const modelClass = modelStatusClass();
  const modelText = modelStatusText();
  els.agentStatus.innerHTML = `${stepHtml}<span class="model-pill ${modelClass}" title="${escapeHtml(state.modelError || modelText)}"><i></i>${escapeHtml(modelText)}</span>`;
}

function setRefreshing(value, message = "") {
  state.refreshing = value;
  if (!els.refreshButton) return;
  els.refreshButton.disabled = value;
  els.refreshButton.classList.toggle("is-loading", value);
  els.refreshButton.setAttribute("aria-busy", value ? "true" : "false");
  els.refreshButton.title = value ? "正在刷新赛事、新闻和 AI 分析" : "刷新赛事、新闻和 AI 分析";
  if (message) {
    els.heroSummary.textContent = message;
  }
}

function modelStatusClass() {
  if (state.aiUpdating) return "active";
  if (state.provider === "local" || state.aiStatus === "local") return "idle";
  if (state.aiStatus === "ready") return "done";
  if (state.aiStatus === "failed" || state.modelError) return "warn";
  return "idle";
}

function modelStatusText() {
  const providerName = {
    deepseek: "DeepSeek",
    qwen: "Qwen",
    kimi: "Kimi",
    zhipu: "智谱",
    local: "本地"
  }[state.provider] || state.provider;
  if (state.aiUpdating) return `${providerName} 正在生成`;
  if (state.provider === "local" || state.aiStatus === "local") return "本地规则引擎";
  if (state.aiStatus === "ready") {
    const length = state.analysis?.llmRawLength ? ` · ${state.analysis.llmRawLength}字` : "";
    return `${providerName} 已生成${length}`;
  }
  if (state.aiStatus === "failed" || state.modelError || state.analysis?.llmError) {
    return `${providerName} 未接管`;
  }
  return `${providerName} 待生成`;
}

function friendlyModelError(message) {
  const text = String(message || "");
  if (/\b401\b/.test(text)) return "API Key 无效或未正确加载";
  if (/\b400\b/.test(text)) return "模型参数或模型名称不被当前平台接受，请检查 .env 里的模型名";
  if (/\b402\b/.test(text)) return "账户余额不足、额度耗尽或计费状态异常";
  if (/\b429\b/.test(text)) return "请求过于频繁或接口额度受限";
  if (/API_KEY|is not set/i.test(text)) return "当前 Node 进程没有读到对应模型的 API Key，请重启服务并检查 .env";
  if (/timed out|timeout|超时/i.test(text)) return "模型或联网检索耗时过长，已先展示本地分析";
  if (/LLM returned empty content/i.test(text) && /finishReason["']?:["']?length/i.test(text) && /hasReasoningContent["']?:true/i.test(text)) {
    return "当前模型把输出额度全部用在推理过程，没有生成最终正文；建议使用 deepseek-chat，或显著提高 LLM_MAX_TOKENS";
  }
  if (/non-JSON/i.test(text)) return "模型返回格式不符合页面结构化要求，已保留本地分析";
  return text || "未知接口错误";
}

function applyAnalysisData(data, options = {}) {
  state.tournament = data.tournament;
  state.analysis = data.analysis;
  state.meta = data.meta || state.meta;
  state.aiStatus = data.aiStatus || (data.analysis?.aiEnhanced ? "ready" : state.provider === "local" ? "local" : "failed");
  state.modelError = data.analysis?.llmError || "";
  els.tournamentSelect.value = state.tournament.id;
  renderAll();
  if (options.switchingTournament) resetAgentForTournament();
}

function renderAll() {
  renderTournamentTabs();
  renderHeader();
  renderAiEngineTabs();
  renderNavState();
  renderAgentStatus();
  renderNews();
  renderFocus();
  renderSchedule();
  renderPhase();
  renderAnalysis();
  renderScenarioOptions();
  renderQuickQuestions();
}

function renderAiEngineTabs() {
  const tabs = els.aiEngineTabs;
  const engine = tabs?.closest(".ai-engine");
  const labels = {
    prediction: "赛前预测",
    summary: "AI 摘要",
    chat: "AI 问答"
  };
  if (els.aiEngineTitle) {
    els.aiEngineTitle.textContent = labels[state.aiEngineTab] || "AI Engine";
  }
  if (!tabs || !engine) {
    renderNavState();
    return;
  }
  engine.dataset.activeTab = state.aiEngineTab;
  tabs.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === state.aiEngineTab);
  });
  renderNavState();
}

function renderNavState() {
  document.querySelectorAll(".nav a").forEach((link) => {
    const href = link.getAttribute("href") || "";
    const isEngineLink = href === "#aiEngine";
    const isActive = isEngineLink
      ? state.activeNav === "#aiEngine" && link.dataset.engineTab === state.aiEngineTab
      : state.activeNav === href;
    link.classList.toggle("active", isActive);
  });
}

function scrollToSection(href) {
  if (!href || href === "#overview") {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  const target = document.querySelector(href);
  if (!target) return;
  const stickyOffset = document.querySelector(".sidebar")?.getBoundingClientRect().height || 0;
  const gap = 14;
  const top = target.getBoundingClientRect().top + window.scrollY - stickyOffset - gap;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function clearTournamentPanels() {
  els.matchList.innerHTML = `<div class="key-item"><strong>正在切换赛事</strong><p>正在读取新赛区赛程...</p></div>`;
  els.phaseCards.innerHTML = "";
  els.standingsBody.innerHTML = "";
  els.analysisText.innerHTML = `<p>正在读取新赛区分析...</p>`;
  els.keyMatches.innerHTML = "";
  els.scenarioMatch.innerHTML = "";
  els.scoreButtons.innerHTML = "";
  els.scenarioResult.textContent = "正在切换赛事，预测面板会随新赛区刷新...";
  if (els.aiEngineSummary) els.aiEngineSummary.textContent = "正在读取新赛区摘要...";
  els.quickQuestions.innerHTML = "";
  state.predictionCards = {};
  state.predictionCardRequests.clear();
}

function resetAgentForTournament() {
  els.chatLog.innerHTML = "";
  addMessage("assistant", `已切换到 ${state.tournament.name}。我会按这个赛区的赛程、签表和规则回答。`);
}

function renderNews() {
  if (!state.news.length) {
    els.newsStage.closest(".news-showcase")?.classList.add("is-empty");
    els.newsStage.closest(".news-showcase")?.classList.remove("is-compact", "is-single", "is-mosaic");
    renderEmptyNews();
    restartNewsTimer(0);
    return;
  }
  const items = state.news;
  const activeIndex = state.newsIndex % items.length;
  const showcase = els.newsStage.closest(".news-showcase");
  showcase?.classList.toggle("is-single", items.length === 1);
  showcase?.classList.toggle("is-compact", items.length > 1 && items.length < 4);
  showcase?.classList.toggle("is-mosaic", items.length >= 4);
  showcase?.classList.remove("is-empty");
  const active = items[activeIndex];
  const activeAttrs = newsLinkAttrs(active.url);
  els.newsStage.innerHTML = `
    <a class="news-hero" href="${escapeHtml(active.url)}"${activeAttrs}>
      <img src="${escapeHtml(active.image)}" alt="${escapeHtml(active.title)}" loading="lazy">
      <div class="news-overlay">
        <p class="eyebrow">Trending</p>
        <h3>${escapeHtml(active.title)}</h3>
        <span>${escapeHtml(active.source || "赛事新闻")} · ${active.publishedAt ? formatDate(active.publishedAt) : "最新"}</span>
      </div>
      <div class="news-controls" aria-hidden="true">
        <button type="button" data-news-step="-1" title="上一条">‹</button>
        <button type="button" data-news-step="1" title="下一条">›</button>
      </div>
      <div class="news-dots">
        ${items.slice(0, 8).map((_, index) => `<i class="${index === activeIndex ? "active" : ""}"></i>`).join("")}
      </div>
    </a>
  `;
  const railItems = newsRailWindow(items, activeIndex);
  els.newsRail.innerHTML = railItems.map(({ item, index }) => `
    <a class="news-tile ${index === activeIndex ? "active" : ""}" href="${escapeHtml(item.url)}"${newsLinkAttrs(item.url)} data-news-index="${index}">
      <img src="${escapeHtml(item.image)}" alt="">
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.source || "新闻源")}</span>
      </div>
    </a>
  `).join("");
  preloadNewsImages(items, activeIndex);
  restartNewsTimer(items.length);
}

function newsRailWindow(items, activeIndex) {
  if (items.length <= 1) return [];
  if (items.length <= 4) return items.map((item, index) => ({ item, index }));
  const indexes = [activeIndex];
  for (let offset = 1; indexes.length < 4; offset += 1) {
    indexes.push((activeIndex + offset) % items.length);
  }
  return indexes.map((index) => ({ item: items[index], index }));
}

function preloadNewsImages(items, activeIndex) {
  for (let offset = 1; offset <= Math.min(3, items.length - 1); offset += 1) {
    const item = items[(activeIndex + offset) % items.length];
    if (!item?.image || state.newsPreloaded.has(item.image)) continue;
    state.newsPreloaded.add(item.image);
    const image = new Image();
    image.src = item.image;
  }
}

function renderEmptyNews() {
  els.newsStage.innerHTML = `
    <div class="news-hero news-empty">
      <img src="/api/news-cover?title=${encodeURIComponent("赛事新闻正在读取")}&source=MatchMind&league=${encodeURIComponent(state.tournament?.id || "default")}" alt="" loading="lazy">
      <div class="news-overlay">
        <p class="eyebrow">Trending</p>
        <h3>赛事新闻正在读取</h3>
        <span>请稍后刷新，或检查本机网络与代理设置</span>
      </div>
    </div>
  `;
  els.newsRail.innerHTML = "";
}

function newsLinkAttrs(url) {
  return String(url || "").startsWith("#") ? "" : ` target="_blank" rel="noopener noreferrer"`;
}

function restartNewsTimer(total) {
  if (state.newsTimer) clearInterval(state.newsTimer);
  if (total <= 1) return;
  state.newsTimer = setInterval(() => {
    state.newsIndex = (state.newsIndex + 1) % total;
    renderNews();
  }, 6000);
}

function renderHeader() {
  const live = state.tournament.matches.filter((match) => match.status === "live").length;
  els.gameLabel.textContent = `${state.tournament.game} · ${state.tournament.stage}`;
  els.tournamentTitle.textContent = state.tournament.name;
  els.sourceText.textContent = sourceSummary();
  renderSourceDiagnostics();
  els.heroSummary.textContent = state.aiUpdating
    ? `${firstLine(state.analysis.summary)}（当前为本地预览，AI 正在联网更新...）`
    : firstLine(state.analysis.summary);
  if (els.tickerText) els.tickerText.textContent = tickerSummary();
  els.liveCount.textContent = live;
  els.keyCount.textContent = state.analysis.keyMatches.filter((item) => item.importance !== "低").length;
  const isPlayoffs = state.tournament.rules.phase === "playoffs";
  if (isPlayoffs) {
    els.advanceSlots.textContent = state.analysis.phaseView?.upcomingCount || 0;
    els.advanceSlotsLabel.textContent = "待赛 BO";
  } else {
    els.advanceSlots.textContent = state.tournament.rules.advanceSlots || 0;
    els.advanceSlotsLabel.textContent = "晋级名额";
  }
}

function tickerSummary() {
  const keyMatch = state.analysis?.keyMatches?.find((item) => item.importance !== "低") || state.analysis?.keyMatches?.[0];
  const focus = state.analysis?.focusStories?.[0];
  const news = state.news?.[state.newsIndex];
  if (state.aiUpdating && keyMatch) {
    return `${keyMatch.left} vs ${keyMatch.right} 正在生成 AI 解读，当前先展示赛程与新闻预览。`;
  }
  if (focus?.headline) return `${focus.headline}  ·  ${firstLine(focus.body)}`;
  if (keyMatch) return `${keyMatch.left} vs ${keyMatch.right} · ${keyMatch.tag} · ${keyMatch.reason}`;
  if (news?.title) return `${news.source || "赛事新闻"} · ${news.title}`;
  return firstLine(state.analysis?.summary || "正在读取赛事焦点...");
}

function renderTournamentTabs() {
  if (!els.tournamentTabs) return;
  const tournaments = sortedVisibleTournaments().slice(0, 12);
  els.tournamentTabs.innerHTML = tournaments.map((item) => `
    <button type="button" data-tournament-id="${escapeHtml(item.id)}" class="${item.id === state.tournament?.id ? "active" : ""}">
      <span>${escapeHtml(shortTournamentName(item.name))}</span>
    </button>
  `).join("");
}

function sortedVisibleTournaments() {
  return state.tournaments
    .filter((item) => !isDemoTournament(item))
    .slice()
    .sort(compareTournamentTabs);
}

function compareTournamentTabs(a, b) {
  const aKey = tournamentTabSortKey(a);
  const bKey = tournamentTabSortKey(b);
  for (let i = 0; i < aKey.length; i += 1) {
    if (aKey[i] < bKey[i]) return -1;
    if (aKey[i] > bKey[i]) return 1;
  }
  return String(a.name || "").localeCompare(String(b.name || ""), "zh-CN");
}

function tournamentTabSortKey(tournament) {
  const text = `${tournament?.name || ""} ${tournament?.stage || ""}`;
  const family = tournamentFamilyRank(text);
  const group = tournamentGroupRank(text);
  const phase = /playoff|淘汰|季后赛/i.test(text) ? 0 : /group|小组/i.test(text) ? 1 : 2;
  const firstMatch = tournament?.matches?.[0]?.startsAt || "";
  return [family, group, phase, firstMatch];
}

function tournamentFamilyRank(text) {
  if (/mid-season|msi|季中/i.test(text)) return 0;
  if (/esports world cup|ewc|电竞世界杯/i.test(text)) return 1;
  if (/\bLCK\b/i.test(text)) return 2;
  if (/\bLPL\b/i.test(text)) return 3;
  if (/\bLEC\b/i.test(text)) return 4;
  if (/\bLCS\b/i.test(text)) return 5;
  return 9;
}

function tournamentGroupRank(text) {
  const match = String(text || "").match(/group\s*([A-D])|([A-D])\s*组/i);
  if (!match) return 0;
  const letter = (match[1] || match[2] || "").toUpperCase();
  return letter.charCodeAt(0) - "A".charCodeAt(0) + 1;
}

function shortTournamentName(name) {
  return String(name || "赛事")
    .replace(/League of Legends/i, "LOL")
    .replace(/\s+/g, " ")
    .trim();
}

function renderSourceDiagnostics() {
  if (!els.sourceDiagnostics) return;
  const diagnostics = state.newsMeta?.sourceDiagnostics || [];
  if (!diagnostics.length) {
    els.sourceDiagnostics.innerHTML = "";
    return;
  }
  const grouped = summarizeSourceDiagnostics(diagnostics);
  els.sourceDiagnostics.innerHTML = grouped.map((item) => `
    <span class="${item.status}" title="${escapeHtml(item.title)}">
      ${escapeHtml(item.label)} ${item.count}
    </span>
  `).join("");
}

function summarizeSourceDiagnostics(diagnostics) {
  const groups = [
    {
      label: "玩加",
      test: (item) => /玩加|wanplus/i.test(`${item.source || ""} ${item.url || ""}`)
    },
    {
      label: "LPL官方",
      test: (item) => /LPL赛事官网|lpl\.qq|lol\.qq/i.test(`${item.source || ""} ${item.url || ""}`)
    },
    {
      label: "搜索",
      test: (item) => {
        const text = `${item.source || ""} ${item.kind || ""}`;
        return /Tavily|搜索|search/i.test(text) && !/玩加|wanplus/i.test(text);
      }
    }
  ];
  const result = groups.map((group) => {
    const matches = diagnostics.filter(group.test);
    const count = matches.reduce((sum, item) => sum + Number(item.count || 0), 0);
    const errors = matches.filter((item) => item.status === "error");
    const status = errors.length ? "warn" : count ? "ok" : "empty";
    return {
      label: group.label,
      count,
      status,
      title: matches.map(sourceDiagnosticTitle).join("\n") || "暂无该源诊断"
    };
  });
  const otherErrors = diagnostics.filter((item) => item.status === "error" && !groups.some((group) => group.test(item)));
  if (otherErrors.length) {
    result.push({
      label: "错误",
      count: otherErrors.length,
      status: "warn",
      title: otherErrors.map(sourceDiagnosticTitle).join("\n")
    });
  }
  return result;
}

function sourceDiagnosticTitle(item) {
  const bits = [
    item.source || item.url || "未知源",
    item.status || "unknown",
    `${item.count || 0}条`,
    item.error || ""
  ].filter(Boolean);
  return bits.join(" · ");
}

function renderFocus() {
  const keyCards = (state.analysis.keyMatches || []).slice(0, 3);
  const focusLabel = state.aiUpdating ? "AI 正在更新" : state.analysis.llmError ? "本地预览" : state.analysis.aiEnhanced ? "AI 关键比赛" : "关键比赛";
  if (keyCards.length) {
    els.focusStrip.innerHTML = keyCards.map((match, index) => {
      const confidence = matchConfidence(match, index);
      return `
        <article class="focus-match-card ${index === 0 ? "is-primary" : ""}">
          <div class="focus-match-top">
            <span>${escapeHtml(match.tag || focusLabel)}</span>
            <strong>${escapeHtml(match.importance || "中")}</strong>
          </div>
          <div class="focus-match-body">
            <div>
              <p>${escapeHtml(formatDate(match.startsAt))}</p>
              <h3>${escapeHtml(match.left)} <em>vs</em> ${escapeHtml(match.right)}</h3>
            </div>
            <span class="focus-match-score">${match.status === "finished" ? "FT" : match.status === "live" ? "LIVE" : "待开"}</span>
          </div>
          <div class="focus-meter" aria-label="AI 关注度">
            <span style="width:${confidence}%"></span>
          </div>
          <p class="focus-match-reason">${escapeHtml(match.reason || "等待 AI 结合赛程、新闻和规则补充解读。")}</p>
          ${state.aiUpdating && index === 0 ? `<p class="ai-updating-line">正在调用 ${escapeHtml(state.provider)} 结合最新新闻、规则证据和赛程重写焦点...</p>` : ""}
        </article>
      `;
    }).join("");
    return;
  }

  const stories = state.analysis.focusStories || [];
  els.focusStrip.innerHTML = stories.map((story) => `
    <article class="focus-card ${story.tone || "watch"}">
      <div>
        <p class="eyebrow">${focusLabel}</p>
        <h3>${escapeHtml(story.headline)}</h3>
        <p>${escapeHtml(story.body)}</p>
        ${state.aiUpdating ? `<p class="ai-updating-line">正在调用 ${escapeHtml(state.provider)} 结合最新新闻、规则证据和赛程重写焦点...</p>` : ""}
      </div>
      <div class="focus-chips">
        ${(story.chips || []).map((chip) => `<span>${escapeHtml(chip)}</span>`).join("")}
      </div>
    </article>
  `).join("");
}

function matchConfidence(match, index) {
  const text = `${match.left || ""}${match.right || ""}${match.tag || ""}${match.importance || ""}`;
  let seed = 0;
  for (let i = 0; i < text.length; i += 1) seed = (seed + text.charCodeAt(i) * (i + 3)) % 997;
  const base = match.importance === "高" ? 68 : match.importance === "中" ? 58 : 48;
  return Math.max(42, Math.min(88, base + (seed % 16) - index * 3));
}

function sourceSummary() {
  const meta = state.meta || {};
  const parts = [meta.source || state.tournament.source || "未知数据源"];
  if (meta.mode === "realtime") parts.push("实时接口");
  if (meta.mode === "fallback") parts.push("已回退");
  if (meta.competitionCount != null) parts.push(`${meta.competitionCount} 个赛事组`);
  if (meta.matchCount != null) parts.push(`${meta.matchCount} 场`);
  if (meta.queryCount != null) parts.push(`${meta.queryCount} 次查询`);
  if (state.tournament?.standingsSource === "official") parts.push("官方积分榜");
  if (state.tournament?.standingsSource === "schedule-derived") parts.push("赛程名单");
  if (meta.updatedAt) parts.push(`更新 ${formatDate(meta.updatedAt)}`);
  if (meta.warning) parts.push(meta.warning);
  if (state.newsMeta?.warning) parts.push(`新闻源提示：${state.newsMeta.warning}`);
  const visibleResearchWarning = (state.analysis?.researchWarnings || [])
    .find((warning) => warning && !/阵容检索|roster/i.test(warning));
  if (visibleResearchWarning) parts.push(visibleResearchWarning);
  return parts.join(" · ");
}

function firstLine(text) {
  return String(text || "").split("\n").filter(Boolean)[0] || "暂无分析。";
}

function renderSchedule() {
  const matches = state.tournament.matches
    .filter((match) => state.filter === "all" || match.status === state.filter)
    .slice()
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  els.matchList.innerHTML = matches.map((match) => {
    const left = teamById(match.teams[0]);
    const right = teamById(match.teams[1]);
    const result = match.result || {};
    return `
      <article class="match-card">
        <div class="match-time">
          <strong>${match.round}</strong><br>
          ${formatDate(match.startsAt)}<br>
          BO${match.bestOf}
        </div>
        <div class="match-teams">
          ${teamLine(left, result.left)}
          ${teamLine(right, result.right)}
        </div>
        <span class="badge ${match.status}">${statusText(match.status)}</span>
      </article>
    `;
  }).join("") || `<div class="key-item"><strong>没有匹配赛程</strong><p>切换筛选条件可以查看其他比赛状态。</p></div>`;
}

function teamLine(team, score) {
  const scoreText = score == null ? "-" : score;
  return `
    <div class="team-row">
      <span class="team-dot" style="background:${team.color}"></span>
      <span class="team-name">${team.name}</span>
      <span class="score">${scoreText}</span>
    </div>
  `;
}

function renderPhase() {
  const phase = state.analysis.phaseView || { type: "standings", rows: state.analysis.teams };
  const hasOfficialStandings = state.tournament?.standingsSource === "official";
  els.phaseEyebrow.textContent = phase.type === "playoffs" ? "Bracket" : hasOfficialStandings ? "Standings" : "Lineup";
  els.phaseTitle.textContent = phase.title || (phase.type === "playoffs" ? "晋级形势" : "积分榜");
  els.standingsTableWrap.hidden = phase.type === "playoffs";
  els.phaseCards.hidden = phase.type !== "playoffs";
  if (phase.type === "playoffs") {
    renderPlayoffPhase(phase);
  } else {
    renderStandingsHeader(hasOfficialStandings);
    renderStandings();
  }
}

function renderStandingsHeader(hasOfficialStandings) {
  const header = els.standingsTableWrap?.querySelector("thead tr");
  if (!header) return;
  header.innerHTML = hasOfficialStandings
    ? `
      <th>排名</th>
      <th>队伍</th>
      <th>赛区</th>
      <th>战绩</th>
      <th>小分</th>
      <th>剩余</th>
      <th>状态</th>
    `
    : `
      <th>名单</th>
      <th>队伍</th>
      <th>赛区</th>
      <th>当前战绩</th>
      <th>小分</th>
      <th>待赛</th>
      <th>状态</th>
    `;
}

function renderStandings() {
  const hasOfficialStandings = state.tournament?.standingsSource === "official";
  els.standingsBody.innerHTML = state.analysis.teams.map((team) => `
    <tr>
      <td><span class="rank">${hasOfficialStandings ? team.rank : "参赛"}</span></td>
      <td><strong>${team.name}</strong></td>
      <td>${team.region}</td>
      <td>${team.wins}-${team.losses}</td>
      <td>${team.differential >= 0 ? "+" : ""}${team.differential}</td>
      <td>${team.remaining}</td>
      <td><span class="status-pill ${team.tone}">${team.status}</span></td>
    </tr>
  `).join("");
}

function renderPlayoffPhase(phase) {
  els.phaseCards.innerHTML = `
    <div class="phase-summary">
      <strong>${escapeHtml(phase.subtitle || "淘汰赛签表")}</strong>
      <span>已完成 ${phase.completedCount || 0} 场 · 待赛 ${phase.upcomingCount || 0} 场</span>
    </div>
    ${phase.warning ? `<div class="phase-summary warning"><strong>签表提示</strong><span>${escapeHtml(phase.warning)}</span></div>` : ""}
    ${phase.waitingTeams?.length ? `<div class="phase-summary"><strong>等待后续签表</strong><span>${phase.waitingTeams.map(escapeHtml).join("、")}</span></div>` : ""}
    ${(phase.cards || []).map((card) => `
      <article class="phase-card ${card.status}">
        <div class="phase-meta">
          <span>${escapeHtml(card.bracket)}</span>
          <strong>${formatDate(card.startsAt)}</strong>
          <em>BO${card.bestOf}</em>
        </div>
        <div class="phase-match">
          <strong>${escapeHtml(card.left)} vs ${escapeHtml(card.right)}</strong>
          <span>${escapeHtml(card.score)}</span>
        </div>
        ${card.stake?.headline ? `<div class="phase-stake">${escapeHtml(card.stake.headline)}</div>` : ""}
        ${state.aiUpdating ? `<div class="phase-stake ai-updating">AI 正在更新这场比赛的独立影响解读</div>` : ""}
        <p>${escapeHtml(card.impact)}</p>
        ${card.researchEvidence?.length ? `
          <div class="phase-evidence">
            <span>规则依据</span>
            ${card.researchEvidence.map((item) => `
              <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.source || item.title)}</a>
            `).join("")}
          </div>
        ` : ""}
      </article>
    `).join("")}
  `;
}

function renderAnalysis() {
  const lines = String(state.analysis.summary || "")
    .split("\n")
    .filter(Boolean);
  const notice = modelNoticeHtml();
  if (state.analysis.llmError) {
    lines.push(`完整 AI 分析暂未返回，已先展示本地规则引擎结果。原因：${friendlyModelError(state.analysis.llmError)}`);
  }
  if (state.modelError && !state.analysis.llmError) {
    lines.push(`模型请求失败：${friendlyModelError(state.modelError)}`);
  }
  if (state.tournament.standingsWarning) {
    lines.push(state.tournament.standingsWarning);
  }
  if (state.tournament.bracketWarning) {
    lines.push(state.tournament.bracketWarning);
  }
  if (state.meta?.warning) {
    lines.push(state.meta.warning);
  }
  els.analysisText.innerHTML = `${notice}${renderMarkdown(lines.join("\n\n"))}`;
  if (els.aiEngineSummary) {
    els.aiEngineSummary.innerHTML = renderEngineSummary(lines);
  }
  els.keyMatches.innerHTML = state.analysis.keyMatches.slice(0, 5).map((match) => `
    <div class="key-item">
      <strong>${match.left} vs ${match.right} · ${match.tag}</strong>
      <p>${formatDate(match.startsAt)} · 重要性 ${match.importance}</p>
      <p>${match.reason}</p>
    </div>
  `).join("") || `<div class="key-item"><strong>暂无关键比赛</strong><p>所有赛程结束后，系统会展示最终形势。</p></div>`;
}

function modelNoticeHtml() {
  const providerName = {
    deepseek: "DeepSeek",
    qwen: "Qwen",
    kimi: "Kimi",
    zhipu: "智谱",
    local: "本地规则引擎"
  }[state.provider] || state.provider;
  if (state.aiUpdating) {
    return `<div class="model-notice active"><strong>${escapeHtml(providerName)} 正在生成</strong><span>当前先展示本地预览，模型返回后会自动替换焦点和关键比赛解读。</span></div>`;
  }
  if (state.provider === "local" || state.aiStatus === "local") {
    return `<div class="model-notice local"><strong>当前使用本地规则引擎</strong><span>可在左侧切换 DeepSeek、Qwen、Kimi 或智谱生成更完整分析。</span></div>`;
  }
  if (state.aiStatus === "ready" && state.analysis?.aiEnhanced) {
    const meta = [
      state.analysis.llmRawLength ? `${state.analysis.llmRawLength} 字` : "",
      state.analysis.aiAppliedFields ? `应用 ${state.analysis.aiAppliedFields} 处` : ""
    ].filter(Boolean).join(" · ");
    return `<div class="model-notice ready"><strong>${escapeHtml(providerName)} 已生成分析</strong><span>${escapeHtml(meta || "模型结果已接管当前页面。")}</span></div>`;
  }
  const reason = friendlyModelError(state.modelError || state.analysis?.llmError || state.aiStatus || "AI did not return usable structured analysis");
  return `<div class="model-notice warn"><strong>${escapeHtml(providerName)} 暂未接管页面</strong><span>${escapeHtml(reason)}</span></div>`;
}

function renderScenarioOptions() {
  const openMatches = upcomingPredictionMatches();
  els.scenarioMatch.innerHTML = openMatches.map((match) => {
    const left = teamById(match.teams[0]).name;
    const right = teamById(match.teams[1]).name;
    return `<option value="${match.id}">${formatDate(match.startsAt)} · ${left} vs ${right} · BO${match.bestOf}</option>`;
  }).join("");
  els.scenarioResult.innerHTML = renderPredictionDashboard(openMatches);
  renderScenarioScoreButtons();
  loadPredictionCards(openMatches);
}

function renderScenarioScoreButtons() {
  const match = state.tournament.matches.find((item) => item.id === els.scenarioMatch.value);
  if (!match) {
    els.scoreButtons.innerHTML = "";
    return;
  }
  els.scoreButtons.innerHTML = `<button data-action="predict">生成深度预测</button>`;
}

function upcomingPredictionMatches() {
  const open = state.tournament.matches
    .filter((match) => match.status !== "finished")
    .slice()
    .sort((a, b) => {
      const aKey = keyMatchRank(a);
      const bKey = keyMatchRank(b);
      if (aKey !== bKey) return aKey - bKey;
      return String(a.startsAt).localeCompare(String(b.startsAt));
    });
  return open.slice(0, 6);
}

function keyMatchRank(match) {
  const label = matchLabel(match).toLowerCase();
  const key = (state.analysis.keyMatches || []).find((item) => `${item.left} vs ${item.right}`.toLowerCase() === label || `${item.right} vs ${item.left}`.toLowerCase() === label);
  if (!key) return 10;
  return key.importance === "高" ? 0 : key.importance === "中" ? 1 : 2;
}

function renderPredictionDashboard(matches) {
  if (!matches.length) {
    return `<div class="prediction-empty"><strong>暂无待赛比赛</strong><p>${escapeHtml(state.tournament.name)} 当前没有未结束比赛，等官方更新下一轮赛程后会自动生成胜率预测。</p></div>`;
  }
  return `
    <div class="prediction-grid">
      ${matches.slice(0, 3).map((match, index) => renderPredictionCard(match, index)).join("")}
    </div>
  `;
}

function renderPredictionCard(match, index) {
  const left = teamById(match.teams[0]);
  const right = teamById(match.teams[1]);
  const aiCard = state.predictionCards[match.id];
  const prediction = aiCard || estimateMatchWinRate(match, index);
  const isLoading = prediction.loading;
  return `
    <article class="prediction-card ${index === 0 ? "is-main" : ""} ${aiCard ? "is-ai" : ""}">
      <div class="prediction-meta">
        <span>${escapeHtml(formatDate(match.startsAt))}</span>
        <strong>${isLoading ? "AI 更新中" : aiCard ? `AI · ${escapeHtml(aiCard.confidence || "中")}置信` : `BO${escapeHtml(match.bestOf || 3)}`}</strong>
      </div>
      <div class="prediction-teams">
        <div>
          <b>${escapeHtml(left.name)}</b>
          <span>${prediction.leftWinRate ?? prediction.left}%</span>
        </div>
        <em>vs</em>
        <div>
          <b>${escapeHtml(right.name)}</b>
          <span>${prediction.rightWinRate ?? prediction.right}%</span>
        </div>
      </div>
      <div class="prediction-bar" aria-label="${escapeHtml(left.name)} 胜率 ${prediction.leftWinRate ?? prediction.left}%">
        <span style="width:${prediction.leftWinRate ?? prediction.left}%"></span>
      </div>
      <p><strong>${escapeHtml(prediction.verdict)}</strong>${escapeHtml(prediction.reason)}</p>
      <ul>
        ${prediction.factors.map((factor) => `<li>${escapeHtml(factor)}</li>`).join("")}
      </ul>
    </article>
  `;
}

function loadPredictionCards(matches) {
  if (!matches.length || state.provider === "local") return;
  const requestTournamentId = state.tournament?.id;
  matches.slice(0, 3).forEach((match) => {
    const key = `${requestTournamentId}:${state.provider}:${match.id}`;
    if (state.predictionCardRequests.has(key) || state.predictionCards[match.id]) return;
    state.predictionCardRequests.add(key);
    state.predictionCards[match.id] = {
      ...estimateMatchWinRate(match, 0),
      loading: true,
      verdict: "AI 正在更新胜率。",
      reason: "正在结合近期赛果、阵容证据、相关新闻和赛程语境重新判断。"
    };
    requestJson("/api/prediction-card", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tournamentId: requestTournamentId,
        matchId: match.id,
        provider: state.provider
      })
    }).then((data) => {
      if (state.tournament?.id !== requestTournamentId) return;
      state.predictionCards[match.id] = data.card;
      renderScenarioOptions();
    }).catch((error) => {
      if (state.tournament?.id !== requestTournamentId) return;
      const local = estimateMatchWinRate(match, 0);
      state.predictionCards[match.id] = {
        ...local,
        confidence: "低",
        verdict: local.verdict,
        reason: `${local.reason} AI 预测暂未返回：${friendlyModelError(error.message)}`
      };
      renderScenarioOptions();
    });
  });
  els.scenarioResult.innerHTML = renderPredictionDashboard(matches);
}

function estimateMatchWinRate(match, index) {
  const left = teamById(match.teams[0]);
  const right = teamById(match.teams[1]);
  const key = (state.analysis.keyMatches || []).find((item) => {
    const a = `${item.left} ${item.right}`.toLowerCase();
    const b = `${left.name} ${right.name}`.toLowerCase();
    const c = `${right.name} ${left.name}`.toLowerCase();
    return a === b || a === c;
  });
  const teams = state.analysis.teams || [];
  const useRankSignal = state.tournament?.standingsSource === "official";
  const leftRank = useRankSignal ? teams.find((team) => team.name === left.name)?.rank || 8 : 8;
  const rightRank = useRankSignal ? teams.find((team) => team.name === right.name)?.rank || 8 : 8;
  const leftRecent = recentMatchScore(left.name);
  const rightRecent = recentMatchScore(right.name);
  let leftRate = 50 + (rightRank - leftRank) * 2.4 + (leftRecent - rightRecent) * 4;
  if (key?.importance === "高") leftRate += index === 0 ? 2 : 0;
  if (/决赛|final/i.test(`${match.round || ""} ${match.stage || ""}`)) leftRate += 1;
  leftRate = Math.round(Math.max(36, Math.min(64, leftRate)));
  const rightRate = 100 - leftRate;
  const favorite = leftRate >= rightRate ? left.name : right.name;
  const underdog = leftRate >= rightRate ? right.name : left.name;
  const favoriteRate = Math.max(leftRate, rightRate);
  const gap = Math.abs(leftRate - rightRate);
  const stage = predictionStageNarrative(match);
  const formLine = predictionFormLine(left.name, right.name, leftRecent, rightRecent);
  const pressureLine = predictionPressureLine(match, favorite, underdog, gap);
  const verdict = gap <= 8
    ? `${left.name} 和 ${right.name} 很接近。`
    : `${favorite} 更被看好。`;
  const reason = gap <= 8
    ? `这不是碾压局，胜负更可能取决于前两局 BP 和谁先把节奏打稳。${stage}`
    : `${favoriteRate}% 的倾向来自近期状态和赛程位置，而不是单纯看队名热度。${stage}`;
  const factors = [
    formLine,
    pressureLine,
    predictionWatchLine(key, match, left.name, right.name)
  ];
  return {
    left: leftRate,
    right: rightRate,
    verdict,
    reason,
    factors
  };
}

function predictionStageNarrative(match) {
  const text = `${match.round || ""} ${match.stage || ""} ${match.bracket || ""}`;
  if (/grand\s*final|总决赛|决赛/i.test(text)) {
    return "这类比赛的意义很直接：谁赢谁把整个阶段收掉，输的一方没有太多解释空间。";
  }
  if (/lower/i.test(text) || /败者组/.test(text)) {
    return "败者组的压力在于没有复活甲，任何一局节奏崩盘都会把整场 BO5 推到悬崖边。";
  }
  if (/upper/i.test(text) || /胜者组/.test(text)) {
    return "胜者组的价值在于少打一轮、少暴露一轮准备，输掉则会把容错交出去。";
  }
  return "这场的核心不是账面排名，而是谁能在当前版本和 BO5 调整里先打出自己的节奏。";
}

function predictionFormLine(leftName, rightName, leftRecent, rightRecent) {
  const leftText = trendText(leftRecent);
  const rightText = trendText(rightRecent);
  if (Math.abs(leftRecent - rightRecent) < 0.8) {
    return `状态面：${leftName} 和 ${rightName} 最近都没有明显断档，开局资源团会很能说明问题。`;
  }
  const better = leftRecent > rightRecent ? leftName : rightName;
  const worse = leftRecent > rightRecent ? rightName : leftName;
  return `状态面：${better} 近期曲线更顺，${worse} 需要先把前期失误压下来。(${leftName} ${leftText}，${rightName} ${rightText})`;
}

function trendText(score) {
  if (score >= 3) return "连胜感强";
  if (score >= 1) return "走势偏热";
  if (score > -1) return "状态中性";
  if (score > -3) return "有波动";
  return "压力偏大";
}

function predictionPressureLine(match, favorite, underdog, gap) {
  const text = `${match.round || ""} ${match.stage || ""} ${match.bracket || ""}`;
  if (/grand\s*final|总决赛|决赛/i.test(text)) {
    return `比赛面：这是冠军局，${favorite} 不能只靠稳定运营，${underdog} 想翻盘就要把 BO5 拖成拉扯和临场调整。`;
  }
  if (/lower/i.test(text) || /败者组/.test(text)) {
    return `比赛面：生死线会放大失误，${underdog} 如果前两局还找不到突破口，后面会越来越难打。`;
  }
  if (gap <= 8) {
    return "比赛面：胜率差很小，谁能先拿到舒适阵容、谁能在中期少送一波，可能就够决定系列赛。";
  }
  return `比赛面：${favorite} 的优势在稳定性，${underdog} 的机会在抢开局节奏，不能等到中后期被慢慢磨死。`;
}

function predictionWatchLine(key, match, leftName, rightName) {
  const cleaned = cleanPredictionReason(key?.reason);
  if (cleaned) return `看点：${cleaned}`;
  const round = match.round || match.stage || "这场 BO5";
  return `看点：${round} 里最值得盯的是第一条先锋和前两条小龙，谁先拿到地图主动权，谁就更容易把系列赛带进自己的节奏。`;
}

function cleanPredictionReason(value) {
  const text = firstLine(value || "")
    .replace(/这场\s*[^，。；;]*?的胜者将[^。；;]*[。；;]?/g, "")
    .replace(/败者将[^。；;]*[。；;]?/g, "")
    .replace(/后续[^。；;]*官方[^。；;]*[。；;]?/g, "")
    .replace(/等待官方[^。；;]*[。；;]?/g, "")
    .replace(/以官方[^。；;]*为准[。；;]?/g, "")
    .trim();
  if (!text || text.length < 8) return "";
  return text.slice(0, 80);
}

function recentMatchScore(teamName) {
  const finished = state.tournament.matches
    .filter((match) => match.status === "finished" && match.teams.some((teamId) => teamById(teamId).name === teamName))
    .slice()
    .sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)))
    .slice(0, 4);
  return finished.reduce((score, match) => {
    const idx = match.teams.findIndex((teamId) => teamById(teamId).name === teamName);
    const leftScore = Number(match.result?.left ?? 0);
    const rightScore = Number(match.result?.right ?? 0);
    const won = idx === 0 ? leftScore > rightScore : rightScore > leftScore;
    const diff = idx === 0 ? leftScore - rightScore : rightScore - leftScore;
    return score + (won ? 1 : -1) + Math.max(-2, Math.min(2, diff)) * 0.35;
  }, 0);
}

function renderEngineSummary(lines) {
  const summary = lines.slice(0, 3).join("\n\n") || state.analysis.summary || "暂无 AI 摘要。";
  const focus = (state.analysis.focusStories || []).slice(0, 2);
  return `
    <div class="engine-summary-copy">${renderMarkdown(summary)}</div>
    ${focus.length ? `<div class="engine-summary-points">
      ${focus.map((story) => `<p><strong>${escapeHtml(story.headline)}</strong><span>${escapeHtml(firstLine(story.body))}</span></p>`).join("")}
    </div>` : ""}
  `;
}

function renderQuickQuestions() {
  const questions = buildQuickQuestions();
  els.quickQuestions.innerHTML = questions.map((item) => `
    <button type="button" data-question="${escapeHtml(item.question)}">${escapeHtml(item.label)}</button>
  `).join("");
}

function buildQuickQuestions() {
  const questions = [];
  const focusStories = state.analysis.focusStories || [];
  focusStories.slice(0, 2).forEach((story) => {
    const label = (story.chips?.[0] || story.headline || "赛区焦点").slice(0, 8);
    questions.push({
      label,
      question: `${story.headline} 请像赛前专栏一样详细分析：谁是黑马，谁更被看好，胜负手是什么？`
    });
  });
  questions.push(
    { label: "整体形势", question: `${state.tournament.name} 现在整体晋级形势如何？` },
    { label: "关键比赛", question: `${state.tournament.name} 接下来哪场比赛最关键？` }
  );
  if (state.tournament.rules?.phase === "playoffs") {
    const stakeCard = state.analysis.phaseView?.cards?.find((card) => card.stake?.headline);
    const next = state.tournament.matches.find((match) => match.status !== "finished");
    if (stakeCard) {
      questions.push({
        label: "关键权益",
        question: `${stakeCard.left} vs ${stakeCard.right} 这场 ${stakeCard.score} 的结果意味着什么？`
      });
    }
    if (next) {
      questions.push({
        label: "下一场影响",
        question: `${matchLabel(next)} 这场会影响哪些队伍的晋级路径？`
      });
    } else {
      questions.push({
        label: "后续签表",
        question: `${state.tournament.name} 后续签表和晋级路径怎么看？`
      });
    }
  } else {
    const teams = state.analysis.teams || [];
    const cutTeam = teams.find((team) => /观察区|骑士|晋级|季后赛|直通/.test(team.status || "")) || teams[0];
    const leader = teams[0];
    if (cutTeam) {
      questions.push({
        label: `${cutTeam.name} 条件`,
        question: `${cutTeam.name} 的晋级条件是什么？`
      });
    }
    if (leader && leader.name !== cutTeam?.name) {
      questions.push({
        label: `${leader.name} 主动权`,
        question: `${leader.name} 现在还有主动权吗？`
      });
    }
  }
  return questions.slice(0, 4);
}

function matchLabel(match) {
  const left = teamById(match.teams[0])?.name || "左侧队伍";
  const right = teamById(match.teams[1])?.name || "右侧队伍";
  return `${left} vs ${right}`;
}

function renderMarkdown(value) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const blocks = [];
  const lines = text.split("\n");
  let list = [];
  const flushList = () => {
    if (!list.length) return;
    blocks.push(`<ul>${list.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushList();
      const level = Math.min(4, heading[1].length + 2);
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/) || line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flushList();
    blocks.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }
  flushList();
  return blocks.join("");
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function addMessage(role, text) {
  const message = document.createElement("div");
  message.className = `message ${role}`;
  setRichText(message, text, role === "assistant");
  els.chatLog.appendChild(message);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function setRichText(element, text, markdown = true) {
  if (markdown) {
    element.innerHTML = renderMarkdown(text);
  } else {
    element.textContent = text;
  }
}

async function ask(question) {
  if (!question.trim()) return;
  const requestTournamentId = state.tournament.id;
  addMessage("user", question);
  els.questionInput.value = "";
  const waiting = document.createElement("div");
  waiting.className = "message assistant";
  waiting.textContent = "正在结合赛程、积分和晋级规则分析...";
  els.chatLog.appendChild(waiting);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
  try {
    const data = await requestJson("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        tournamentId: state.tournament.id,
        provider: state.provider
      })
    });
    if (state.tournament.id !== requestTournamentId) {
      waiting.remove();
      return;
    }
    setRichText(waiting, data.answer, true);
  } catch (error) {
    if (state.tournament.id !== requestTournamentId) {
      waiting.remove();
      return;
    }
    waiting.textContent = `分析失败：${error.message}`;
  }
}

els.tournamentSelect.addEventListener("change", (event) => {
  loadAnalysis(event.target.value).catch((error) => {
    els.heroSummary.textContent = `加载失败：${error.message}`;
  });
});

if (els.tournamentTabs) {
  els.tournamentTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tournament-id]");
    if (!button || button.dataset.tournamentId === state.tournament?.id) return;
    loadAnalysis(button.dataset.tournamentId).catch((error) => {
      els.heroSummary.textContent = `加载失败：${error.message}`;
    });
  });
}

if (els.aiEngineTabs) {
  els.aiEngineTabs.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (!button) return;
    state.activeNav = "#aiEngine";
    state.aiEngineTab = button.dataset.tab;
    renderAiEngineTabs();
  });
}

document.querySelectorAll(".nav a").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const href = link.getAttribute("href") || "#overview";
    state.activeNav = href;
    if (link.dataset.engineTab) {
      state.aiEngineTab = link.dataset.engineTab;
    }
    renderAiEngineTabs();
    scrollToSection(href);
  });
});

els.providerSelect.addEventListener("change", (event) => {
  state.provider = event.target.value;
  state.predictionCards = {};
  state.predictionCardRequests.clear();
  loadAnalysis().catch((error) => {
    els.heroSummary.textContent = `模型分析失败：${error.message}`;
  });
});

els.refreshButton.addEventListener("click", async () => {
  if (state.refreshing) return;
  setRefreshing(true, "正在刷新赛事、新闻和 AI 分析...");
  setAgentStep("schedule", "active");
  setAgentStep("news", "active");
  setAgentStep("research", state.provider === "local" ? "idle" : "active");
  setAgentStep("model", state.provider === "local" ? "idle" : "active");
  try {
    await loadTournaments({ refresh: true });
  } catch (error) {
    els.heroSummary.textContent = `刷新失败：${friendlyModelError(error.message)}`;
    setAgentStep("schedule", "warn");
    setAgentStep("news", "warn");
    setAgentStep("research", "warn");
    setAgentStep("model", "warn");
  } finally {
    setRefreshing(false);
  }
});

els.scheduleFilter.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  state.filter = button.dataset.filter;
  els.scheduleFilter.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
  renderSchedule();
});

els.newsStage.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  event.preventDefault();
  const total = state.news.length;
  if (!total) return;
  const step = Number(button.dataset.newsStep || 0);
  state.newsIndex = (state.newsIndex + step + total) % total;
  renderNews();
});

els.newsRail.addEventListener("click", (event) => {
  const tile = event.target.closest("[data-news-index]");
  if (!tile) return;
  event.preventDefault();
  const index = Number(tile.dataset.newsIndex);
  if (!Number.isInteger(index) || index < 0 || index >= state.news.length) return;
  state.newsIndex = index;
  renderNews();
});

els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  ask(els.questionInput.value);
});

els.quickQuestions.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  ask(button.dataset.question);
});

els.scenarioMatch.addEventListener("change", renderScenarioScoreButtons);

els.scoreButtons.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const matchId = els.scenarioMatch.value;
  if (!matchId) return;
  const requestTournamentId = state.tournament.id;
  if (button.dataset.action === "predict") {
    els.scenarioResult.textContent = state.provider === "local"
      ? "正在生成本地赛前预测..."
      : "正在调用模型生成赛前预测...";
    try {
      const data = await requestJson("/api/prediction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tournamentId: state.tournament.id,
          matchId,
          provider: state.provider
        })
      });
      if (state.tournament.id !== requestTournamentId || els.scenarioMatch.value !== matchId) return;
      els.scenarioResult.innerHTML = renderMarkdown(data.prediction);
    } catch (error) {
      if (state.tournament.id !== requestTournamentId || els.scenarioMatch.value !== matchId) return;
      els.scenarioResult.textContent = `预测失败：${error.message}`;
    }
    return;
  }
  els.scenarioResult.textContent = "正在重算假设结果...";
  const scenario = {
    [matchId]: {
      left: Number(button.dataset.left),
      right: Number(button.dataset.right)
    }
  };
  try {
    const data = await requestJson("/api/scenario", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tournamentId: state.tournament.id, scenario })
    });
    if (state.tournament.id !== requestTournamentId || els.scenarioMatch.value !== matchId) return;
    els.scenarioResult.innerHTML = renderMarkdown(data.scenarioText || firstLine(data.analysis.summary));
  } catch (error) {
    if (state.tournament.id !== requestTournamentId || els.scenarioMatch.value !== matchId) return;
    els.scenarioResult.textContent = `推演失败：${error.message}`;
  }
});

els.providerSelect.value = state.provider;

loadTournaments()
  .then(() => {
    addMessage("assistant", "我已经读取赛事数据。你可以问某支队伍的晋级条件、关键比赛，或者假设某场比赛结果会怎样影响排名。");
  })
  .catch((error) => {
    els.heroSummary.textContent = `初始化失败：${error.message}`;
  });
