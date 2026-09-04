"""FastAPI-приложение «AI Advent — День 3, День 4 и День 5».

Эндпоинты:
  GET  /                      → static/index.html
  GET  /api/tasks             → встроенные задачи
  GET  /api/models            → список моделей для селекта
  GET  /api/progress          → прогресс решения (для индикации)
  POST /api/solve             → решить задачу четырьмя способами (День 3)
  POST /api/judge             → оценить решения судьёй (LLM-as-a-judge)
  GET  /api/temperature-progress → прогресс матрицы 4×3 вызовов (День 4)
  POST /api/temp-matrix          → 4 типа задач при t=0/0.7/1.2 параллельно
                                   + LLM-вывод по эксперименту (День 4)
  GET  /api/models-progress   → прогресс бенчмарка моделей по этапам
                                + частичные результаты (День 5)
  POST /api/models-bench      → поэтапный бенчмарк: 3 задачи возрастающей
                                сложности на слабой/средней/сильной модели
                                + итоговое сравнение аналитиком (День 5)
"""
from __future__ import annotations

import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import llm
import tasks as T
from config import settings

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="AI Advent — День 3 и День 4")

# Четыре метода (используются судьёй; решаются параллельно, а отображаются
# в этом порядке).
ALL_METHODS = ["direct", "step_by_step", "self_prompt", "experts"]

# Модели, доступные в селекте фронтенда (белый список для solve/judge).
# qwen3.8-27b нестабильна на длинных задачах Дня 3, поэтому в селекте её нет;
# в бенчмарке Дня 5 она участвует как «слабая» — краткий запрос ей по силам.
AVAILABLE_MODELS = ["glm-5.3-flash", "deepseek-v4-flash"]

# День 5: три уровня силы из gpustack. Слабая — qwen3.8-27b (27B),
# средняя — deepseek-v4-flash, сильная — glm-5.3-flash (дефолт шлюза).
MODEL_BENCH_TIERS: list[dict] = [
    {"tier": "weak", "label": "Слабая", "model": "qwen3.8-27b"},
    {"tier": "medium", "label": "Средняя", "model": "deepseek-v4-flash"},
    {"tier": "strong", "label": "Сильная", "model": "glm-5.3-flash"},
]

# Референсная стоимость моделей (USD за 1 млн токенов, вход/вывод).
# Цены — официальные API-прайсы поставщиков, сентябрь 2026:
#   deepseek-v4-flash: https://api-docs.deepseek.com/quick_start/pricing
#     (вход $0.14, вывод $0.28, кэш-хит $0.028);
#   glm-5.3-flash: https://docs.z.ai/guides/overview/pricing
#     (прайс $0.15/$0.50; до 09.09.2026 действует промо 50% → $0.075/$0.25);
#   qwen3.8-27b: публичного прайса нет (веса открыты), берём ближайший
#     официальный тир qwen3-30b-a3b —
#     https://www.alibabacloud.com/help/en/model-studio/qwen3-30b-a3b
#     ($0.108 вход / $0.431 вывод, регион Китай).
MODEL_PRICING: dict[str, dict[str, float]] = {
    "qwen3.8-27b": {"input": 0.108, "output": 0.431},
    "deepseek-v4-flash": {"input": 0.14, "output": 0.28},
    "glm-5.3-flash": {"input": 0.15, "output": 0.5},
}

# Температуры эксперимента Дня 4: матрица «тип задачи × температура».
TEMPERATURES = [0.0, 0.7, 1.2]

# Прогресс последнего запуска /api/solve (для индикации на фронтенде).
# Способы решаются параллельно, поэтому статусы: running — решается сейчас
# (может быть несколько), done — готово.
SOLVE_PROGRESS: dict = {"running": [], "done": [], "total": 4}
# Прогресс последнего запуска /api/temp-matrix (День 4): 4 типа задач ×
# 3 температуры = 12 параллельных вызовов, статусы те же, что у способов
# в /api/solve. Идентификатор ячейки — «<тип>:<температура>», например
# "technical:0.7".
TEMP_PROGRESS: dict = {
    "running": [],
    "done": [],
    "total": len(T.TEMP_TASKS) * len(TEMPERATURES),
}
# Прогресс последнего запуска /api/models-bench (День 5): поэтапный
# бенчмарк — этапы по очереди, внутри этапа три модели параллельно.
# Идентификатор ячейки — «<этап>:<уровень>» ("simple:weak", ...);
# "results" накапливает завершённые этапы, чтобы фронтенд по
# /api/models-progress рисовал картину пошагово, до финального ответа.
BENCH_PROGRESS: dict = {
    "running": [],
    "done": [],
    "total": len(T.BENCH_STAGES) * len(MODEL_BENCH_TIERS),
    "results": {},
}
# Защита от потерянных обновлений при одновременном завершении способов.
PROGRESS_LOCK = threading.Lock()
# Критерии качества, по которым судья оценивает каждое решение (0-10).
CRITERIA_KEYS = ["correctness", "completeness", "reasoning", "efficiency", "speed"]

# Судья всегда работает с минимальной температурой — вердикт должен быть
# максимально детерминированным независимо от температуры способов.
JUDGE_TEMPERATURE = 0.0


# --------------------------------------------------------------------------
# Модели запросов/ответов
# --------------------------------------------------------------------------
class SolveReq(BaseModel):
    task_id: str | None = None
    text: str | None = None
    model: str | None = None
    temperature: float = Field(default=0.5, ge=0.0, le=1.0)
    max_tokens: int = Field(default=2000, ge=1, le=10000)


class JudgeReq(BaseModel):
    task_id: str | None = None
    text: str | None = None
    model: str | None = None
    temperature: float = Field(default=0.5, ge=0.0, le=1.0)
    max_tokens: int = Field(default=2000, ge=1, le=10000)
    solutions: list[dict]


class TempMatrixReq(BaseModel):
    queries: dict[str, str] = {}  # {"technical": "...", ...} — пустые значения заменяются дефолтными из T.TEMP_TASKS
    model: str | None = None


class BenchReq(BaseModel):
    queries: dict[str, str] = {}  # {"simple": "...", ...} — пустые значения заменяются дефолтными из T.BENCH_STAGES


# --------------------------------------------------------------------------
# Вспомогательные функции
# --------------------------------------------------------------------------
def run_chat(messages, temperature, max_tokens=None, model=None, **opts):
    """Обёртка над llm.chat с человеческой обработкой ошибок сети/LLM.

    Дополнительные opts (timeout, thinking) пробрасываются в llm.chat.
    """
    try:
        return llm.chat(messages, temperature=temperature, max_tokens=max_tokens, model=model, **opts)
    except Exception as exc:  # noqa: BLE001 — перехватываем сеть/API
        raise HTTPException(
            status_code=502,
            detail=f"Ошибка при обращении к LLM: {exc}",
        ) from exc


def format_messages(messages) -> str:
    """Человекочитаемое представление отправленных сообщений (для UI).

    Показывает роли и содержимое ровно того запроса, который ушёл к модели.
    """
    parts = []
    for msg in messages:
        role = msg.get("role", "?")
        content = msg.get("content", "")
        parts.append(f"[{role}]\n{content}")
    return "\n\n".join(parts)


def validated_model(model: str | None) -> str | None:
    """Проверка модели из запроса по белому списку.

    None/пустая строка → None (llm.py возьмёт модель из настроек).
    Неизвестная модель → 400.
    """
    if model is None or not model.strip():
        return None
    if model not in AVAILABLE_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"Неизвестная модель: {model}. Доступны: {', '.join(AVAILABLE_MODELS)}.",
        )
    return model


# --------------------------------------------------------------------------
# Четыре способа рассуждения
# --------------------------------------------------------------------------
def _spent(result: dict) -> int:
    """Сколько completion-токенов израсходовал вызов (0 при отсутствии данных)."""
    return result.get("completion_tokens") or 0


def _exhausted_result() -> dict:
    """Псевдо-результат для вызова, который не выполнялся: бюджет исчерпан."""
    return {
        "content": "(лимит токенов исчерпан — вызов пропущен)",
        "finish_reason": "length",
        "completion_tokens": 0,
        "elapsed_ms": 0,
    }


def solve_direct(task_text: str, temperature: float, max_tokens=None, model=None) -> dict:
    messages = [{"role": "user", "content": task_text}]
    result = run_chat(messages, temperature, max_tokens, model)
    return {
        "method": "direct",
        "content": result["content"],
        "prompt": format_messages(messages),
        "finish_reason": result["finish_reason"],
        "completion_tokens": result["completion_tokens"],
        "elapsed_ms": result["elapsed_ms"],
    }


def solve_step_by_step(task_text: str, temperature: float, max_tokens=None, model=None) -> dict:
    messages = [
        {"role": "system", "content": T.SYS_STEP_BY_STEP},
        {"role": "user", "content": task_text},
    ]
    result = run_chat(messages, temperature, max_tokens, model)
    return {
        "method": "step_by_step",
        "content": result["content"],
        "prompt": format_messages(messages),
        "finish_reason": result["finish_reason"],
        "completion_tokens": result["completion_tokens"],
        "elapsed_ms": result["elapsed_ms"],
    }


def solve_self_prompt(task_text: str, temperature: float, max_tokens=None, model=None) -> dict:
    # (а) модель составляет «идеальный промпт» — тратит часть общего бюджета.
    gen_messages = [
        {"role": "system", "content": T.SYS_SELF_PROMPT},
        {"role": "user", "content": task_text},
    ]
    gen = run_chat(gen_messages, temperature, max_tokens, model)
    generated_prompt = gen["content"]
    spent = _spent(gen)
    remaining = max_tokens - spent if max_tokens is not None else None

    # (б) используем промпт как user во втором вызове — на него остаётся
    # остаток бюджета (лимит минус токены первого вызова).
    solve_messages = [{"role": "user", "content": generated_prompt}]
    if remaining is not None and remaining < 1:
        result = _exhausted_result()
    else:
        result = run_chat(solve_messages, temperature, remaining, model)
    spent += _spent(result)
    payload = {
        "method": "self_prompt",
        "content": result["content"],
        "prompt": format_messages(gen_messages),
        "finish_reason": result["finish_reason"],
        "completion_tokens": spent,
        "elapsed_ms": result["elapsed_ms"],
        "generated_prompt": generated_prompt,
    }
    return payload


def solve_experts(task_text: str, temperature: float, max_tokens=None, model=None) -> dict:
    role_answers: list[str] = []
    role_prompts: list[str] = []
    total_tokens = 0
    total_ms = 0
    finish_reason = "stop"
    remaining = max_tokens  # общий бюджет на все вызовы консилиума
    for role in T.EXPERT_ROLES:
        messages = [
            {"role": "system", "content": role["system"]},
            {"role": "user", "content": task_text},
        ]
        if remaining is not None and remaining < 1:
            res = _exhausted_result()
        else:
            res = run_chat(messages, temperature, remaining, model)
        role_answers.append(f"### {role['role']}\n{res['content']}")
        role_prompts.append(f"### {role['role']}\n{format_messages(messages)}")
        total_tokens += res["completion_tokens"]
        total_ms += res["elapsed_ms"]
        if res["finish_reason"] != "stop":
            finish_reason = res["finish_reason"]
        if remaining is not None:
            remaining -= _spent(res)
    return {
        "method": "experts",
        "content": "\n\n".join(role_answers),
        "prompt": "\n\n".join(role_prompts),
        "finish_reason": finish_reason,
        "completion_tokens": total_tokens,
        "elapsed_ms": total_ms,
    }


SOLVERS = {
    "direct": solve_direct,
    "step_by_step": solve_step_by_step,
    "self_prompt": solve_self_prompt,
    "experts": solve_experts,
}


# --------------------------------------------------------------------------
# Судья (LLM-as-a-judge)
# --------------------------------------------------------------------------
def strip_json_fence(text: str) -> str:
    """Убирает ```json ... ``` обрамление из ответа судьи."""
    cleaned = re.sub(r"```(?:json)?", "", text).strip()
    # Отрезаем всё, что до первой '{' и после последней '}'.
    first = cleaned.find("{")
    last = cleaned.rfind("}")
    if first != -1 and last != -1 and last >= first:
        cleaned = cleaned[first : last + 1]
    return cleaned


def parse_judge(text: str) -> dict | None:
    """Пытается распарсить ответ судьи как JSON."""
    try:
        data = json.loads(strip_json_fence(text))
        if isinstance(data, dict) and "winner" in data and "scores" in data:
            return data
    except (json.JSONDecodeError, TypeError):
        return None
    return None


def run_judge(task_text: str, solutions: list[dict], model=None) -> dict:
    """Вызов судьи. Всегда температура 0 и без лимита токенов: вердикт
    должен быть детерминированным и никогда не обрезаться, поэтому
    temperature/max_tokens из запроса к /api/judge игнорируются."""
    # Готовим текст решений для судьи. Число израсходованных токенов
    # и время выполнения передаются судье: он учитывает их в критериях
    # efficiency и speed.
    blocks = []
    for sol in solutions:
        method = sol.get("method", "?")
        content = sol.get("content", "")
        tokens = sol.get("completion_tokens")
        tokens_str = (
            f"израсходовано токенов: {int(tokens)}"
            if isinstance(tokens, (int, float))
            else "израсходовано токенов: неизвестно"
        )
        ms = sol.get("elapsed_ms")
        time_str = (
            f"время выполнения: {ms / 1000:.1f} с"
            if isinstance(ms, (int, float))
            else "время выполнения: неизвестно"
        )
        blocks.append(f"--- Способ: {method} ({tokens_str}, {time_str}) ---\n{content}")
    solutions_text = "\n\n".join(blocks)

    messages = [
        {"role": "system", "content": T.JUDGE_SYSTEM},
        {
            "role": "user",
            "content": (
                f"Задача:\n{task_text}\n\nРешения:\n{solutions_text}\n\n"
                "Оцени решения и верни JSON с победителем, оценками и обоснованием."
            ),
        },
    ]

    # max_tokens=None → ограничение не отправляется в API вовсе.
    first = run_chat(messages, JUDGE_TEMPERATURE, model=model)
    parsed = parse_judge(first["content"])

    retry_count = 0
    retry_messages = None
    if parsed is None:
        # Один ретрай с напоминанием про формат.
        retry_messages = [
            {"role": "system", "content": T.JUDGE_RETRY_SYSTEM},
            {"role": "user", "content": messages[-1]["content"]},
        ]
        retry = run_chat(retry_messages, JUDGE_TEMPERATURE, model=model)
        parsed = parse_judge(retry["content"])
        retry_count = 1

    if parsed is None:
        raise HTTPException(
            status_code=502,
            detail="Судья не вернул валидный JSON даже после повторного запроса.",
        )

    scores = parsed.get("scores", {}) or {}
    # Ранжирование: судья возвращает "ranking" — список методов от лучшего
    # к худшему. Если поля нет или оно неполное, дополняем недостающие
    # методы по убыванию их оценок.
    raw_ranking = parsed.get("ranking")
    ranking = (
        [m for m in raw_ranking if m in ALL_METHODS]
        if isinstance(raw_ranking, list)
        else []
    )
    missing = [m for m in ALL_METHODS if m not in ranking]
    missing.sort(
        key=lambda m: scores.get(m) if isinstance(scores.get(m), (int, float)) else -1,
        reverse=True,
    )
    ranking.extend(missing)

    # Критерии качества (0-10) для диаграмм на фронтенде. Если судья не
    # вернул разбивку, fallback: каждый критерий = итоговой оценке метода.
    def clamp10(v) -> int:
        return max(0, min(10, round(v))) if isinstance(v, (int, float)) else 0

    raw_criteria = parsed.get("criteria")
    criteria: dict[str, dict[str, int]] = {}
    for m in ALL_METHODS:
        raw = raw_criteria.get(m) if isinstance(raw_criteria, dict) and isinstance(raw_criteria.get(m), dict) else {}
        fallback = scores.get(m) if isinstance(scores.get(m), (int, float)) else 0
        criteria[m] = {key: clamp10(raw.get(key, fallback)) for key in CRITERIA_KEYS}

    # Флаг «задача решена» по каждому способу — определяет судья. Если судья
    # не вернул solved (или вернул не boolean), fallback: решена только
    # у метода с первого места.
    raw_solved = parsed.get("solved")
    solved: dict[str, bool] = {}
    winner = parsed.get("winner")
    for m in ALL_METHODS:
        v = raw_solved.get(m) if isinstance(raw_solved, dict) else None
        solved[m] = bool(v) if isinstance(v, bool) else (m == winner)

    result = {
        "winner": parsed.get("winner"),
        "scores": scores,
        "ranking": ranking,
        "criteria": criteria,
        "solved": solved,
        "rationale": parsed.get("rationale", ""),
        "retries": retry_count,
        # Промпт, отправленный судье (первый вызов).
        "prompt": format_messages(messages),
    }
    if retry_messages is not None:
        result["retry_prompt"] = format_messages(retry_messages)
    return result


# --------------------------------------------------------------------------
# День 4: эксперимент с температурой
# --------------------------------------------------------------------------
def run_temp_matrix_analyze(
    queries: dict[str, str], results: dict[str, dict], model=None
) -> tuple[str, str]:
    """Сравнение матрицы 4×3 (тип задачи × температура) силами LLM.

    Анализ всегда temperature 0 и без лимита токенов: выводы должны быть
    детерминированными и не обрезаться. Возвращает кортеж (текст анализа,
    промпт отправленного запроса — для UI).
    """
    blocks = []
    for key, task in T.TEMP_TASKS.items():
        lines = [f"--- {task['label']} задача ---", f"Задание: {queries[key]}"]
        for t in TEMPERATURES:
            ans = results.get(key, {}).get(t, {})
            content = (ans.get("content") or "").strip() or "(пустой ответ)"
            lines.append(f"[temperature = {t}]\n{content}")
        blocks.append("\n".join(lines))
    matrix_text = "\n\n".join(blocks)

    messages = [
        {"role": "system", "content": T.TEMPERATURE_ANALYZE_SYSTEM},
        {
            "role": "user",
            "content": (
                f"Матрица результатов (4 типа задач × температуры 0/0.7/1.2):\n\n"
                f"{matrix_text}\n\n"
                "Сравни ответы и сформулируй вывод: для каких типов задач "
                "какая температура подходит."
            ),
        },
    ]
    result = run_chat(messages, JUDGE_TEMPERATURE, None, model=model)
    return result["content"], format_messages(messages)


# --------------------------------------------------------------------------
# Эндпоинты
# --------------------------------------------------------------------------
@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/tasks")
def api_tasks():
    public = [
        {
            "id": t["id"],
            "title": t["title"],
            "kind": t["kind"],
            "description": t["description"],
        }
        for t in T.BUILTIN_TASKS
    ]
    return {"tasks": public}


@app.get("/api/models")
def api_models():
    """Список доступных моделей и модель по умолчанию (для селекта)."""
    return {"models": AVAILABLE_MODELS, "default": settings.openai_model}


@app.get("/api/progress")
def api_progress():
    # Статусы способов в текущем запуске (опрос фронтендом): done — готово,
    # running — решается сейчас (при параллельном запуске их несколько).
    return {
        "done": SOLVE_PROGRESS["done"],
        "running": SOLVE_PROGRESS["running"],
        "total": SOLVE_PROGRESS["total"],
    }


@app.get("/api/temperature-progress")
def api_temperature_progress():
    # Статусы трёх температурных вызовов текущего запуска Дня 4 (опрос
    # фронтендом): done — ответ получен, running — выполняется сейчас.
    return {
        "done": TEMP_PROGRESS["done"],
        "running": TEMP_PROGRESS["running"],
        "total": TEMP_PROGRESS["total"],
    }


@app.post("/api/solve")
def api_solve(req: SolveReq):
    # Определяем текст задачи.
    if req.task_id:
        task = T.TASKS_BY_ID.get(req.task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Задача не найдена.")
        title = task["title"]
        task_text = task["description"]
    elif req.text and req.text.strip():
        title = "Своя задача"
        task_text = req.text.strip()
    else:
        raise HTTPException(status_code=400, detail="Передайте task_id или text.")

    model = validated_model(req.model)

    SOLVE_PROGRESS["done"] = []
    SOLVE_PROGRESS["running"] = []
    SOLVE_PROGRESS["total"] = len(ALL_METHODS)

    def _run_method(method: str) -> dict:
        """Один способ в отдельном потоке: wall-время + отметки прогресса."""
        with PROGRESS_LOCK:
            SOLVE_PROGRESS["running"] = list(SOLVE_PROGRESS["running"]) + [method]
        # Чистое wall-время способа (все внутренние вызовы LLM): судья
        # учитывает его в критерии speed. Перезаписывает per-call
        # elapsed_ms из llm.py — у self_prompt/experts он неполный.
        t0 = time.perf_counter()
        sol = SOLVERS[method](task_text, req.temperature, req.max_tokens, model)
        sol["elapsed_ms"] = int((time.perf_counter() - t0) * 1000)
        with PROGRESS_LOCK:
            SOLVE_PROGRESS["done"] = list(SOLVE_PROGRESS["done"]) + [method]
        return sol

    # Параллельный запуск всех способов: общее время = самый медленный
    # способ, а не сумма. OpenAI-клиент потокобезопасен.
    with ThreadPoolExecutor(max_workers=len(ALL_METHODS)) as pool:
        futures = [pool.submit(_run_method, method) for method in ALL_METHODS]
        # Собираем в порядке ALL_METHODS — порядок карточек сохраняется.
        solutions = [f.result() for f in futures]

    return {
        "task": {"id": req.task_id or "custom", "title": title},
        "solutions": solutions,
    }


@app.post("/api/judge")
def api_judge(req: JudgeReq):
    if req.task_id:
        task = T.TASKS_BY_ID.get(req.task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Задача не найдена.")
        task_text = task["description"]
    elif req.text and req.text.strip():
        task_text = req.text.strip()
    else:
        raise HTTPException(status_code=400, detail="Передайте task_id или text.")

    if not req.solutions:
        raise HTTPException(status_code=400, detail="Нет решений для оценки.")

    verdict = run_judge(task_text, req.solutions, validated_model(req.model))
    return verdict


# Ограничения ячейки матрицы: потолок на время генерации. Reasoning-фаза
# GLM идёт отдельным (невидимым) каналом и ест токены и время — без лимита
# на t=1.2 она разгоняется и упирается в таймаут клиента (90 с). Выключить
# её нельзя: chat_template_kwargs enable_thinking=False на этом шлюзе не
# работает и к тому же заставляет шаблон печатать рассуждения прямо в
# контент. Вместо этого reasoning сдерживается системным промптом
# T.TEMP_CELL_SYSTEM, а 6000 токенов (~60 с генерации в худшем случае)
# страхуют от убегающей генерации.
TEMP_CELL_MAX_TOKENS = 6000
TEMP_CELL_TIMEOUT = 180.0


@app.post("/api/temp-matrix")
def api_temp_matrix(req: TempMatrixReq):
    """День 4: матрица «4 типа задач × temperature 0 / 0.7 / 1.2».

    12 вызовов выполняются параллельно (ThreadPoolExecutor, как способы
    в /api/solve): общее время = самый медленный вызов. Ячейки идут с
    системным промптом T.TEMP_CELL_SYSTEM, лимитом TEMP_CELL_MAX_TOKENS
    токенов и таймаутом TEMP_CELL_TIMEOUT с — чтобы матрица собиралась
    за десятки секунд. Когда все ответы собраны, аналитик (temperature 0)
    формулирует вывод: для каких типов задач какая температура подходит.
    """
    queries: dict[str, str] = {}
    for key, task in T.TEMP_TASKS.items():
        custom = (req.queries.get(key) or "").strip()
        queries[key] = custom or task["text"]
    model = validated_model(req.model)

    with PROGRESS_LOCK:
        TEMP_PROGRESS["done"] = []
        TEMP_PROGRESS["running"] = []
        TEMP_PROGRESS["total"] = len(T.TEMP_TASKS) * len(TEMPERATURES)

    def _run_cell(key: str, t: float) -> dict:
        """Одна ячейка матрицы (задача + температура) в отдельном потоке."""
        cell = f"{key}:{t}"
        with PROGRESS_LOCK:
            TEMP_PROGRESS["running"] = list(TEMP_PROGRESS["running"]) + [cell]
        messages = [
            {"role": "system", "content": T.TEMP_CELL_SYSTEM},
            {"role": "user", "content": queries[key]},
        ]
        res = run_chat(messages, t, TEMP_CELL_MAX_TOKENS, model, timeout=TEMP_CELL_TIMEOUT)
        with PROGRESS_LOCK:
            TEMP_PROGRESS["running"] = [x for x in TEMP_PROGRESS["running"] if x != cell]
            TEMP_PROGRESS["done"] = list(TEMP_PROGRESS["done"]) + [cell]
        return {
            "temperature": t,
            "content": res["content"],
            "finish_reason": res["finish_reason"],
            "completion_tokens": res["completion_tokens"],
            "elapsed_ms": res["elapsed_ms"],
        }

    cells = [(key, t) for key in T.TEMP_TASKS for t in TEMPERATURES]
    with ThreadPoolExecutor(max_workers=len(cells)) as pool:
        futures = [pool.submit(_run_cell, key, t) for key, t in cells]
        # Собираем в порядке клеток — сгруппированный вид для фронтенда.
        results: dict[str, dict] = {}
        for (key, t), future in zip(cells, futures):
            results.setdefault(key, {})[t] = future.result()

    analysis, prompt = run_temp_matrix_analyze(queries, results, model)
    return {"results": results, "analysis": analysis, "prompt": prompt}


# --------------------------------------------------------------------------
# День 5: версии моделей
# --------------------------------------------------------------------------
def run_bench_analyze(queries: dict[str, str], results: dict, analyst_model: str | None = None):
    """Итоговое сравнение трёх моделей аналитиком (t=0, сильная модель).

    Возвращает (analysis, prompt) — как run_temp_matrix_analyze.
    """
    blocks = []
    # Сводные замеры: суммарные время, токены и стоимость вывода по каждой модели.
    totals: dict[str, dict] = {t["tier"]: {"ms": 0, "tokens": 0, "cost": 0.0} for t in MODEL_BENCH_TIERS}
    for stage in T.BENCH_STAGES:
        key = stage["key"]
        stage_results = results[key]
        lines = [f"Этап: {stage['label']} задача. Запрос: {queries[key]}"]
        for tier in MODEL_BENCH_TIERS:
            r = stage_results[tier["tier"]]
            totals[tier["tier"]]["ms"] += r["elapsed_ms"]
            totals[tier["tier"]]["tokens"] += r["completion_tokens"]
            out_price = MODEL_PRICING.get(tier["model"], {}).get("output")
            if out_price:
                totals[tier["tier"]]["cost"] += r["completion_tokens"] / 1e6 * out_price
            lines.append(
                f"--- {tier['label']} модель: {r['model']} ---\n"
                f"[время: {r['elapsed_ms'] / 1000:.1f} с, "
                f"токенов: {r['completion_tokens']}, finish: {r['finish_reason']}]\n"
                f"{r['content']}"
            )
        blocks.append("\n".join(lines))
    summary = "; ".join(
        f"{t['label']} ({t['model']}): суммарно {totals[t['tier']]['ms'] / 1000:.1f} с, "
        f"{totals[t['tier']]['tokens']} токенов, в среднем "
        f"{totals[t['tier']]['ms'] / 1000 / len(T.BENCH_STAGES):.1f} с на этап, "
        f"стоимость вывода ≈${totals[t['tier']]['cost']:.4f}"
        for t in MODEL_BENCH_TIERS
    )
    price_lines = "; ".join(
        f"{t['model']} — ${MODEL_PRICING[t['model']]['input']}/${MODEL_PRICING[t['model']]['output']}"
        for t in MODEL_BENCH_TIERS if t["model"] in MODEL_PRICING
    )
    messages = [
        {"role": "system", "content": T.MODEL_BENCH_ANALYZE_SYSTEM},
        {
            "role": "user",
            "content": "Поэтапный бенчмарк: три модели отвечали на одни и те же "
                       "задачи возрастающей сложности.\n\n"
                       "Сводные замеры по всем этапам: " + summary + "\n\n"
                       "Референсные цены API (USD за 1 млн токенов, вход/вывод): "
                       + price_lines +
                       ". Стоимость в сводке = токены вывода × цена вывода.\n\n"
                       "Ответы моделей с замерами по этапам:\n" + "\n\n".join(blocks),
        },
    ]
    # t=0 и без лимита токенов — как у остальных аналитиков.
    analysis = run_chat(messages, JUDGE_TEMPERATURE, None, analyst_model)
    return analysis["content"], format_messages(messages)


@app.get("/api/models-progress")
def api_models_progress():
    """Прогресс бенчмарка Дня 5: статусы ячеек «этап:уровень» + частичные результаты."""
    with PROGRESS_LOCK:
        return {
            "done": list(BENCH_PROGRESS["done"]),
            "running": list(BENCH_PROGRESS["running"]),
            "total": BENCH_PROGRESS["total"],
            # Завершённые этапы с ответами: фронтенд рисует картину пошагово.
            "results": {k: dict(v) for k, v in BENCH_PROGRESS["results"].items()},
        }


@app.post("/api/models-bench")
def api_models_bench(req: BenchReq):
    """День 5: поэтапный бенчмарк трёх моделей.

    Этапы возрастающей сложности выполняются по очереди, внутри этапа три
    модели (слабая/средняя/сильная) отвечают параллельно
    (ThreadPoolExecutor): время этапа = самый медленный вызов. Системный
    промпт и температура одинаковы для всех — сравнение уровней честное.
    Замеры по каждой ячейке: время, токены, finish_reason; стоимость — из
    MODEL_PRICING (внутренний шлюз бесплатен). Когда все этапы собраны,
    аналитик (t=0, сильная модель) строит итоговую сравнительную картину:
    качество по этапам, скорость, ресурсоёмкость.
    """
    queries = {}
    for stage in T.BENCH_STAGES:
        queries[stage["key"]] = (req.queries or {}).get(stage["key"], "").strip() or stage["query"]

    with PROGRESS_LOCK:
        BENCH_PROGRESS["done"] = []
        BENCH_PROGRESS["running"] = []
        BENCH_PROGRESS["total"] = len(T.BENCH_STAGES) * len(MODEL_BENCH_TIERS)
        BENCH_PROGRESS["results"] = {}

    def _run_cell(stage_key: str, query: str, tier: dict) -> dict:
        """Одна ячейка «этап × модель» в отдельном потоке."""
        key = f"{stage_key}:{tier['tier']}"
        with PROGRESS_LOCK:
            BENCH_PROGRESS["running"] = list(BENCH_PROGRESS["running"]) + [key]
        messages = [
            {"role": "system", "content": T.BENCH_SYSTEM},
            {"role": "user", "content": query},
        ]
        res = run_chat(messages, JUDGE_TEMPERATURE, TEMP_CELL_MAX_TOKENS,
                       tier["model"], timeout=TEMP_CELL_TIMEOUT)
        with PROGRESS_LOCK:
            BENCH_PROGRESS["running"] = [x for x in BENCH_PROGRESS["running"] if x != key]
            BENCH_PROGRESS["done"] = list(BENCH_PROGRESS["done"]) + [key]
        return {
            "model": tier["model"],
            "label": tier["label"],
            "content": res["content"],
            "finish_reason": res["finish_reason"],
            "completion_tokens": res["completion_tokens"],
            "elapsed_ms": res["elapsed_ms"],
            "price_per_million": MODEL_PRICING.get(tier["model"]),
        }

    results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=len(MODEL_BENCH_TIERS)) as pool:
        for stage in T.BENCH_STAGES:
            stage_key = stage["key"]
            futures = {
                t["tier"]: pool.submit(_run_cell, stage_key, queries[stage_key], t)
                for t in MODEL_BENCH_TIERS
            }
            stage_results = {t["tier"]: futures[t["tier"]].result() for t in MODEL_BENCH_TIERS}
            results[stage_key] = stage_results
            # Этап завершён — отдаём его в прогрессе, чтобы фронтенд
            # показывал картину пошагово, не дожидаясь конца бенчмарка.
            with PROGRESS_LOCK:
                BENCH_PROGRESS["results"][stage_key] = stage_results

    analysis, prompt = run_bench_analyze(queries, results)
    return {"results": results, "analysis": analysis, "prompt": prompt, "queries": queries}


# Монтируем статику: всё, что не попавшее в роуты, из static/.
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
