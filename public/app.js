const state = {
  tournaments: [],
  tournament: null,
  analysis: null,
  meta: null,
  news: [],
  newsIndex: 0,
  newsTimer: null,
  newsPreloaded: new Set(),
  filter: "all",
  provider: "local",
  analysisRequestId: 0
};

const els = {
  tournamentSelect: document.querySelector("#tournamentSelect"),
  providerSelect: document.querySelector("#providerSelect"),
  sourceText: document.querySelector("#sourceText"),
  gameLabel: document.querySelector("#gameLabel"),
  tournamentTitle: document.querySelector("#tournamentTitle"),
  refreshButton: document.querySelector("#refreshButton"),
  heroSummary: document.querySelector("#heroSummary"),
  liveCount: document.querySelector("#liveCount"),
  keyCount: document.querySelector("#keyCount"),
  advanceSlots: document.querySelector("#advanceSlots"),
  advanceSlotsLabel: document.querySelector("#advanceSlotsLabel"),
  newsStage: document.querySelector("#newsStage"),
  newsRail: document.querySelector("#newsRail"),
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
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadTournaments(options = {}) {
  const data = await requestJson(`/api/tournaments${options.refresh ? "?refresh=1" : ""}`);
  state.tournaments = data.tournaments;
  state.meta = data.meta || null;
  state.newsIndex = 0;
  els.tournamentSelect.innerHTML = state.tournaments
    .map((item) => `<option value="${item.id}">${item.name}</option>`)
    .join("");
  const preferredId = state.tournaments.some((item) => item.id === state.tournament?.id)
    ? state.tournament.id
    : state.tournaments[0]?.id;
  await loadAnalysis(preferredId, options);
}

async function loadNews(options = {}) {
  const params = new URLSearchParams();
  if (options.refresh) params.set("refresh", "1");
  if (options.tournamentId || state.tournament?.id) params.set("tournament", options.tournamentId || state.tournament.id);
  const data = await requestJson(`/api/news${params.toString() ? `?${params.toString()}` : ""}`);
  state.news = data.items || [];
  state.newsIndex = 0;
  state.newsPreloaded.clear();
  renderNews();
}

async function loadAnalysis(tournamentId = state.tournament?.id, options = {}) {
  const requestId = ++state.analysisRequestId;
  const previousTournamentId = state.tournament?.id;
  const switchingTournament = previousTournamentId && tournamentId && previousTournamentId !== tournamentId;
  if (switchingTournament) clearTournamentPanels();
  els.heroSummary.textContent = "正在重新计算赛程影响和晋级形势...";
  const params = new URLSearchParams({
    tournament: tournamentId,
    provider: state.provider
  });
  if (options.refresh) params.set("refresh", "1");
  const data = await requestJson(`/api/analyze?${params.toString()}`);
  if (requestId !== state.analysisRequestId) return;
  state.tournament = data.tournament;
  state.analysis = data.analysis;
  state.meta = data.meta || state.meta;
  els.tournamentSelect.value = state.tournament.id;
  renderAll();
  if (switchingTournament) resetAgentForTournament();
  loadNews({ refresh: options.refresh, tournamentId: state.tournament.id }).catch(() => {
    state.news = [];
    renderNews();
  });
}

function renderAll() {
  renderHeader();
  renderNews();
  renderFocus();
  renderSchedule();
  renderPhase();
  renderAnalysis();
  renderScenarioOptions();
  renderQuickQuestions();
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
  els.quickQuestions.innerHTML = "";
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
      <img src="/api/news-cover?title=${encodeURIComponent("暂无可展示国内新闻")}&source=MatchMind&league=${encodeURIComponent(state.tournament?.id || "default")}" alt="" loading="lazy">
      <div class="news-overlay">
        <p class="eyebrow">Trending</p>
        <h3>暂无可展示国内新闻</h3>
        <span>请稍后刷新，或检查网络与新闻源配置</span>
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
  els.heroSummary.textContent = firstLine(state.analysis.summary);
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

function renderFocus() {
  const stories = state.analysis.focusStories || [];
  els.focusStrip.innerHTML = stories.map((story) => `
    <article class="focus-card ${story.tone || "watch"}">
      <div>
        <p class="eyebrow">赛区焦点</p>
        <h3>${escapeHtml(story.headline)}</h3>
        <p>${escapeHtml(story.body)}</p>
      </div>
      <div class="focus-chips">
        ${(story.chips || []).map((chip) => `<span>${escapeHtml(chip)}</span>`).join("")}
      </div>
    </article>
  `).join("");
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
  if (state.tournament?.standingsSource === "schedule-derived") parts.push("近期赛程推算榜");
  if (meta.updatedAt) parts.push(`更新 ${formatDate(meta.updatedAt)}`);
  if (meta.warning) parts.push(meta.warning);
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
  els.phaseEyebrow.textContent = phase.type === "playoffs" ? "Bracket" : "Standings";
  els.phaseTitle.textContent = phase.title || (phase.type === "playoffs" ? "晋级形势" : "积分榜");
  els.standingsTableWrap.hidden = phase.type === "playoffs";
  els.phaseCards.hidden = phase.type !== "playoffs";
  if (phase.type === "playoffs") {
    renderPlayoffPhase(phase);
  } else {
    renderStandings();
  }
}

function renderStandings() {
  els.standingsBody.innerHTML = state.analysis.teams.map((team) => `
    <tr>
      <td><span class="rank">${team.rank}</span></td>
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
        <p>${escapeHtml(card.impact)}</p>
      </article>
    `).join("")}
  `;
}

function renderAnalysis() {
  const lines = String(state.analysis.summary || "")
    .split("\n")
    .filter(Boolean);
  if (state.analysis.llmError) {
    lines.push(`模型接口暂不可用，已使用本地规则引擎回答。错误：${state.analysis.llmError}`);
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
  els.analysisText.innerHTML = renderMarkdown(lines.join("\n\n"));
  els.keyMatches.innerHTML = state.analysis.keyMatches.slice(0, 5).map((match) => `
    <div class="key-item">
      <strong>${match.left} vs ${match.right} · ${match.tag}</strong>
      <p>${formatDate(match.startsAt)} · 重要性 ${match.importance}</p>
      <p>${match.reason}</p>
    </div>
  `).join("") || `<div class="key-item"><strong>暂无关键比赛</strong><p>所有赛程结束后，系统会展示最终形势。</p></div>`;
}

function renderScenarioOptions() {
  const openMatches = state.tournament.matches.filter((match) => match.status !== "finished");
  els.scenarioMatch.innerHTML = openMatches.map((match) => {
    const left = teamById(match.teams[0]).name;
    const right = teamById(match.teams[1]).name;
    return `<option value="${match.id}">${formatDate(match.startsAt)} · ${left} vs ${right} · BO${match.bestOf}</option>`;
  }).join("");
  els.scenarioResult.textContent = openMatches.length
    ? `已切换到 ${state.tournament.name}。选择未赛比赛后可做 AI 预测或比分推演。`
    : `${state.tournament.name} 当前没有未赛比赛，预测面板会等待官方后续赛程更新。`;
  renderScenarioScoreButtons();
}

function renderScenarioScoreButtons() {
  const match = state.tournament.matches.find((item) => item.id === els.scenarioMatch.value);
  if (!match) {
    els.scoreButtons.innerHTML = "";
    return;
  }
  const target = Math.floor(Number(match.bestOf || 3) / 2) + 1;
  const scores = [];
  for (let loser = 0; loser < target; loser += 1) scores.push({ left: target, right: loser });
  for (let loser = target - 1; loser >= 0; loser -= 1) scores.push({ left: loser, right: target });
  els.scoreButtons.innerHTML = [
    `<button data-action="predict">AI 预测</button>`,
    ...scores.map((score) => {
      const side = score.left > score.right ? "左" : "右";
      return `<button data-left="${score.left}" data-right="${score.right}">${side} ${score.left}:${score.right}</button>`;
    })
  ].join("");
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

els.providerSelect.addEventListener("change", (event) => {
  state.provider = event.target.value;
  loadAnalysis().catch((error) => {
    els.heroSummary.textContent = `模型分析失败：${error.message}`;
  });
});

els.refreshButton.addEventListener("click", () => {
  loadTournaments({ refresh: true }).catch((error) => {
    els.heroSummary.textContent = `刷新失败：${error.message}`;
  });
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
