import os
import logging
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

NONCE_SIZE = 12  # 96 bits — standard for AES-GCM
TAG_SIZE = 16    # 128 bits — appended automatically by cryptography library


def encrypt(data: bytes, key: bytes) -> bytes:
    nonce = os.urandom(NONCE_SIZE)
    aesgcm = AESGCM(key)
    ciphertext_and_tag = aesgcm.encrypt(nonce, data, None)
    # blob format: [12B nonce][ciphertext+tag]
    return nonce + ciphertext_and_tag


def decrypt(blob: bytes, key: bytes) -> bytes:
    nonce = blob[:NONCE_SIZE]
    ciphertext_and_tag = blob[NONCE_SIZE:]
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(nonce, ciphertext_and_tag, None)