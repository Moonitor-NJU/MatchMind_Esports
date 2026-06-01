const PROVIDERS = {
  deepseek: {
    keyEnv: "DEEPSEEK_API_KEY",
    url: "https://api.deepseek.com/chat/completions",
    modelEnv: "DEEPSEEK_MODEL",
    defaultModel: "deepseek-chat"
  },
  qwen: {
    keyEnv: "DASHSCOPE_API_KEY",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    modelEnv: "QWEN_MODEL",
    defaultModel: "qwen-plus"
  },
  kimi: {
    keyEnv: "MOONSHOT_API_KEY",
    url: "https://api.moonshot.cn/v1/chat/completions",
    modelEnv: "KIMI_MODEL",
    defaultModel: "moonshot-v1-8k"
  },
  zhipu: {
    keyEnv: "ZHIPU_API_KEY",
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    modelEnv: "ZHIPU_MODEL",
    defaultModel: "glm-4-flash"
  }
};

const SYSTEM_PROMPT = [
  "你是面向中国观众的电竞赛事数据分析 Agent。必须基于给定结构化数据回答，不要编造未提供的赛果。",
  "若 contextGuardrail 标明当前是季后赛/淘汰赛，严禁把 0-0 当常规赛战绩，严禁说官方排名第几、小分、晋级线胜场差；必须改用 phaseView.cards、已结束比分、未赛 BO、胜败者组路径和 rules 分析。",
  "若 standingsSource 不是 official，只能说明这是近期赛程推算，不能宣称锁定晋级或理论淘汰。",
  "分析晋级形势时必须同时考虑赛制 rules、官方排名、小分/局分和加赛规则；不确定时明确说明以官方公告为准。",
  "用中文，结论明确，适合网页展示。"
].join("");

async function callLlm(provider, prompt, context) {
  const providerConfig = PROVIDERS[provider] || PROVIDERS.deepseek;
  const key = process.env[providerConfig.keyEnv];
  if (!key) return null;

  const response = await fetch(providerConfig.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: process.env[providerConfig.modelEnv] || providerConfig.defaultModel,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `结构化数据：${context}\n\n任务：${prompt}` }
      ]
    })
  });
  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status}`);
  }
  const json = await response.json();
  return json.choices?.[0]?.message?.content || null;
}

module.exports = {
  callLlm
};
