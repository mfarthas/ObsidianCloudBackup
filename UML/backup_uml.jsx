import { useState } from "react";

const phases = [
  {
    id: 0,
    label: "Phase 0",
    title: "Foundation",
    color: "#4A9EFF",
    accent: "#1a3a5c",
    files: ["cli.py", "config.py", "logging_config.py", "config.yaml"],
    components: [
      {
        name: "cli.py",
        type: "Entry Point",
        methods: [
          { name: "main()", desc: "Parses CLI arguments, loads config, routes to the correct command handler. Entry point for the entire application." },
          { name: "cmd_backup(args, config)", desc: "Handler for 'backup run'. Currently a placeholder — will trigger the full backup engine in Phase 3." },
          { name: "cmd_restore(args, config)", desc: "Handler for 'backup restore'. Placeholder — will orchestrate file download and decryption in Phase 4." },
          { name: "cmd_list(args, config)", desc: "Handler for 'backup list'. Currently used as a test harness — will list complete snapshots from SQLite in Phase 4." },
          { name: "cmd_verify(args, config)", desc: "Handler for 'backup verify'. Placeholder — will check S3 blob integrity without restoring files in Phase 5." },
          { name: "cmd_prune(args, config)", desc: "Handler for 'backup prune'. Placeholder — will apply retention policy and remove old blobs in Phase 6." },
        ]
      },
      {
        name: "config.py",
        type: "Config Loader & Validator",
        methods: [
          { name: "load_config(config_path)", desc: "Reads config.yaml, validates all fields with Pydantic, loads the encryption key from the BACKUP_ENCRYPTION_KEY env var. Fails hard with a clear error if the key is missing or malformed." },
          { name: "AppConfig", desc: "Pydantic model representing the full app config. Fields: vault_path, s3 (S3Config), backup (BackupConfig), retention (RetentionConfig), encryption_key (bytes, excluded from serialization)." },
          { name: "S3Config", desc: "Pydantic model for S3 settings: bucket_name, region, endpoint_url (null for AWS, set for MinIO)." },
          { name: "BackupConfig", desc: "Pydantic model for backup settings: ignore_patterns list (e.g. *.tmp, .obsidian/**)." },
          { name: "RetentionConfig", desc: "Pydantic model for retention settings: keep_last (default 10 snapshots)." },
        ]
      },
      {
        name: "logging_config.py",
        type: "Logging Setup",
        methods: [
          { name: "setup_logging(level)", desc: "Configures the root logger with a timestamped format. Outputs to stdout. Level is controlled by --log-level CLI flag. INFO shows normal events, DEBUG shows fine-grained detail like individual file hashes." },
        ]
      },
      {
        name: "config.yaml",
        type: "Settings File (non-sensitive only)",
        methods: [
          { name: "s3.endpoint_url", desc: "null for AWS S3 (boto3 routes automatically). Set to http://localhost:9000 for local MinIO." },
          { name: "s3.region", desc: "AWS region. Ignored by MinIO but required by boto3. Defaults to eu-west-1." },
          { name: "backup.ignore_patterns", desc: "List of glob patterns for files to skip. Matched against both full relative paths and filenames." },
          { name: "retention.keep_last", desc: "How many complete snapshots to retain when pruning. Older ones are deleted along with their orphaned blobs." },
          { name: "db_path", desc: "Path to the local SQLite database file (backup.db). Stores all snapshot, file, and blob metadata." },
        ]
      },
      {
        name: ".env",
        type: "Secret Config (gitignored)",
        methods: [
          { name: "VAULT_PATH", desc: "Absolute path to the vault folder. Kept in .env so it never appears in committed files. Read by load_config() via os.environ and injected into AppConfig at runtime." },
          { name: "S3_BUCKET", desc: "Name of the S3 or MinIO bucket. Kept in .env — bucket names can reveal personal or organisational information." },
          { name: "BACKUP_ENCRYPTION_KEY", desc: "64-character hex string representing a 32-byte AES-256 key. Never written to any committed file. Generate with: python -c 'import secrets; print(secrets.token_hex(32))'." },
          { name: "AWS_ACCESS_KEY_ID", desc: "S3 or MinIO access key. Read automatically by boto3 from environment — no code change needed when switching between MinIO and AWS." },
          { name: "AWS_SECRET_ACCESS_KEY", desc: "S3 or MinIO secret key. Paired with AWS_ACCESS_KEY_ID. For local MinIO this matches MINIO_ROOT_PASSWORD." },
          { name: ".env.example", desc: "A committed template with placeholder values for all env vars. Allows anyone cloning the repo to see exactly what variables are needed without exposing real values." },
        ]
      },
    ]
  },
  {
    id: 1,
    label: "Phase 1",
    title: "Scanner & Hasher",
    color: "#34D399",
    accent: "#064e3b",
    files: ["core/scanner.py", "core/hasher.py"],
    components: [
      {
        name: "scanner.py",
        type: "Vault Walker",
        methods: [
          { name: "scan_vault(vault_path, ignore_patterns)", desc: "Recursively walks the entire vault directory using rglob('*'). Skips directories and any file matching an ignore pattern. Returns a list of Path objects for all included files." },
          { name: "should_ignore(path, vault_path, ignore_patterns)", desc: "Checks a single file against all ignore patterns using fnmatch. Matches against both the relative path (for directory patterns like .obsidian/**) and the bare filename (for extension patterns like *.tmp)." },
        ]
      },
      {
        name: "hasher.py",
        type: "File Fingerprinter",
        methods: [
          { name: "hash_file(path)", desc: "Computes a SHA-256 hash of a file's contents. Reads the file in 64KB chunks (CHUNK_SIZE=65536) to avoid loading large files into memory. Returns a 64-character hex string that uniquely identifies the file's contents." },
        ]
      },
    ]
  },
  {
    id: 2,
    label: "Phase 2",
    title: "SQLite Metadata",
    color: "#F59E0B",
    accent: "#451a03",
    files: ["core/metadata.py", "backup.db"],
    components: [
      {
        name: "metadata.py",
        type: "Database Layer",
        methods: [
          { name: "get_connection(db_path)", desc: "Opens a SQLite connection with two important settings: WAL journal mode (safer, faster writes) and foreign_keys=ON (enforces referential integrity between tables). Uses row_factory=sqlite3.Row for dict-like row access." },
          { name: "init_db(db_path)", desc: "Creates the three core tables if they don't exist: snapshots, files, and blobs. Safe to call on every startup." },
          { name: "create_snapshot(conn)", desc: "Inserts a new row into snapshots with status='pending' and the current UTC timestamp. Returns the new snapshot ID. A snapshot stays pending until finalize_snapshot is called — if the program crashes, it stays pending forever." },
          { name: "finalize_snapshot(conn, snapshot_id)", desc: "Updates a snapshot's status from 'pending' to 'complete'. This is the atomic commit point — only called after all files have been hashed, encrypted, uploaded, and registered." },
          { name: "insert_file(conn, snapshot_id, path, blob_hash)", desc: "Registers a file record linked to a snapshot. Stores the full file path and its SHA-256 hash. Multiple snapshots can reference the same blob_hash." },
          { name: "blob_exists(conn, blob_hash)", desc: "Checks whether a blob with this hash already exists in the blobs table. Used before every upload — if true, the file is already in S3 and can be skipped entirely. This is the deduplication gate." },
          { name: "insert_blob(conn, blob_hash, size)", desc: "Registers a blob as uploaded. Uses INSERT OR IGNORE so duplicate calls are safe. Stores hash, file size in bytes, and upload timestamp." },
          { name: "list_snapshots(conn, include_all)", desc: "Returns all complete snapshots ordered by date descending. If include_all=True, also returns failed and pending snapshots." },
          { name: "mark_failed_pending_snapshots(conn)", desc: "Crash recovery detection. On startup, finds any snapshots still in 'pending' status and marks them 'failed'. These are leftovers from crashed backup runs. Logs a warning so the user knows something went wrong last time." },
        ]
      },
      {
        name: "backup.db (schema)",
        type: "SQLite Tables",
        methods: [
          { name: "snapshots", desc: "id (PK), created_at (UTC ISO timestamp), status ('pending' | 'complete' | 'failed'). One row per backup run." },
          { name: "files", desc: "id (PK), snapshot_id (FK → snapshots), path (full file path), blob_hash (SHA-256). One row per file per snapshot." },
          { name: "blobs", desc: "hash (PK, SHA-256), size (bytes), uploaded_at (UTC ISO timestamp). One row per unique file content ever uploaded to S3. Shared across all snapshots." },
        ]
      },
    ]
  },
  {
    id: 3,
    label: "Phase 3",
    title: "Encryption",
    color: "#F472B6",
    accent: "#4a0030",
    files: ["core/encryptor.py"],
    components: [
      {
        name: "encryptor.py",
        type: "AES-256-GCM",
        methods: [
          { name: "encrypt(data, key)", desc: "Encrypts raw bytes using AES-256-GCM. Generates a fresh random 12-byte nonce for every call using os.urandom — reusing a nonce with the same key would be catastrophic for security. Returns a blob formatted as [12B nonce][ciphertext+16B GCM tag]. The tag is appended automatically by the cryptography library." },
          { name: "decrypt(blob, key)", desc: "Reverses encrypt(). Splits the blob at byte 12 to extract the nonce, then decrypts. AES-GCM verifies the authentication tag before returning data — if the blob was tampered with, truncated, or corrupted, this throws an exception. A successful decrypt is cryptographic proof the data is intact and untampered." },
          { name: "NONCE_SIZE = 12", desc: "96-bit nonce — the standard size for AES-GCM. Generated fresh per file per backup run." },
          { name: "TAG_SIZE = 16", desc: "128-bit GCM authentication tag. Appended to ciphertext automatically. This is what makes integrity verification work — the tag is a cryptographic fingerprint of the ciphertext that cannot be forged without the key." },
        ]
      },
    ]
  },
  {
    id: 4,
    label: "Phase 4",
    title: "S3 Storage + Restore",
    color: "#A78BFA",
    accent: "#2e1065",
    files: ["core/storage.py"],
    components: [
      {
        name: "storage.py",
        type: "S3 Client",
        methods: [
          { name: "S3Client.__init__(config)", desc: "Initialises a boto3 S3 client. If endpoint_url is set in config, routes to that address (MinIO or any S3-compatible service). If null, boto3 routes to AWS automatically. Credentials are read from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables." },
          { name: "upload_blob(blob_hash, data)", desc: "Uploads encrypted bytes to S3 under the key blobs/<hash>. The hash becomes the filename — this is what enables deduplication. Two identical files produce the same hash and map to the same S3 object, so only one upload ever happens regardless of how many snapshots reference it." },
          { name: "download_blob(blob_hash)", desc: "Downloads and returns the raw encrypted bytes for a given hash. Used by both restore and verify commands. The returned bytes go straight to decrypt() — nothing is written to disk until decryption succeeds." },
          { name: "blob_exists_remote(blob_hash)", desc: "Uses S3 HEAD request to check if a blob exists without downloading it. Lightweight existence check — used as a safety check during restore to give a clear error before attempting a download that will fail." },
          { name: "delete_blob(blob_hash)", desc: "Deletes a blob from S3. Only called by cmd_prune after confirming the blob is an orphan — not referenced by any remaining snapshot. Wrapped in try/catch so a single failed deletion doesn't abort the entire prune operation." },
        ]
      },
      {
        name: "cmd_restore (cli.py)",
        type: "Restore Engine",
        methods: [
          { name: "Snapshot selection", desc: "If --snapshot ID is passed, restores that specific snapshot. Otherwise defaults to the latest complete snapshot from the DB." },
          { name: "Per-file restore loop", desc: "For each file record in the snapshot: downloads the encrypted blob from S3, decrypts it in memory, creates any missing parent directories, then writes the decrypted bytes to the original file path. Files are never written until decryption succeeds." },
          { name: "Post-restore summary", desc: "Reports restored vs failed counts. A failed file means either the blob was missing from S3 or decryption failed — both are logged with the filename so you know exactly what didn't restore." },
        ]
      },
    ]
  },
  {
    id: 5,
    label: "Phase 5",
    title: "Integrity Verify",
    color: "#2DD4BF",
    accent: "#042f2e",
    files: ["cli.py → cmd_verify"],
    components: [
      {
        name: "cmd_verify (cli.py)",
        type: "Integrity Check",
        methods: [
          { name: "Verify without restoring", desc: "Downloads every encrypted blob referenced by the snapshot and attempts to decrypt it — but discards the decrypted data immediately. Nothing is written to disk. This is a pure health check." },
          { name: "GCM tag verification", desc: "AES-GCM authentication tags mean a successful decrypt is cryptographic proof the blob is intact and untampered. Any corruption, truncation, or tampering causes decryption to throw — which is caught and counted as 'corrupted'." },
          { name: "Three-state result", desc: "Each blob is classified as: ok (downloaded and decrypted successfully), missing (blob not found in S3 — RuntimeError from download), or corrupted (blob exists but decryption failed — tag mismatch). Final summary shows counts for all three states." },
          { name: "Snapshot selection", desc: "Defaults to latest complete snapshot. Accepts --snapshot ID to verify any specific historical snapshot." },
        ]
      },
    ]
  },
  {
    id: 6,
    label: "Phase 6",
    title: "Retention + Prune",
    color: "#FB923C",
    accent: "#431407",
    files: ["cli.py → cmd_prune"],
    components: [
      {
        name: "cmd_prune (cli.py)",
        type: "Retention Policy",
        methods: [
          { name: "keep_last policy", desc: "Reads keep_last from config (default 10). Fetches all complete snapshots ordered newest-first. If count is within the limit, exits early with no changes. Otherwise selects all snapshots beyond the keep_last cutoff for deletion." },
          { name: "Snapshot deletion", desc: "For each snapshot to delete: removes all file records linked to it, then removes the snapshot row itself. Order matters — files must be deleted before the snapshot due to the foreign key constraint." },
          { name: "Orphan blob detection", desc: "After removing snapshot and file records, queries for blobs whose hash no longer appears in ANY file record across ALL remaining snapshots. These are orphaned blobs — safe to delete because no snapshot needs them anymore." },
          { name: "Orphan blob cleanup", desc: "Deletes each orphaned blob from S3, then removes it from the blobs table. Each deletion is wrapped in try/catch — a single S3 failure is logged but doesn't abort the rest of the prune. This is what keeps S3 storage costs from growing indefinitely." },
        ]
      },
    ]
  },
  {
    id: 7,
    label: "Phase 7",
    title: "CLI Polish",
    color: "#94A3B8",
    accent: "#0f172a",
    files: ["cli.py (rich)"],
    components: [
      {
        name: "rich integration",
        type: "CLI UX",
        methods: [
          { name: "Progress bars", desc: "All long-running commands (run, restore, verify) show a live progress bar with spinner, current filename, percentage, and elapsed time. Built with rich.progress. For large vaults this is the difference between a tool that looks broken and one that feels professional." },
          { name: "Coloured output", desc: "Success messages print in green (✓), errors in red (✗), warnings in yellow. Status in the list table is colour-coded: green for complete, red for failed. Uses rich markup syntax e.g. [green]text[/green]." },
          { name: "Snapshot table", desc: "cmd_list renders a formatted table using rich.table with columns: ID, Created At, Status (coloured), Files. Much more readable than raw print statements." },
          { name: "Console instance", desc: "A single shared Console() instance is used throughout cli.py. This ensures rich output and logging output don't interleave or corrupt each other during progress bar rendering." },
        ]
      },
      {
        name: "cmd_backup — DB backup",
        type: "Metadata Safety",
        methods: [
          { name: "Metadata backup to S3", desc: "After every successful backup run, backup.db is uploaded to S3 under the key metadata/backup.db. This resolves the known limitation of local-only metadata — if the local database is lost, it can be recovered from S3 before running a restore." },
          { name: "cmd_recover_db(args, config)", desc: "Downloads metadata/backup.db from S3 and writes it to the local db_path. Run this first if backup.db is ever lost. Once recovered, all snapshots and file records are available and restore can proceed normally." },
          { name: "S3 bucket layout", desc: "Both blobs and metadata live in the same bucket under separate prefixes: blobs/<hash> for encrypted file content, metadata/backup.db for the SQLite database. S3 prefixes act as logical namespaces with no collision risk." },
        ]
      },
    ]
  },
];

const Arrow = () => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "0 8px" }}>
    <div style={{ width: 40, height: 2, background: "linear-gradient(90deg, #334155, #64748b)" }} />
    <div style={{ width: 0, height: 0, borderTop: "6px solid transparent", borderBottom: "6px solid transparent", borderLeft: "8px solid #64748b" }} />
  </div>
);

export default function UML() {
  const [selected, setSelected] = useState(null);

  const selectedMethod = selected
    ? phases.flatMap(p => p.components).flatMap(c => c.methods).find(m => m.name === selected.name)
    : null;

  return (
    <div style={{
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      background: "#0a0f1a",
      minHeight: "100vh",
      color: "#e2e8f0",
      padding: "32px 24px",
    }}>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 40, borderBottom: "1px solid #1e293b", paddingBottom: 24 }}>
          <div style={{ fontSize: 11, color: "#4A9EFF", letterSpacing: 4, textTransform: "uppercase", marginBottom: 8 }}>
            ObsidianCloudBackup
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: "#f1f5f9" }}>
            System Architecture · Phases 0–7
          </h1>
          <p style={{ fontSize: 12, color: "#64748b", marginTop: 8 }}>
            Click any method to see detailed documentation
          </p>
        </div>

        {/* Flow diagram */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 0, marginBottom: 48, overflowX: "auto", paddingBottom: 8 }}>
          {phases.map((phase, i) => (
            <div key={phase.id} style={{ display: "flex", alignItems: "flex-start" }}>
              <div style={{
                background: "#0f172a",
                border: `1px solid ${phase.color}33`,
                borderRadius: 12,
                padding: "20px 20px",
                minWidth: 200,
                position: "relative",
              }}>
                <div style={{
                  position: "absolute", top: -1, left: 20, right: 20, height: 3,
                  background: phase.color, borderRadius: "0 0 4px 4px"
                }} />
                <div style={{ fontSize: 10, color: phase.color, letterSpacing: 3, textTransform: "uppercase", marginBottom: 4 }}>
                  {phase.label}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#f1f5f9", marginBottom: 12 }}>
                  {phase.title}
                </div>
                {phase.files.map(f => (
                  <div key={f} style={{
                    fontSize: 11, color: "#94a3b8", padding: "4px 8px",
                    background: "#1e293b", borderRadius: 4, marginBottom: 4,
                    fontFamily: "monospace"
                  }}>
                    {f}
                  </div>
                ))}
              </div>
              {i < phases.length - 1 && <Arrow />}
            </div>
          ))}
        </div>

        {/* Component cards */}
        <div style={{ display: "flex", flexDirection: "column", gap: 48 }}>
          {phases.map(phase => (
            <div key={phase.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                <div style={{ width: 12, height: 12, borderRadius: "50%", background: phase.color }} />
                <span style={{ fontSize: 13, color: phase.color, letterSpacing: 2, textTransform: "uppercase" }}>
                  {phase.label} — {phase.title}
                </span>
                <div style={{ flex: 1, height: 1, background: `${phase.color}22` }} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16 }}>
                {phase.components.map(comp => (
                  <div key={comp.name} style={{
                    background: "#0f172a",
                    border: `1px solid #1e293b`,
                    borderRadius: 10,
                    overflow: "hidden",
                  }}>
                    {/* Component header */}
                    <div style={{
                      padding: "14px 18px",
                      background: `${phase.color}11`,
                      borderBottom: `1px solid ${phase.color}22`,
                      display: "flex", justifyContent: "space-between", alignItems: "center"
                    }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9", fontFamily: "monospace" }}>
                        {comp.name}
                      </span>
                      <span style={{
                        fontSize: 10, color: phase.color, padding: "2px 8px",
                        border: `1px solid ${phase.color}44`, borderRadius: 20, letterSpacing: 1
                      }}>
                        {comp.type}
                      </span>
                    </div>

                    {/* Methods */}
                    <div style={{ padding: "10px 0" }}>
                      {comp.methods.map(method => (
                        <div
                          key={method.name}
                          onClick={() => setSelected(selected?.name === method.name ? null : method)}
                          style={{
                            padding: "8px 18px",
                            cursor: "pointer",
                            background: selected?.name === method.name ? `${phase.color}15` : "transparent",
                            borderLeft: selected?.name === method.name ? `3px solid ${phase.color}` : "3px solid transparent",
                            transition: "all 0.15s ease",
                          }}
                          onMouseEnter={e => { if (selected?.name !== method.name) e.currentTarget.style.background = "#1e293b" }}
                          onMouseLeave={e => { if (selected?.name !== method.name) e.currentTarget.style.background = "transparent" }}
                        >
                          <div style={{ fontSize: 12, color: "#7dd3fc", fontFamily: "monospace" }}>
                            {method.name}
                          </div>
                          {selected?.name === method.name && (
                            <div style={{
                              fontSize: 12, color: "#94a3b8", marginTop: 8,
                              lineHeight: 1.7, fontFamily: "system-ui, sans-serif"
                            }}>
                              {method.desc}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{ marginTop: 48, paddingTop: 24, borderTop: "1px solid #1e293b", fontSize: 11, color: "#334155", textAlign: "center" }}>
          ObsidianCloudBackup · AES-256-GCM · boto3 · SQLite · Python
        </div>
      </div>
    </div>
  );
}
