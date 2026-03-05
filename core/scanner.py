import logging
from pathlib import Path
from fnmatch import fnmatch

logger = logging.getLogger(__name__)


def should_ignore(path: Path, vault_path: Path, ignore_patterns: list[str]) -> bool:
    relative = path.relative_to(vault_path)
    for pattern in ignore_patterns:
        if fnmatch(str(relative), pattern):
            return True
        if fnmatch(path.name, pattern):
            return True
    return False


def scan_vault(vault_path: Path, ignore_patterns: list[str]) -> list[Path]:
    vault_path = Path(vault_path)
    if not vault_path.exists():
        raise FileNotFoundError(f"Vault path does not exist: {vault_path}")

    files = []
    for path in vault_path.rglob("*"):
        if not path.is_file():
            continue
        if should_ignore(path, vault_path, ignore_patterns):
            logger.debug(f"Ignoring: {path}")
            continue
        files.append(path)

    logger.info(f"Scanned vault: {len(files)} files found in {vault_path}")
    return files