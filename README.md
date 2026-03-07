# ObsidianCloudBackup

An encrypted command-line backup system for local vaults. Files are encrypted on your machine with AES-256-GCM before they leave disk, the cloud provider holds only opaque ciphertext. Works with AWS S3 and self-hosted MinIO.

---

## Features

- **AES-256-GCM encryption** — authenticated encryption with integrity verification built in
- **Content-addressed deduplication** — identical files are uploaded once, regardless of how many backups reference them
- **Atomic snapshots** — backups are either complete or they don't exist; no partial state
- **Integrity verification** — cryptographically verify your backup without restoring any files
- **Retention policy** — automatically prune old snapshots and clean up orphaned blobs
- **Crash recovery** — interrupted backups are detected and marked failed on next run
- **S3-compatible** — works with AWS S3 or a self-hosted MinIO instance

---

## Requirements

- Python 3.12+
- An S3-compatible bucket (AWS S3 or MinIO)

---

## Installation

```bash
git clone https://github.com/yourusername/ObsidianCloudBackup.git
cd ObsidianCloudBackup
python -m venv .venv

# Windows
.venv\Scripts\Activate.ps1

# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

---

## Configuration

### 1. Set up environment variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
BACKUP_ENCRYPTION_KEY=your_64_char_hex_key_here
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
VAULT_PATH=/path/to/your/vault
S3_BUCKET=your-bucket-name
```

Generate an encryption key:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### 2. Edit `config.yaml`

```yaml
s3:
  region: "us-east-1"
  endpoint_url: null          # null for AWS S3, "http://localhost:9000" for MinIO

backup:
  ignore_patterns:
    - "*.tmp"
    - ".trash/**"
    - ".obsidian/**"

retention:
  keep_last: 10

db_path: "backup.db"
```

---

## Local Development with MinIO

If you want to test locally without an AWS account, you can use MinIO via Docker:

```bash
docker run -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=your_username \
  -e MINIO_ROOT_PASSWORD=your_password \
  -v minio_data:/data \
  minio/minio server /data --console-address ":9001"
```

Then open `http://localhost:9001`, create a bucket, and set in `config.yaml`:

```yaml
s3:
  endpoint_url: "http://localhost:9000"
```

Set your env vars to match your MinIO credentials:
```env
AWS_ACCESS_KEY_ID=your_username
AWS_SECRET_ACCESS_KEY=your_password
```

> **S3 bucket layout:** blobs are stored under `blobs/<hash>` and the metadata database under `metadata/backup.db`

---

## Usage

```bash
# Create a new backup snapshot
python cli.py --config config.yaml run

# List all snapshots
python cli.py --config config.yaml list

# Verify backup integrity without restoring
python cli.py --config config.yaml verify

# Restore latest snapshot
python cli.py --config config.yaml restore

# Restore a specific snapshot
python cli.py --config config.yaml restore --snapshot 3

# Apply retention policy (removes old snapshots and orphaned blobs)
python cli.py --config config.yaml prune

# Recover metadata database from S3 (run this first if backup.db is lost)
python cli.py --config config.yaml recover-db
```

### Optional flags

```bash
--log-level DEBUG    # Show detailed per-file logging (default: INFO)
list --all           # Include failed and pending snapshots in listing
```

---

## How It Works

### Backup

1. Scans your vault recursively, applying ignore patterns
2. Computes a SHA-256 hash for each file
3. Skips upload if the hash already exists in S3 (deduplication)
4. Encrypts new files with AES-256-GCM in memory 
5. Uploads encrypted blobs to S3 under their hash as the filename
6. Records everything in a local SQLite database
7. Marks the snapshot complete atomically at the end

### Restore

1. Looks up all files for the selected snapshot in SQLite
2. Downloads each encrypted blob from S3
3. Decrypts in memory and writes to the original file path
4. Creates any missing directories automatically

### Verify

Downloads and decrypts every blob for a snapshot without writing anything to disk. AES-GCM authentication tags mean a successful decrypt is cryptographic proof the data is intact and untampered.

---

## Security Model

- All encryption happens locally before upload
- The cloud provider holds only ciphertext
- Each file is encrypted with a fresh random nonce

**Metadata backup:** After every successful backup run, `backup.db` is automatically uploaded to S3 under `metadata/backup.db`. If the local database is ever lost, recover it with:

```bash
python cli.py --config config.yaml recover-db
```

Then run `restore` as normal.

---

## Project Structure

```
ObsidianCloudBackup/
├── cli.py               # Entry point, command routing
├── config.py            # Config loading and validation
├── logging_config.py    # Logging setup
├── config.yaml          # Non-sensitive settings
├── .env.example         # Environment variable template
├── requirements.txt
└── core/
    ├── scanner.py       # Vault file walker
    ├── hasher.py        # SHA-256 file fingerprinting
    ├── encryptor.py     # AES-256-GCM encrypt/decrypt
    ├── storage.py       # S3/MinIO client
    └── metadata.py      # SQLite database layer
```

---

## License

GPL-3.0
