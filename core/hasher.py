import hashlib
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

CHUNK_SIZE = 65536  # 64KB


def hash_file(path: Path) -> str:
    sha256 = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK_SIZE):
            sha256.update(chunk)
    digest = sha256.hexdigest()
    logger.debug(f"Hashed {path}: {digest[:8]}...")
    return digest
