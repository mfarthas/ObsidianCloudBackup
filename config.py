import os
import yaml
import logging
from pathlib import Path
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class S3Config(BaseModel):
    bucket_name: str
    region: str = "eu-west-1"
    endpoint_url: str | None = None


class BackupConfig(BaseModel):
    ignore_patterns: list[str] = Field(default_factory=list)


class RetentionConfig(BaseModel):
    keep_last: int = 10


class AppConfig(BaseModel):
    vault_path: Path
    s3: S3Config
    backup: BackupConfig = Field(default_factory=BackupConfig)
    retention: RetentionConfig = Field(default_factory=RetentionConfig)
    encryption_key: bytes = Field(exclude=True)
    
    db_path: Path = Path("backup.db")

    model_config = {"arbitrary_types_allowed": True}


def load_config(config_path: str) -> AppConfig:
    path = Path(config_path)
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(path) as f:
        raw = yaml.safe_load(f)

    vault = os.environ.get("VAULT_PATH")
    bucket = os.environ.get("S3_BUCKET")

    if not vault:
        raise EnvironmentError("VAULT_PATH environment variable is not set.")
    if not bucket:
        raise EnvironmentError("S3_BUCKET environment variable is not set.")

    raw["vault_path"] = vault
    raw["s3"]["bucket_name"] = bucket

    key_hex = os.environ.get("BACKUP_ENCRYPTION_KEY")
    if not key_hex:
        raise EnvironmentError(
            "BACKUP_ENCRYPTION_KEY environment variable is not set. "
            "Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\""
        )

    try:
        key_bytes = bytes.fromhex(key_hex)
    except ValueError:
        raise ValueError("BACKUP_ENCRYPTION_KEY must be a valid hex string (64 hex chars for AES-256)")

    if len(key_bytes) != 32:
        raise ValueError(f"BACKUP_ENCRYPTION_KEY must be 32 bytes (got {len(key_bytes)})")

    logger.info(f"Config loaded from {config_path}")
    return AppConfig(**raw, encryption_key=key_bytes)