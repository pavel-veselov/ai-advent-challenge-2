"""Singleton-клиент для вызовов LLM через библиотеку openai.

Все вызовы идут через один OpenAI-совместимый клиент
(client.chat.completions.create).
"""
from functools import lru_cache
import time
from typing import Any

from openai import OpenAI

from config import settings


@lru_cache(maxsize=1)
def get_client() -> OpenAI:
    """Ленивый синглтон OpenAI-клиента.

    Таймаут 90 с и 1 ретрай: без них зависший запрос к бэкенду LLM
    подвешивает вызов на минуты (дефолт openai-клиента — 600 с).
    """
    kwargs: dict[str, Any] = {
        "api_key": settings.openai_api_key,
        "timeout": 90.0,
        "max_retries": 1,
    }
    if settings.openai_base_url:
        kwargs["base_url"] = settings.openai_base_url
    return OpenAI(**kwargs)


def chat(
    messages: list[dict[str, str]],
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
    model: str | None = None,
    timeout: float | None = None,
    thinking: bool | None = None,
) -> dict[str, Any]:
    """Один вызов chat.completions.create.

    temperature=None → settings.temperature_default.
    model=None → settings.openai_model; конкретное имя — переопределение модели.
    max_tokens=None → ограничение НЕ отправляется в API (без лимита);
    конкретное число — жёсткий лимит токенов ответа.
    timeout=None → таймаут клиента (90 с); число — потолок на этот вызов.
    thinking=None → как в settings.enable_thinking; False — выключить
    reasoning-фазу GLM на уровне chat-шаблона (для коротких ответов).

    Возвращает dict:
      {
        "content": str,            # текст ответа (может быть пустым)
        "finish_reason": str,      # "stop" / "length" / ...
        "completion_tokens": int,  # сколько токенов сгенерировано
        "elapsed_ms": int,         # время вызова в мс
      }
    """
    client = get_client()
    temp = settings.temperature_default if temperature is None else temperature

    kwargs: dict[str, Any] = {
        "model": model or settings.openai_model,
        "messages": messages,
        "temperature": temp,
    }
    if max_tokens is not None:
        # max_tokens=None — ограничение не задаётся вовсе (используется
        # лимит модели/провайдера). Конкретное число — жёсткий лимит.
        kwargs["max_tokens"] = max_tokens
    if timeout is not None:
        # Пер-запросный таймаут (открытая библиотека поддерживает его
        # в create() поверх дефолта клиента).
        kwargs["timeout"] = timeout
    enable_thinking = settings.enable_thinking if thinking is None else thinking
    if not enable_thinking:
        # Отключаем reasoning-фазу GLM на уровне chat-шаблона (vLLM/SGLang):
        # иначе мышление ест max_tokens, и content приходит пустым
        # (finish_reason="length" при исчерпанных completion_tokens).
        kwargs["extra_body"] = {"chat_template_kwargs": {"enable_thinking": False}}

    start = time.perf_counter()
    resp = client.chat.completions.create(**kwargs)
    elapsed_ms = int((time.perf_counter() - start) * 1000)

    choice = resp.choices[0]
    return {
        "content": (choice.message.content or "").strip(),
        "finish_reason": choice.finish_reason or "stop",
        "completion_tokens": resp.usage.completion_tokens if resp.usage else 0,
        "elapsed_ms": elapsed_ms,
    }
