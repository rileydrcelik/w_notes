"""Application settings, loaded from the environment (12-factor)."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # asyncpg connection URL. docker-compose injects this for the container.
    database_url: str = "postgresql+asyncpg://wnotes:wnotes@localhost:5432/wnotes"

    # Empty string => Sentry stays disabled (a no-op), so the app runs without it.
    sentry_dsn: str = ""

    # Free-form environment tag attached to Sentry events.
    env: str = "development"

    # Firebase service-account credential used to verify ID tokens: either a path
    # to the JSON file (local dev) or the JSON content itself (deployed — injected
    # from a secrets manager). Empty => Firebase auth is disabled and only
    # anonymous device keys are accepted.
    firebase_credentials: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
