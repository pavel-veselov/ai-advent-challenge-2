"""Конфигурация приложения через pydantic-settings.

Читает .env (python-dotenv под капотом). Обязательный ключ — OPENAI_API_KEY.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openai_api_key: str = ""
    openai_model: str = "deepseek-v4-flash"
    openai_base_url: str | None = None

    # Общие параметры вызовов LLM
    temperature_default: float = 0.5
    max_tokens_default: int = 2000
    # Reasoning-режим GLM: внутренние размышления тратят completion-токены
    # и могут съесть весь max_tokens до выдачи ответа. True — включён.
    enable_thinking: bool = True


settings = Settings()


def require_api_key() -> None:
    """Поднимает человеческую ошибку, если ключ не настроен."""
    if not settings.openai_api_key:
        raise RuntimeError(
            "OPENAI_API_KEY не задан. Скопируйте .env.example в .env "
            "и впишите реальный ключ доступа к LLM."
        )
