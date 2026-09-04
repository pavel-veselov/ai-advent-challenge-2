/* AI Advent — День 3 (способы рассуждения) и День 4 (температура). Чистый JS. */

const METHODS_META = {
  direct: {
    label: "direct",
    hintTitle: "Прямой ответ",
    hintText:
      "Базовая линия — один проход модели без подсказок. Трансформер за один проход делает ограниченное число вычислительных шагов: на простых задачах хватает, на составных модель выпаливает правдоподобный, но непроверенный ответ. Без этой точки отсчёта сравнивать способы не с чем.",
  },
  step_by_step: {
    label: "step_by_step",
    hintTitle: "Пошаговое решение",
    hintText:
      "Chain-of-Thought (Wei et al., 2022): промежуточные шаги — дополнительное вычислительное пространство. Каждый сгенерированный токен становится контекстом для следующих, модель «выгружает мышление на бумагу». Дороже по токенам и времени, но точнее на многошаговых задачах; ошибка на раннем шаге расползается дальше.",
  },
  self_prompt: {
    label: "self_prompt",
    hintTitle: "Самопромптинг",
    hintText:
      "Модель сначала формулирует КАК решать (декомпозиция, ограничения, формат), и только потом решает — экстернализует план решения и сама становится себе промпт-инженером. Слабое место: при переписывании модель может потерять требования исходной задачи — поэтому сгенерированный промпт валидируется автоматически.",
  },
  experts: {
    label: "experts",
    hintTitle: "Консилиум экспертов",
    hintText:
      "Консилиум — ансамбль перспектив: аналитик, инженер и критик смотрят на задачу под разными углами, их ошибки слабо коррелируют, а критик ловит то, что пропустили другие. Цена — втрое больше вызовов. Роли задаются в системном промпте: так рамка роли держится стабильнее.",
  },
  judge: {
    label: "judge",
    hintTitle: "Судья (LLM-as-a-judge)",
    hintText:
      "Когда нет эталонного ответа, качество оценивает отдельный вызов-судья (LLM-as-a-judge, так устроены бенчмарки MT-Bench/AlpacaEval). Судья выставляет оценки и определяет порядок мест: какой способ ответил лучше. Судья — тоже модель и может ошибаться, поэтому его вердикт полезно читать критически.",
  },
};

const state = {
  tasks: [],
  taskId: null, // выбранная встроенная задача (null = своя)
  selectedKind: null,
  taskText: null, // текст текущей задачи (описание / своя)
  solutions: [], // [{method, content, prompt, ...}]
  verdict: null,
  judging: false, // true, пока судья выносит вердикт
};

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------------------
// Загрузка задач
// --------------------------------------------------------------------------
async function loadTasks() {
  try {
    const res = await fetch("/api/tasks");
    if (!res.ok) throw new Error("Не удалось загрузить задачи");
    const data = await res.json();
    state.tasks = data.tasks || [];
    renderTaskSelect();
  } catch (err) {
    showError(`Ошибка загрузки задач: ${err.message}`);
  }
}

// Загрузка списка моделей для селекта в настройках.
async function loadModels() {
  const sel = $("modelSelect");
  let models = null;
  let def = null;
  try {
    const res = await fetch("/api/models");
    if (res.ok) {
      const data = await res.json();
      models = data.models || null;
      def = data.default || null;
    }
  } catch {
    /* список недоступен — уйдём в fallback ниже */
  }
  if (!models || !models.length) {
    models = ["glm-5.3-flash", "deepseek-v4-flash"];
    def = models[models.length - 1];
  }
  sel.innerHTML = "";
  models.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });
  // Прошлый выбор пользователя приоритетнее дефолта сервера.
  const saved = localStorage.getItem("app_model");
  const value = saved && models.includes(saved)
    ? saved
    : def && models.includes(def) ? def : models[0];
  sel.value = value;
  sel.addEventListener("change", () => localStorage.setItem("app_model", sel.value));
}

function renderTaskSelect() {
  const sel = $("taskSelect");
  sel.innerHTML = "";
  // Опция «своя задача»
  const customOpt = document.createElement("option");
  customOpt.value = "custom";
  customOpt.textContent = "✍ Своя задача";
  sel.appendChild(customOpt);
  state.tasks.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = `${t.title} (${t.kind})`;
    sel.appendChild(opt);
  });
  sel.value = "custom";
  handleTaskChange();
}

function handleTaskChange() {
  const val = $("taskSelect").value;
  if (val === "custom") {
    state.taskId = null;
    state.taskText = null;
    $("customPanel").hidden = false;
  } else {
    state.taskId = val;
    state.selectedKind = null;
    const t = state.tasks.find((x) => x.id === val);
    state.taskText = t ? t.description : null;
    $("customPanel").hidden = true;
  }
  // Смена задачи сбрасывает результаты, но текст задачи показываем сразу.
  clearResults();
  renderTaskPanel();
}

// Показывает текст текущей задачи в основной области.
function renderTaskPanel() {
  const panel = $("taskPanel");
  const text = state.taskText || "";
  if (!text) {
    panel.hidden = true;
    return;
  }
  $("taskHeading").textContent = state.taskId
    ? `Задача: ${getTaskTitle()}`
    : "Своя задача";
  $("taskText").textContent = text;
  panel.hidden = false;
}

// --------------------------------------------------------------------------
// Вспомогательные
// --------------------------------------------------------------------------
function showError(msg) {
  const box = $("errorBox");
  box.textContent = msg;
  box.hidden = false;
}
function clearError() {
  $("errorBox").hidden = true;
  $("errorBox").textContent = "";
}

function setLoading(btn, on) {
  btn.disabled = on;
  if (on) {
    btn.classList.add("loading");
    btn.textContent = "Решаем...";
  } else {
    btn.classList.remove("loading");
    btn.textContent = "Решить 4 способами";
  }
}

function getTaskText() {
  if (state.taskId) {
    const t = state.tasks.find((x) => x.id === state.taskId);
    return t ? t.description : "";
  }
  return $("customText").value.trim();
}

function getTaskTitle() {
  if (state.taskId) {
    const t = state.tasks.find((x) => x.id === state.taskId);
    return t ? t.title : "";
  }
  return "Своя задача";
}

function getSelectedModel() {
  const sel = $("modelSelect");
  return sel && sel.value ? sel.value : null;
}

function bodyFor() {
  return state.taskId
    ? { task_id: state.taskId, model: getSelectedModel(), temperature: getTemperature(), max_tokens: getMaxTokens() }
    : { text: $("customText").value.trim(), model: getSelectedModel(), temperature: getTemperature(), max_tokens: getMaxTokens() };
}

function getTemperature() {
  return parseFloat($("temperature").value);
}

function getMaxTokens() {
  return parseInt($("maxTokens").value, 10);
}

// --------------------------------------------------------------------------
// Решение
// --------------------------------------------------------------------------
async function solveAll() {
  clearError();
  const text = getTaskText();
  if (!text) {
    showError("Выберите встроенную задачу или введите текст своей задачи.");
    return;
  }
  state.taskText = text;
  renderTaskPanel();
  const btn = $("solveBtn");
  setLoading(btn, true);
  state.verdict = null;
  // Прячем вердикт прошлого запуска, чтобы он не оставался устаревшим,
  // если судья в этот раз не сможет вынести вердикт.
  $("judgeSection").hidden = true;
  // Прогресс по способам: сервер решает их параллельно, фронт опрашивает
  // /api/progress, пока идёт основной запрос.
  renderSolveProgress([], []);
  // Опрос прогресса обязан остановиться, как только /api/solve вернул ответ:
  // дальше уже выведены карточки решений, и перезаписывать их списком
  // прогресса нельзя (иначе решения не видны, пока судья думает).
  let stopPolling = false;
  const pollTimer = setInterval(async () => {
    if (stopPolling) return;
    try {
      const pr = await fetch("/api/progress");
      if (stopPolling) return;
      if (pr.ok) {
        const pj = await pr.json();
        if (!stopPolling) {
          renderSolveProgress(pj.done || [], pj.running || []);
        }
      }
    } catch {
      /* индикатор прогресса не критичен */
    }
  }, 800);

  try {
    const res = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyFor()),
    });
    if (!res.ok) {
      const err = await readError(res);
      throw new Error(err);
    }
    const data = await res.json();
    // Все 4 способа готовы: гасим опрос прогресса ДО рендера карточек,
    // чтобы он не перезаписал их, пока судья выносит вердикт.
    stopPolling = true;
    clearInterval(pollTimer);
    state.solutions = data.solutions || [];
    renderSolutions();
    renderTaskPanel();
    // Судья запускается автоматически после решения.
    await runJudge();
  } catch (err) {
    showError(`Не удалось решить задачу: ${err.message}`);
    renderEmpty("Задача не решена.");
  } finally {
    if (pollTimer) clearInterval(pollTimer);
    setLoading(btn, false);
  }
}

async function readError(res) {
  try {
    const j = await res.json();
    return j.detail || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// --------------------------------------------------------------------------
// Судья (запускается автоматически)
// --------------------------------------------------------------------------
async function runJudge() {
  if (!state.solutions.length) {
    return;
  }
  try {
    const payload = {
      // Судья всегда работает с temperature=0 и без лимита токенов
      // (эти настройки применяются только к способам рассуждения).
      // completion_tokens и elapsed_ms нужны судье для критериев
      // efficiency и speed.
      solutions: state.solutions.map((s) => ({ method: s.method, content: s.content, completion_tokens: s.completion_tokens, elapsed_ms: s.elapsed_ms })),
    };
    if (state.taskId) {
      payload.task_id = state.taskId;
    } else {
      payload.text = $("customText").value.trim();
    }
    payload.model = getSelectedModel();
    // Пока судья думает — индикатор в секции вердикта и временный
    // бейдж «судья выносит вердикт» на карточках.
    state.judging = true;
    renderJudgeThinking();
    renderSolutions();
    const res = await fetch("/api/judge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await readError(res);
      throw new Error(err);
    }
    state.verdict = await res.json();
    state.judging = false;
    renderJudge();
    // Теперь, когда известны места и флаги «задача решена»,
    // перерисовываем карточки с бейджами.
    renderSolutions();
  } catch (err) {
    showError(`Судья не смог вынести вердикт: ${err.message}`);
    state.judging = false;
    renderSolutions();
    $("judgeSection").hidden = true;
  }
}

// Индикатор «судья думает»: секция судьи со спиннером.
function renderJudgeThinking() {
  const section = $("judgeSection");
  section.hidden = false;
  $("judgeBody").innerHTML =
    `<div class="judge-thinking"><span class="spinner"></span>Судья оценивает решения...</div>`;
}

// --------------------------------------------------------------------------
// Рендеринг
// --------------------------------------------------------------------------
const PROMPT_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="16 18 22 12 16 6"></polyline>' +
  '<polyline points="8 6 2 12 8 18"></polyline>' +
  "</svg>";

const PLACE_TITLES = { 1: "1-е место", 2: "2-е место", 3: "3-е место", 4: "4-е место" };

// Временный бейдж, пока судья думает (state.judging).
function judgingBadge() {
  if (!state.judging) return "";
  return `<span class="badge pending" title="Судья оценивает решения">судья выносит вердикт</span>`;
}

// Бейдж «задача решена» — определяет судья (state.verdict.solved).
// Пока вердикта нет — бейдж не показывается.
function solvedBadge(method) {
  const solved = state.verdict && state.verdict.solved;
  if (!solved || typeof solved[method] !== "boolean") return "";
  return solved[method]
    ? `<span class="badge ok" title="Судья: задача этим способом решена (дан правильный итоговый ответ)">задача решена</span>`
    : `<span class="badge fail" title="Судья: задача этим способом не решена">задача не решена</span>`;
}

// Бейдж с местом способа по ранжированию судьи (state.verdict.ranking).
// Пока вердикта нет — бейдж не показывается.
function placeBadge(method) {
  const ranking = state.verdict && Array.isArray(state.verdict.ranking) ? state.verdict.ranking : null;
  if (!ranking) return "";
  const idx = ranking.indexOf(method);
  if (idx === -1) return "";
  const place = idx + 1;
  const cls = place === 1 ? "ok" : place === 2 ? "good" : "na";
  return `<span class="badge ${cls}">${PLACE_TITLES[place] || place + "-е место"}</span>`;
}

function renderEmpty(msg) {
  $("grid").innerHTML = `<div class="empty-state">${msg}</div>`;
}

// Прогресс решения: ✓ способ готов, ● решается сейчас (при параллельном
// запуске их несколько), ○ ещё не начался.
const SOLVE_ORDER = ["direct", "step_by_step", "self_prompt", "experts"];

function renderSolveProgress(done, running) {
  const doneSet = new Set(done || []);
  const runSet = new Set(running || []);
  const items = SOLVE_ORDER.map((m) => {
    const isDone = doneSet.has(m);
    const isRun = runSet.has(m);
    const cls = isDone ? "p-done" : isRun ? "p-run" : "p-wait";
    const mark = isDone ? "✓" : isRun ? "●" : "○";
    return `<span class="p-item ${cls}">${mark} ${esc(METHODS_META[m].label)}</span>`;
  }).join("");
  renderEmpty(`Идёт решение задачи четырьмя способами...<div class="progress-list">${items}</div>`);
}

function renderSolutions() {
  const grid = $("grid");
  grid.innerHTML = "";
  if (!state.solutions.length) {
    grid.innerHTML = `<div class="empty-state">Решения не получены.</div>`;
    return;
  }

  state.solutions.forEach((sol) => {
    const card = document.createElement("div");
    card.className = "card";
    card.id = `card-${sol.method}`;

    const meta = METHODS_META[sol.method] || { label: sol.method, hintTitle: sol.method, hintText: "" };

    let contentHtml = esc(sol.content || "(пусто)");
    // Для self_prompt дополнительно показываем сгенерированный промпт.
    if (sol.method === "self_prompt" && sol.generated_prompt) {
      contentHtml =
        `<div class="heading">Сгенерированный промпт (1-й вызов)</div>` +
        esc(sol.generated_prompt) +
        `\n\n<div class="heading">Ответ модели (2-й вызов)</div>` +
        contentHtml;
    }

    card.innerHTML = `
      <div class="card-head">
        <div class="card-title">
          <span>${esc(meta.label)}</span>
          <button class="hint-btn prompt-btn" data-prompt="${sol.method}" title="Промпт, отправленный в запросе">${PROMPT_ICON}</button>
          <button class="hint-btn" data-hint="${sol.method}">?</button>
        </div>
        <span class="card-badges">
          ${judgingBadge()}
          ${solvedBadge(sol.method)}
          ${placeBadge(sol.method)}
        </span>
      </div>
      <div class="card-detail">${contentHtml}</div>
      <div class="card-footer">
        <span>finish: ${esc(sol.finish_reason || "—")}</span>
        <span>токены: ${sol.completion_tokens ?? "—"}</span>
        <span>время: ${sol.elapsed_ms != null ? sol.elapsed_ms + " мс" : "—"}</span>
      </div>
    `;

    grid.appendChild(card);
  });
}

// Критерии качества судьи (подписи строк диаграммы).
const CRITERIA_META = [
  { key: "correctness", label: "Корректность" },
  { key: "completeness", label: "Полнота" },
  { key: "reasoning", label: "Обоснованность" },
  { key: "efficiency", label: "Экономность" },
  { key: "speed", label: "Скорость" },
];

// Цвет каждого способа — единый для полос диаграммы и легенды.
const METHOD_COLORS = {
  direct: "#58a6ff",
  step_by_step: "#3fb950",
  self_prompt: "#d29922",
  experts: "#bc8cff",
};

function renderJudge() {
  const section = $("judgeSection");
  section.hidden = false;
  const body = $("judgeBody");
  const v = state.verdict || {};
  const scores = v.scores || {};
  const criteria = v.criteria || {};
  const rationale = v.rationale || "";

  // Порядок мест: из ranking судьи; если поля нет — fallback по оценкам.
  let ranking = Array.isArray(v.ranking) && v.ranking.length ? v.ranking : null;
  if (!ranking) {
    ranking = Object.entries(scores)
      .sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1))
      .map(([m]) => m);
  }

  // Сначала общий вердикт (текст), затем одна общая диаграмма: строки —
  // критерии, внутри каждой — полоска каждого способа своим цветом.
  // Легенда связывает цвет с способом, местом и итоговым баллом.
  const color = (m) => METHOD_COLORS[m] || "#8b949e";

  const legendHtml = ranking
    .map((m, i) => {
      const place = i + 1;
      return `<span class="legend-item">
        <span class="swatch" style="background:${color(m)}"></span>
        <span class="legend-name">${esc(METHODS_META[m]?.label || m)}</span>
        <span class="legend-place">${PLACE_TITLES[place] || place + "-е место"} · ${escapeScore(scores[m])}</span>
      </span>`;
    })
    .join("");

  // 5 критериев (включая экономность по токенам) + строка «Итог» с итоговыми баллами.
  const groupsHtml = [...CRITERIA_META, { key: "total", label: "Итог", isTotal: true }]
    .map(({ key, label, isTotal }) => {
      const bars = ranking
        .map((m) => {
          const c = criteria[m] || {};
          const raw = isTotal ? scores[m] : c[key];
          const val = typeof raw === "number" ? Math.max(0, Math.min(10, raw)) : 0;
          return `<div class="crit-bar" title="${esc(METHODS_META[m]?.label || m)}">
          <span class="bar-track"><span class="bar-fill" style="width:${val * 10}%;background:${color(m)}"></span></span>
          <span class="bar-value">${val}</span>
        </div>`;
        })
        .join("");
      return `<div class="crit-group${isTotal ? " total" : ""}">
      <div class="crit-name">${label}</div>
      <div class="crit-bars">${bars}</div>
    </div>`;
    })
    .join("");

  body.innerHTML = `
    <div class="rationale">${esc(rationale)}</div>
    <div class="combo-chart">
      <div class="chart-legend">${legendHtml}</div>
      ${groupsHtml}
    </div>
  `;
  // У блока судьи иконки «?» и «</>» уже в шапке.
}

function escapeScore(n) {
  if (n === null || n === undefined) return "—";
  return String(n);
}

function clearResults() {
  $("grid").innerHTML = `<div class="empty-state">Выберите задачу и нажмите «Решить 4 способами».</div>`;
  $("judgeSection").hidden = true;
  $("taskPanel").hidden = true;
  state.solutions = [];
  state.verdict = null;
}

function esc(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

// --------------------------------------------------------------------------
// Модалы: подсказки и отправленный промпт
// --------------------------------------------------------------------------
function bindHints() {
  // Подсказка по способу.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-hint]");
    if (!btn) return;
    const key = btn.getAttribute("data-hint");
    const meta = METHODS_META[key];
    if (!meta) return;
    $("hintTitle").textContent = meta.hintTitle;
    $("hintText").textContent = meta.hintText;
    $("hintModal").hidden = false;
  });

  // Показ отправленного промпта.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-prompt]");
    if (!btn) return;
    const key = btn.getAttribute("data-prompt");
    const sol = state.solutions.find((s) => s.method === key);
    if (!sol) return;
    const meta = METHODS_META[key] || { label: key };
    $("promptTitle").textContent = `Промпт (${meta.label})`;
    $("promptText").textContent =
      sol.prompt && String(sol.prompt).trim()
        ? sol.prompt
        : "(промпт не сохранён для этого способа)";
    $("promptModal").hidden = false;
  });

  // Промпт, отправленный судье.
  $("judgePromptBtn").addEventListener("click", () => {
    const v = state.verdict;
    const parts = [];
    if (v && v.prompt && String(v.prompt).trim()) {
      parts.push(v.prompt);
      if (v.retry_prompt) {
        parts.push("=== Повторный запрос (ретрай) ===\n\n" + v.retry_prompt);
      }
    }
    $("promptTitle").textContent = "Промпт (судья)";
    $("promptText").textContent = parts.length
      ? parts.join("\n\n")
      : "(промпт судьи появится после решения задачи)";
    $("promptModal").hidden = false;
  });

  // Промпт, отправленный аналитику температур (День 4).
  $("analysisPromptBtn").addEventListener("click", () => {
    $("promptTitle").textContent = "Промпт (анализ температур)";
    $("promptText").textContent = tempState.analysisPrompt
      ? tempState.analysisPrompt
      : "(промпт аналитика появится после сравнения ответов)";
    $("promptModal").hidden = false;
  });

  // Промпт, отправленный аналитику моделей (День 5).
  $("benchAnalysisPromptBtn").addEventListener("click", () => {
    $("promptTitle").textContent = "Промпт (сравнение моделей)";
    $("promptText").textContent = benchState.analysisPrompt
      ? benchState.analysisPrompt
      : "(промпт аналитика появится после сравнения ответов)";
    $("promptModal").hidden = false;
  });

  function closeModal() {
    $("hintModal").hidden = true;
    $("promptModal").hidden = true;
  }
  $("hintClose").addEventListener("click", closeModal);
  $("hintModal").addEventListener("click", (e) => {
    if (e.target === $("hintModal")) closeModal();
  });
  $("promptClose").addEventListener("click", closeModal);
  $("promptModal").addEventListener("click", (e) => {
    if (e.target === $("promptModal")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

// --------------------------------------------------------------------------
// Вкладки (День 3 / День 4)
// --------------------------------------------------------------------------
const DAY_META = {
  3: { title: "День 3", subtitle: "Разные способы рассуждения" },
  4: { title: "День 4", subtitle: "Температура" },
  5: { title: "День 5", subtitle: "Версии моделей" },
};

function switchDay(day) {
  $("pageDay3").hidden = day !== 3;
  $("mainDay3").hidden = day !== 3;
  $("pageDay4").hidden = day !== 4;
  $("mainDay4").hidden = day !== 4;
  $("pageDay5").hidden = day !== 5;
  $("mainDay5").hidden = day !== 5;
  $("tabDay3").classList.toggle("active", day === 3);
  $("tabDay4").classList.toggle("active", day === 4);
  $("tabDay5").classList.toggle("active", day === 5);
  $("pageTitle").textContent = DAY_META[day].title;
  $("pageSubtitle").textContent = DAY_META[day].subtitle;
}

// --------------------------------------------------------------------------
// День 4: матрица «4 типа задач × температура»
// --------------------------------------------------------------------------
const TEMP_TEMPS = [
  { temperature: 0, label: "t = 0" },
  { temperature: 0.7, label: "t = 0.7" },
  { temperature: 1.2, label: "t = 1.2" },
];

const TEMP_TASK_META = [
  { key: "technical", label: "Техническая", inputId: "tempQueryTechnical" },
  { key: "creative", label: "Творческая", inputId: "tempQueryCreative" },
  { key: "logical", label: "Логическая", inputId: "tempQueryLogical" },
  { key: "analytical", label: "Аналитическая", inputId: "tempQueryAnalytical" },
];

const tempState = {
  queries: {}, // {key: текст задания последнего запуска}
  results: {}, // {technical: {"0.0": {...}, "0.7": {...}, "1.2": {...}}, ...}
  analysis: null,
  analysisPrompt: null, // промпт аналитика (для модала «</>»)
};

function showError4(msg) {
  const box = $("tempErrorBox");
  box.textContent = msg;
  box.hidden = false;
}
function clearError4() {
  $("tempErrorBox").hidden = true;
  $("tempErrorBox").textContent = "";
}

// Панель текущих заданий в основной области: четыре типа одной строкой.
function renderTempQueryPanel() {
  const panel = $("tempQueryPanel");
  if (!Object.keys(tempState.queries).length) {
    panel.hidden = true;
    return;
  }
  $("tempQueryText").innerHTML = TEMP_TASK_META.map(
    (task) =>
      `<div class="qp-row"><span class="qp-label">${esc(task.label)}</span>${esc(tempState.queries[task.key] || "")}</div>`
  ).join("");
  panel.hidden = false;
}

function renderTempEmpty(msg) {
  $("tempGrid").innerHTML = `<div class="empty-state">${msg}</div>`;
}

// Прогресс матрицы: сервер гоняет 12 вызовов параллельно, фронт опрашивает
// /api/temperature-progress, пока идёт основной запрос (как /api/progress
// в Дне 3). Сетка «4 задачи × 3 температуры»: ✓ — ответ получен,
// ● — выполняется, ○ — ещё не стартовал. Идентификатор ячейки на сервере —
// «<тип>:<температура>», температура в строке — toFixed(1) ("0.0", "0.7").
// Когда все 12 ответов собраны, сервер ещё формирует вывод аналитика —
// показываем фазу «Формирую вывод» со скелетоном в блоке анализа.
// Подпись-сигнатура: перерисовываем только при изменении статусов, иначе
// CSS-анимации фазы ожидания перезапускались бы на каждом тике опроса.
let lastTempProgressSig = null;

function renderTempProgress(done, running) {
  const doneArr = done || [];
  const sig = `${doneArr.join(",")}|${(running || []).join(",")}`;
  if (sig === lastTempProgressSig) return;
  lastTempProgressSig = sig;
  const doneSet = new Set(doneArr);
  const runSet = new Set(running || []);
  const total = TEMP_TEMPS.length * TEMP_TASK_META.length;
  const allDone = total > 0 && doneArr.length >= total;
  const head = `<span></span>${TEMP_TEMPS.map(
    (t) => `<span class="tp-head">${esc(t.label)}</span>`
  ).join("")}`;
  const rows = TEMP_TASK_META.map((task) => {
    const cells = TEMP_TEMPS.map(({ temperature }) => {
      const cell = `${task.key}:${temperature.toFixed(1)}`;
      const isDone = doneSet.has(cell);
      const isRun = runSet.has(cell);
      const cls = isDone ? "p-done" : isRun ? "p-run" : "p-wait";
      const mark = isDone ? "✓" : isRun ? "●" : "○";
      return `<span class="tp-cell ${cls}">${mark}</span>`;
    }).join("");
    return `<span class="tp-row-label">${esc(task.label)}</span>${cells}`;
  }).join("");
  const header = allDone
    ? `Все 12 ответов получены.<div class="analysis-pending"><span class="analysis-pending-label">Формирую вывод</span><span class="ap-dots"><i></i><i></i><i></i></span></div>`
    : `Идёт эксперимент: 4 задачи × 3 температуры = 12 параллельных вызовов...`;
  renderTempEmpty(`${header}<div class="tp-matrix">${head}${rows}</div>`);
  if (allDone && $("analysisSection").hidden) renderTempAnalysisSkeleton();
}

// Скелетон блока вывода: виден, пока аналитик работает; renderTempAnalysis
// перезапишет его готовым Markdown-контентом.
function renderTempAnalysisSkeleton() {
  $("analysisSection").hidden = false;
  $("analysisBody").innerHTML =
    '<div class="analysis-skeleton">' +
    '<div class="ap-bar" style="width:38%"></div>' +
    '<div class="ap-bar" style="width:92%"></div>' +
    '<div class="ap-bar" style="width:84%"></div>' +
    '<div class="ap-bar" style="width:62%"></div>' +
    "</div>";
}

function renderTempResults() {
  const grid = $("tempGrid");
  grid.innerHTML = "";
  if (!Object.keys(tempState.results).length) {
    renderTempEmpty("Ответы не получены.");
    return;
  }
  TEMP_TASK_META.forEach((task) => {
    const answers = tempState.results[task.key] || {};
    const cards = TEMP_TEMPS.map(({ temperature, label }) => {
      // Ключи групп — строки из JSON: "0.0" / "0.7" / "1.2". String(0)
      // дал бы "0" и промахнулся мимо "0.0" (t=0 показывал «(пусто)»),
      // поэтому canonical toFixed(1) — как в идентификаторах прогресса.
      const r = answers[temperature.toFixed(1)] || {};
      return `
        <div class="card">
          <div class="card-head">
            <div class="card-title"><span>${esc(label)}</span></div>
          </div>
          <div class="card-detail">${esc(r.content || "(пусто)")}</div>
          <div class="card-footer">
            <span>finish: ${esc(r.finish_reason || "—")}</span>
            <span>токены: ${r.completion_tokens ?? "—"}</span>
            <span>время: ${r.elapsed_ms != null ? r.elapsed_ms + " мс" : "—"}</span>
          </div>
        </div>
      `;
    }).join("");
    const section = document.createElement("section");
    section.className = "temp-task-results";
    section.innerHTML = `
      <h3 class="temp-task-title">${esc(task.label)} задача</h3>
      <div class="grid temp-grid">${cards}</div>
    `;
    grid.appendChild(section);
  });
}

async function runTemperatureExperiment() {
  clearError4();
  const queries = {};
  for (const { key, inputId } of TEMP_TASK_META) {
    queries[key] = $(inputId).value.trim();
  }
  if (Object.values(queries).some((q) => !q)) {
    showError4("Заполните все четыре задания.");
    return;
  }
  tempState.queries = queries;
  tempState.results = {};
  tempState.analysis = null;
  tempState.analysisPrompt = null;
  $("analysisSection").hidden = true;
  renderTempQueryPanel();
  lastTempProgressSig = null;
  renderTempProgress([], []);
  const btn = $("tempRunBtn");
  btn.disabled = true;
  btn.classList.add("loading");
  // Прогресс по ячейкам матрицы: сервер выполняет 12 вызовов параллельно,
  // фронт опрашивает /api/temperature-progress, пока идёт основной запрос.
  // Опрос гасится, как только /api/temp-matrix вернул ответ: дальше уже
  // выведены карточки с готовым выводом аналитика.
  let stopPolling = false;
  const pollTimer = setInterval(async () => {
    if (stopPolling) return;
    try {
      const pr = await fetch("/api/temperature-progress");
      if (stopPolling) return;
      if (pr.ok) {
        const pj = await pr.json();
        if (!stopPolling) {
          renderTempProgress(pj.done || [], pj.running || []);
        }
      }
    } catch {
      /* индикатор прогресса не критичен */
    }
  }, 800);
  try {
    const res = await fetch("/api/temp-matrix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queries,
        model: getSelectedModel(),
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = await res.json();
    // Все 12 вызовов и вывод аналитика готовы: гасим опрос прогресса.
    stopPolling = true;
    clearInterval(pollTimer);
    tempState.results = data.results || {};
    tempState.analysis = data.analysis || "";
    setTempAnalysisPrompt(data.prompt || null);
    renderTempResults();
    renderTempQueryPanel();
    renderTempAnalysis();
  } catch (err) {
    showError4(`Не удалось выполнить эксперимент: ${err.message}`);
    renderTempEmpty("Эксперимент не выполнен.");
    $("analysisSection").hidden = true;
    $("tempQueryPanel").hidden = true;
  } finally {
    stopPolling = true;
    if (pollTimer) clearInterval(pollTimer);
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

// Мини-рендер Markdown для выводов анализа: заголовки (#..####), списки
// (- / 1)), полностью жирные строки-подзаголовки, ---, инлайн **bold**,
// *italic*, `code`. Вход экранируется esc() до разметки, поэтому HTML из
// ответа модели отобразится как текст, а не выполнится.
function mdInline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderAnalysisMarkdown(text) {
  const out = [];
  let list = null; // "ul" | "ol" | null
  let tableBuf = []; // подряд идущие строки таблицы «| a | b |»
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  // Блок markdown-таблицы → <table class="md-table"> (разделитель |---| отбрасывается).
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf
      .map((r) => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()))
      .filter((cells) => cells.some((c) => c !== ""));
    tableBuf = [];
    if (!rows.length) return;
    const isSep = (cells) => cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
    let head = null;
    let body = rows;
    if (rows.length >= 2 && isSep(rows[1])) {
      head = rows[0];
      body = rows.slice(2);
    } else if (isSep(rows[0])) {
      body = rows.slice(1);
    }
    if (head) {
      body = body.map((r) => {
        const cells = r.slice(0, head.length);
        while (cells.length < head.length) cells.push("");
        return cells;
      });
    }
    out.push(
      '<table class="md-table">' +
        (head ? `<thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join("")}</tr></thead>` : "") +
        `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>` +
        "</table>"
    );
  };
  for (const rawLine of esc(text || "").split("\n")) {
    const line = rawLine.trim();
    if (/^\|/.test(line)) {
      closeList();
      tableBuf.push(line);
      continue;
    }
    flushTable();
    if (!line || /^```/.test(line)) {
      closeList();
      continue;
    }
    if (/^---+$/.test(line)) {
      closeList();
      out.push("<hr>");
      continue;
    }
    let m = line.match(/^#{1,4}\s+(.+)$/);
    if (m) {
      closeList();
      out.push(`<h3 class="analysis-h">${mdInline(m[1])}</h3>`);
      continue;
    }
    // Строка целиком в **...** — подзаголовок раздела.
    m = line.match(/^\*\*(.+?)\*\*\s*[:.]?$/);
    if (m) {
      closeList();
      out.push(`<h3 class="analysis-h">${mdInline(m[1])}</h3>`);
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${mdInline(line.replace(/^[-*•]\s+/, ""))}</li>`);
      continue;
    }
    m = line.match(/^\d+[.)]\s+(.+)$/);
    if (m) {
      const rest = m[1];
      // «1) **Точность**» — заголовок из промпта, обычные «1) текст» — ol.
      const bold = rest.match(/^\*\*(.+?)\*\*\s*[:.]?$/);
      if (bold) {
        closeList();
        out.push(`<h3 class="analysis-h">${mdInline(bold[1])}</h3>`);
      } else {
        if (list !== "ol") {
          closeList();
          out.push("<ol>");
          list = "ol";
        }
        out.push(`<li>${mdInline(rest)}</li>`);
      }
      continue;
    }
    closeList();
    out.push(`<p>${mdInline(line)}</p>`);
  }
  closeList();
  flushTable();
  return out.join("");
}

function renderTempAnalysis() {
  $("analysisSection").hidden = false;
  $("analysisBody").innerHTML = `<div class="analysis-content">${renderAnalysisMarkdown(tempState.analysis || "")}</div>`;
}

// Промпт аналитика для модала «</>» (обновляется после каждого анализа).
function setTempAnalysisPrompt(prompt) {
  tempState.analysisPrompt = prompt;
}

// --------------------------------------------------------------------------
// День 5: поэтапный бенчмарк моделей (слабая / средняя / сильная)
// --------------------------------------------------------------------------
// Уровни из MODEL_BENCH_TIERS (main.py): этапы идут по очереди, внутри
// этапа три модели отвечают параллельно; идентификатор ячейки прогресса —
// «<этап>:<уровень>» ("simple:weak", ...).
const BENCH_TIERS = [
  { tier: "weak", label: "Слабая" },
  { tier: "medium", label: "Средняя" },
  { tier: "strong", label: "Сильная" },
];

const BENCH_STAGE_META = [
  { key: "simple", label: "Простая", inputId: "benchQuerySimple" },
  { key: "medium", label: "Средняя", inputId: "benchQueryMedium" },
  { key: "hard", label: "Сложная", inputId: "benchQueryHard" },
];

const benchState = {
  results: {}, // {simple: {weak: {...}, medium: {...}, strong: {...}}, ...}
  analysis: null,
  analysisPrompt: null,
};

function showError5(msg) {
  const box = $("benchErrorBox");
  box.textContent = msg;
  box.hidden = false;
}
function clearError5() {
  $("benchErrorBox").hidden = true;
  $("benchErrorBox").textContent = "";
}

function renderBenchEmpty(msg) {
  $("benchProgress").hidden = true;
  $("benchSummary").hidden = true;
  $("benchSummary").innerHTML = "";
  $("benchResults").innerHTML = `
    <div class="empty-state bench-empty">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l5-10 4 7 3-5 6 8"/><path d="M3 21h18"/></svg>
      <span>${msg}</span>
    </div>
  `;
}

// Прогресс бенчмарка: этапы по очереди, модели внутри этапа параллельно;
// фронт опрашивает /api/models-progress (как матрицу в Дне 4) и рисует
// матрицу «этапы × модели»: ✓ — ответ получен, ● — выполняется,
// ○ — ещё не стартовал. Когда все 9 ответов собраны, сервер ещё формирует
// итоговое сравнение — показываем фазу «Формирую вывод» со скелетоном
// в блоке анализа. Сигнатура гасит лишние перерисовки, чтобы CSS-анимации
// не перезапускались на каждом тике опроса.
let lastBenchProgressSig = null;

function renderBenchProgress(done, running) {
  const doneArr = done || [];
  const sig = `${doneArr.join(",")}|${(running || []).join(",")}`;
  if (sig === lastBenchProgressSig) return;
  lastBenchProgressSig = sig;
  const doneSet = new Set(doneArr);
  const runSet = new Set(running || []);
  const total = BENCH_STAGE_META.length * BENCH_TIERS.length;
  const allDone = total > 0 && doneArr.length >= total;
  const head =
    '<span class="bench-matrix-corner"></span>' +
    BENCH_TIERS.map(
      (t) =>
        `<span class="bench-matrix-head tier-${esc(t.tier)}">${esc(t.label)}</span>`
    ).join("");
  const rows = BENCH_STAGE_META.map((stage) => {
    const doneInStage = BENCH_TIERS.filter(
      ({ tier }) => doneSet.has(`${stage.key}:${tier}`)
    ).length;
    const started =
      doneInStage > 0 ||
      BENCH_TIERS.some(({ tier }) => runSet.has(`${stage.key}:${tier}`));
    const stateKey =
      doneInStage === BENCH_TIERS.length
        ? "done"
        : started
          ? "running"
          : "waiting";
    const stateText =
      stateKey === "done" ? "готов" : stateKey === "running" ? "идёт" : "ждёт";
    const cells = BENCH_TIERS.map(({ tier }) => {
      const cell = `${stage.key}:${tier}`;
      const isDone = doneSet.has(cell);
      const isRun = runSet.has(cell);
      const cls = isDone ? "bench-done" : isRun ? "bench-run" : "bench-wait";
      const mark = isDone ? "✓" : isRun ? "●" : "○";
      const title = isDone ? "Ответ получен" : isRun ? "Выполняется" : "Ожидание";
      return `<span class="bench-cell ${cls}" title="${title}">${mark}</span>`;
    }).join("");
    return `<span class="bench-row-label">${esc(stage.label)}<span class="bench-row-state bench-state-${stateKey}">${stateText}</span></span>${cells}`;
  }).join("");
  const legend = `
    <div class="bench-legend" aria-hidden="true">
      <span><i class="bench-cell bench-done">✓</i> готово</span>
      <span><i class="bench-cell bench-run">●</i> выполняется</span>
      <span><i class="bench-cell bench-wait">○</i> ожидание</span>
    </div>`;
  const header = allDone
    ? `Все 9 ответов получены.<div class="analysis-pending"><span class="analysis-pending-label">Формирую вывод</span><span class="ap-dots"><i></i><i></i><i></i></span></div>`
    : `Идёт бенчмарк: ${doneArr.length} из ${total} ответов`;
  const box = $("benchProgress");
  box.innerHTML = `
    <div class="bench-progress-card">
      <div class="bench-progress-head">${header}</div>
      ${legend}
      <div class="bench-matrix">${head}${rows}</div>
    </div>
  `;
  box.hidden = false;
  if (allDone && $("benchAnalysisSection").hidden) renderBenchAnalysisSkeleton();
}

function renderBenchAnalysisSkeleton() {
  $("benchAnalysisSection").hidden = false;
  $("benchAnalysisBody").innerHTML =
    '<div class="analysis-skeleton">' +
    '<div class="ap-bar" style="width:38%"></div>' +
    '<div class="ap-bar" style="width:92%"></div>' +
    '<div class="ap-bar" style="width:84%"></div>' +
    '<div class="ap-bar" style="width:62%"></div>' +
    "</div>";
}

// Карточки этапов: рендерим все этапы, для которых собраны все три ответа.
// Во время бенчмарка частичные результаты приходят из /api/models-progress —
// этапы появляются на странице один за другим (пошаговая картина);
// после ответа /api/models-bench здесь все три этапа.
let lastBenchResultsSig = null;

function renderBenchResults(results) {
  const grid = $("benchResults");
  const stages = BENCH_STAGE_META.filter((s) => {
    const r = (results || {})[s.key] || {};
    return BENCH_TIERS.every((t) => r[t.tier]);
  });
  const sig = stages.map((s) => s.key).join(",");
  if (sig === lastBenchResultsSig && grid.children.length) return;
  lastBenchResultsSig = sig;
  grid.innerHTML = "";
  if (!stages.length) {
    grid.innerHTML = `<div class="empty-state">Ответы появятся, когда завершится первый этап.</div>`;
    return;
  }
  stages.forEach((stage) => {
    const idx = BENCH_STAGE_META.indexOf(stage) + 1;
    const answers = results[stage.key];
    const cards = BENCH_TIERS.map(({ tier }) => {
      const r = answers[tier] || {};
      const sec =
        r.elapsed_ms != null ? (r.elapsed_ms / 1000).toFixed(1) + " с" : "—";
      // Референсная цена API: {input, output} — USD за 1 млн токенов.
      const pp = r.price_per_million;
      const price =
        pp && pp.input != null && pp.output != null
          ? `$${pp.input}/$${pp.output} за 1M`
          : "бесплатно (шлюз)";
      const finishOk = r.finish_reason === "stop";
      return `
        <article class="card bench-card">
          <div class="card-head">
            <div class="card-title">
              <span class="tier-badge tier-${esc(tier)}">${esc(r.label || tier)}</span>
              <span class="bench-model">${esc(r.model || "—")}</span>
            </div>
            <span class="bench-finish ${finishOk ? "is-ok" : "is-warn"}" title="finish_reason">${esc(r.finish_reason || "—")}</span>
          </div>
          <div class="card-detail">${esc(r.content || "(пусто)")}</div>
          <div class="bench-chips">
            <span class="bench-chip" title="Время генерации ответа"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><b>${sec}</b></span>
            <span class="bench-chip" title="Сгенерировано токенов"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 14l9 5 9-5"/></svg><b>${r.completion_tokens ?? "—"}</b> ток.</span>
            <span class="bench-chip" title="Референсная цена API: вход/вывод за 1 млн токенов (USD)"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4L12 22 2 12V2h10l8.6 8.6a2 2 0 010 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/></svg><b>${esc(price)}</b></span>
          </div>
        </article>
      `;
    }).join("");
    const section = document.createElement("section");
    section.className = "temp-task-results bench-stage-reveal";
    section.innerHTML = `
      <h3 class="temp-task-title">${String(idx).padStart(2, "0")} · ${esc(stage.label)} задача</h3>
      <div class="grid temp-grid">${cards}</div>
    `;
    grid.appendChild(section);
  });
}

// Клиентская сводная таблица «модель × этап»: время генерации и токены
// по каждому этапу + итоги по модели. Показывается, как только собраны все
// 9 ответов (в том числе во время поллинга — до прихода текстового анализа),
// чтобы численную картину можно было читать рядом с качественным сравнением
// аналитика.
let lastBenchSummarySig = null;

// Стоимость прогона в USD: мелкие значения без лишних знаков.
function fmtBenchCost(v) {
  if (v == null || v <= 0) return "—";
  return "$" + (v >= 0.01 ? v.toFixed(2) : v.toFixed(4));
}

function renderBenchSummary(results) {
  const box = $("benchSummary");
  const complete = BENCH_STAGE_META.every((s) => {
    const r = (results || {})[s.key] || {};
    return BENCH_TIERS.every((t) => r[t.tier]);
  });
  if (!complete) {
    if (!box.hidden) {
      box.hidden = true;
      box.innerHTML = "";
      lastBenchSummarySig = null;
    }
    return;
  }
  // Суммарные метрики по каждой модели + самое быстрое время каждого этапа
  // (для подсветки лучшей ячейки).
  const stats = {};
  BENCH_TIERS.forEach(({ tier }) => {
    stats[tier] = { ms: 0, tokens: 0, cost: 0, model: "" };
  });
  const bestMs = {};
  BENCH_STAGE_META.forEach((s) => {
    let min = Infinity;
    BENCH_TIERS.forEach(({ tier }) => {
      const c = (results || {})[s.key][tier];
      if (c.elapsed_ms != null && c.elapsed_ms < min) min = c.elapsed_ms;
    });
    bestMs[s.key] = min;
  });
  BENCH_STAGE_META.forEach((s) => {
    BENCH_TIERS.forEach(({ tier }) => {
      const c = (results || {})[s.key][tier];
      stats[tier].ms += c.elapsed_ms ?? 0;
      stats[tier].tokens += c.completion_tokens ?? 0;
      // Стоимость этапа = токены вывода × референсная цена вывода (USD/1M).
      const outPrice = c.price_per_million && c.price_per_million.output;
      if (outPrice != null && c.completion_tokens != null) {
        stats[tier].cost += (c.completion_tokens / 1e6) * outPrice;
      }
      if (!stats[tier].model && c.model) stats[tier].model = c.model;
    });
  });
  const sig = BENCH_TIERS.map(
    ({ tier }) => `${tier}:${stats[tier].ms}:${stats[tier].tokens}`
  ).join("|");
  if (sig === lastBenchSummarySig && !box.hidden) return;
  lastBenchSummarySig = sig;
  const headCells = BENCH_STAGE_META.map(
    (s) => `<th scope="col">${esc(s.label)}</th>`
  ).join("");
  const rows = BENCH_TIERS.map(({ tier, label }) => {
    const st = stats[tier];
    const cells = BENCH_STAGE_META.map((s) => {
      const c = (results || {})[s.key][tier];
      const isBest = c.elapsed_ms != null && c.elapsed_ms === bestMs[s.key];
      const sec = c.elapsed_ms != null ? (c.elapsed_ms / 1000).toFixed(1) : "—";
      return `<td class="${isBest ? "is-best" : ""}">${sec}<small>· ${c.completion_tokens ?? "—"} ток.</small></td>`;
    }).join("");
    return `<tr>
      <th scope="row"><span class="tier-badge tier-${esc(tier)}">${esc(label)}</span> <span class="bench-model">${esc(st.model)}</span></th>
      ${cells}
      <td class="bench-total">${(st.ms / 1000).toFixed(1)}<small>· ${st.tokens} ток. · ${fmtBenchCost(st.cost)}</small></td>
    </tr>`;
  }).join("");
  box.innerHTML = `
    <h3 class="bench-summary-title">Сводка по метрикам</h3>
    <div class="bench-table-wrap">
      <table class="bench-table">
        <thead>
          <tr><th scope="col">Модель</th>${headCells}<th scope="col">Итого</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="bench-summary-note">Время — генерация ответа, с; зелёным выделена самая быстрая модель этапа. Стоимость в «Итого» = токены вывода × цена вывода по официальным API-прайсам (USD/1M, сент. 2026: DeepSeek $0.28, GLM $0.50; для qwen3.8-27b — ближайший публичный тир qwen3-30b-a3b, $0.431; чип в карточке показывает вход/вывод за 1M).</p>
  `;
  box.hidden = false;
}

async function runBenchExperiment() {
  clearError5();
  const queries = {};
  for (const { key, inputId } of BENCH_STAGE_META) {
    queries[key] = $(inputId).value.trim();
  }
  if (Object.values(queries).some((q) => !q)) {
    showError5("Заполните задания всех трёх этапов.");
    return;
  }
  benchState.results = {};
  benchState.analysis = null;
  benchState.analysisPrompt = null;
  $("benchAnalysisSection").hidden = true;
  $("benchResults").innerHTML = "";
  $("benchSummary").hidden = true;
  $("benchSummary").innerHTML = "";
  lastBenchProgressSig = null;
  lastBenchResultsSig = null;
  lastBenchSummarySig = null;
  renderBenchProgress([], []);
  const btn = $("benchRunBtn");
  btn.disabled = true;
  btn.classList.add("loading");
  // Пошаговая картина: этапы выполняются по очереди, фронт опрашивает
  // /api/models-progress и по мере завершения этапов показывает их карточки
  // (частичные результаты приходят прямо из прогресса). Опрос гасится,
  // как только /api/models-bench вернул ответ с итоговым сравнением.
  let stopPolling = false;
  const pollTimer = setInterval(async () => {
    if (stopPolling) return;
    try {
      const pr = await fetch("/api/models-progress");
      if (stopPolling) return;
      if (pr.ok) {
        const pj = await pr.json();
        if (!stopPolling) {
          renderBenchProgress(pj.done || [], pj.running || []);
          renderBenchResults(pj.results || {});
          renderBenchSummary(pj.results || {});
        }
      }
    } catch {
      /* индикатор прогресса не критичен */
    }
  }, 800);
  try {
    const res = await fetch("/api/models-bench", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = await res.json();
    stopPolling = true;
    clearInterval(pollTimer);
    benchState.results = data.results || {};
    benchState.analysis = data.analysis || "";
    benchState.analysisPrompt = data.prompt || null;
    // Финальное состояние: все ячейки матрицы ✓ + карточки всех этапов.
    const allCells = BENCH_STAGE_META.flatMap((s) =>
      BENCH_TIERS.map((t) => `${s.key}:${t.tier}`)
    );
    renderBenchProgress(allCells, []);
    renderBenchResults(data.results || {});
    renderBenchSummary(data.results || {});
    renderBenchAnalysis();
  } catch (err) {
    showError5(`Не удалось выполнить бенчмарк: ${err.message}`);
    renderBenchEmpty("Бенчмарк не выполнен.");
    $("benchAnalysisSection").hidden = true;
  } finally {
    stopPolling = true;
    if (pollTimer) clearInterval(pollTimer);
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

function renderBenchAnalysis() {
  $("benchAnalysisSection").hidden = false;
  $("benchAnalysisBody").innerHTML = renderBenchReport(benchState.analysis || "");
}

// Отчёт аналитика → нумерованные разделы в стиле сводки.
// Разделы распознаём по заголовкам Markdown (## ...), целиком жирным строкам
// и нумерованным заголовкам из промпта («1) «Качество ответов по этапам»»).
// Строки-рекомендации вида «**Модель** — описание» разделом НЕ считаем:
// у них после жирного заголовка идёт « — ».
function benchReportHeading(line) {
  const t = line.trim();
  let m = t.match(/^#{1,4}\s+(.+)$/);
  if (m) return benchCleanTitle(m[1]);
  m = t.match(/^\*\*(.+?)\*\*\s*[:.]?$/);
  if (m && m[1].length <= 60 && !/\s—\s/.test(m[1])) return benchCleanTitle(m[1]);
  m = t.match(/^\d+[.)]\s+(.+)$/);
  if (m) {
    const rest = m[1].replace(/^\*\*/, "").replace(/\*\*$/, "").replace(/^«/, "").replace(/»\s*[:.]?$/, "").trim();
    if (rest && rest.length <= 60 && !/\s—\s/.test(rest)) return benchCleanTitle(rest);
  }
  return null;
}

function benchCleanTitle(s) {
  return s.replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/^\d+[.)]\s+/, "").replace(/^«/, "").replace(/»$/, "").replace(/\s*[:.]$/, "").trim();
}

function renderBenchReport(text) {
  const sections = [];
  let cur = null;
  for (const raw of (text || "").split("\n")) {
    const line = raw.trim();
    if (!line || /^```/.test(line) || /^-{3,}$/.test(line)) continue;
    const title = benchReportHeading(line);
    if (title) {
      cur = { title, lines: [] };
      sections.push(cur);
    } else {
      if (!cur) {
        cur = { title: null, lines: [] };
        sections.push(cur);
      }
      cur.lines.push(line);
    }
  }
  // Секция без контента (титульный H1 аналитика и т.п.) карточкой не станет.
  const body = sections
    .filter((s) => s.lines.length > 0)
    .map((s, i) => {
      const num = String(i + 1).padStart(2, "0");
      const title = s.title || "Выводы";
      return `
        <section class="report-card">
          <h4 class="report-title"><span class="report-num">${num}</span>${mdInline(title)}</h4>
          <div class="report-content"><div class="analysis-content">${renderAnalysisMarkdown(s.lines.join("\n"))}</div></div>
        </section>
      `;
    })
    .join("");
  return `<div class="bench-report-grid">${body}</div>`;
}

// --------------------------------------------------------------------------
// Инициализация
// --------------------------------------------------------------------------
function init() {
  $("temperature").addEventListener("input", () => {
    $("tempVal").textContent = parseFloat($("temperature").value).toFixed(1);
  });
  $("maxTokens").addEventListener("input", () => {
    $("tokensVal").textContent = $("maxTokens").value;
  });
  $("taskSelect").addEventListener("change", handleTaskChange);
  $("solveBtn").addEventListener("click", solveAll);
  // Вкладки.
  $("tabDay3").addEventListener("click", () => switchDay(3));
  $("tabDay4").addEventListener("click", () => switchDay(4));
  $("tabDay5").addEventListener("click", () => switchDay(5));
  // День 4.
  $("tempRunBtn").addEventListener("click", runTemperatureExperiment);
  // День 5.
  $("benchRunBtn").addEventListener("click", runBenchExperiment);
  bindHints();
  clearResults();
  renderTempEmpty("Нажмите «Выполнить» — 4 задачи поедут к модели при t = 0, 0.7 и 1.2.");
  renderBenchEmpty("Нажмите «Запустить бенчмарк» — три задачи нарастающей сложности пройдут через слабую, среднюю и сильную модели gpustack.");
  loadTasks();
  loadModels();
}

document.addEventListener("DOMContentLoaded", init);
