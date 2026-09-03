/* День 3 — Разные способы рассуждения. Чистый JS, без фреймворков. */

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
    models = ["glm-5.3-flash", "qwen3.8-27b", "deepseek-v4-flash"];
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
  bindHints();
  clearResults();
  loadTasks();
  loadModels();
}

document.addEventListener("DOMContentLoaded", init);
