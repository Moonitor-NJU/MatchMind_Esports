const state = {
  tournaments: [],
  tournament: null,
  analysis: null,
  meta: null,
  filter: "all",
  provider: "deepseek"
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
  scenarioResult: document.querySelector("#scenarioResult"),
  chatLog: document.querySelector("#chatLog"),
  chatForm: document.querySelector("#chatForm"),
  questionInput: document.querySelector("#questionInput")
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
  els.tournamentSelect.innerHTML = state.tournaments
    .map((item) => `<option value="${item.id}">${item.name}</option>`)
    .join("");
  const preferredId = state.tournaments.some((item) => item.id === state.tournament?.id)
    ? state.tournament.id
    : state.tournaments[0]?.id;
  await loadAnalysis(preferredId, options);
}

async function loadAnalysis(tournamentId = state.tournament?.id, options = {}) {
  els.heroSummary.textContent = "正在重新计算赛程影响和晋级形势...";
  const params = new URLSearchParams({
    tournament: tournamentId,
    provider: state.provider
  });
  if (options.refresh) params.set("refresh", "1");
  const data = await requestJson(`/api/analyze?${params.toString()}`);
  state.tournament = data.tournament;
  state.analysis = data.analysis;
  state.meta = data.meta || state.meta;
  els.tournamentSelect.value = state.tournament.id;
  renderAll();
}

function renderAll() {
  renderHeader();
  renderFocus();
  renderSchedule();
  renderPhase();
  renderAnalysis();
  renderScenarioOptions();
}

function renderHeader() {
  const live = state.tournament.matches.filter((match) => match.status === "live").length;
  els.gameLabel.textContent = `${state.tournament.game} · ${state.tournament.stage}`;
  els.tournamentTitle.textContent = state.tournament.name;
  els.sourceText.textContent = sourceSummary();
  els.heroSummary.textContent = firstLine(state.analysis.summary);
  els.liveCount.textContent = live;
  els.keyCount.textContent = state.analysis.keyMatches.filter((item) => item.importance !== "低").length;
  els.advanceSlots.textContent = state.tournament.rules.phase === "playoffs" ? state.analysis.phaseView?.upcomingCount || 0 : state.tournament.rules.advanceSlots;
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
  els.analysisText.innerHTML = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
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
    return `<option value="${match.id}">${formatDate(match.startsAt)} · ${left} vs ${right}</option>`;
  }).join("");
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
  message.textContent = text;
  els.chatLog.appendChild(message);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

async function ask(question) {
  if (!question.trim()) return;
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
    waiting.textContent = data.answer;
  } catch (error) {
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

els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  ask(els.questionInput.value);
});

document.querySelectorAll(".quick-questions button").forEach((button) => {
  button.addEventListener("click", () => ask(button.dataset.question));
});

document.querySelectorAll(".score-buttons button").forEach((button) => {
  button.addEventListener("click", async () => {
    const matchId = els.scenarioMatch.value;
    if (!matchId) return;
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
      const match = state.tournament.matches.find((item) => item.id === matchId);
      const left = teamById(match.teams[0]).name;
      const right = teamById(match.teams[1]).name;
      const top = data.analysis.teams.slice(0, state.tournament.rules.advanceSlots).map((team) => `${team.rank}.${team.name}(${team.wins}-${team.losses})`).join("  ");
      els.scenarioResult.textContent = `假设 ${left} ${scenario[matchId].left}:${scenario[matchId].right} ${right}\n晋级区将变为：${top}\n${firstLine(data.analysis.summary)}`;
    } catch (error) {
      els.scenarioResult.textContent = `推演失败：${error.message}`;
    }
  });
});

els.providerSelect.value = state.provider;

loadTournaments()
  .then(() => {
    addMessage("assistant", "我已经读取赛事数据。你可以问某支队伍的晋级条件、关键比赛，或者假设某场比赛结果会怎样影响排名。");
  })
  .catch((error) => {
    els.heroSummary.textContent = `初始化失败：${error.message}`;
  });
