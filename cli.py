import argparse
import sys
import logging
from logging_config import setup_logging
from config import load_config
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn
from rich.table import Table

logger = logging.getLogger(__name__)
console = Console()


def cmd_backup(args, config):
    from core.scanner import scan_vault
    from core.hasher import hash_file
    from core.encryptor import encrypt
    from core.storage import S3Client
    from core.metadata import (
        init_db, get_connection, create_snapshot, finalize_snapshot,
        insert_file, insert_blob, blob_exists, mark_failed_pending_snapshots
    )

    init_db(config.db_path)
    s3 = S3Client(config.s3)

    with get_connection(config.db_path) as conn:
        mark_failed_pending_snapshots(conn)
        snapshot_id = create_snapshot(conn)

        try:
            files = scan_vault(config.vault_path, config.backup.ignore_patterns)
            new_blobs = 0
            skipped = 0

            with Progress(
                SpinnerColumn(),
                TextColumn("[bold blue]{task.description}"),
                BarColumn(),
                TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
                TimeElapsedColumn(),
                console=console,
            ) as progress:
                task = progress.add_task("Backing up...", total=len(files))

                for f in files:
                    progress.update(task, description=f"[bold blue]{f.name}")
                    blob_hash = hash_file(f)
                    insert_file(conn, snapshot_id, str(f), blob_hash)

                    if not blob_exists(conn, blob_hash):
                        data = f.read_bytes()
                        encrypted = encrypt(data, config.encryption_key)
                        s3.upload_blob(blob_hash, encrypted)
                        insert_blob(conn, blob_hash, len(data))
                        new_blobs += 1
                    else:
                        skipped += 1

                    progress.advance(task)

            finalize_snapshot(conn, snapshot_id)

            with open(config.db_path, "rb") as f:
                s3.upload_blob("metadata/backup.db", f.read())
            logger.info("Metadata database backed up to S3")

            console.print(f"\n[green]Backup complete[/green] — snapshot [bold]{snapshot_id}[/bold] | [bold]{new_blobs}[/bold] uploaded, [bold]{skipped}[/bold] deduplicated")

        except Exception as e:
            logger.error(f"Backup failed: {e}")
            raise


def cmd_restore(args, config):
    from core.storage import S3Client
    from core.encryptor import decrypt
    from core.metadata import init_db, get_connection, list_snapshots
    from pathlib import Path

    init_db(config.db_path)
    s3 = S3Client(config.s3)

    with get_connection(config.db_path) as conn:
        if args.snapshot:
            snapshot_id = int(args.snapshot)
        else:
            snapshots = list_snapshots(conn)
            if not snapshots:
                console.print("[red]No complete snapshots found[/red]")
                return
            snapshot_id = snapshots[0]["id"]
            console.print(f"No snapshot specified — using latest: [bold]{snapshot_id}[/bold]")

        files = conn.execute(
            "SELECT path, blob_hash FROM files WHERE snapshot_id = ?",
            (snapshot_id,)
        ).fetchall()

        if not files:
            console.print(f"[red]No files found for snapshot {snapshot_id}[/red]")
            return

        restored = 0
        failed = 0

        with Progress(
            SpinnerColumn(),
            TextColumn("[bold green]{task.description}"),
            BarColumn(),
            TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
            TimeElapsedColumn(),
            console=console,
        ) as progress:
            task = progress.add_task("Restoring...", total=len(files))

            for row in files:
                path = Path(row["path"])
                blob_hash = row["blob_hash"]
                progress.update(task, description=f"[bold green]{path.name}")

                try:
                    encrypted = s3.download_blob(blob_hash)
                    data = decrypt(encrypted, config.encryption_key)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
                    restored += 1
                except Exception as e:
                    logger.error(f"Failed to restore {path.name}: {e}")
                    failed += 1

                progress.advance(task)

        console.print(f"\n[green]Restore complete[/green] — [bold]{restored}[/bold] restored, [bold]{failed}[/bold] failed")


def cmd_list(args, config):
    from core.metadata import init_db, get_connection, list_snapshots

    init_db(config.db_path)

    with get_connection(config.db_path) as conn:
        snapshots = list_snapshots(conn, include_all=hasattr(args, 'all') and args.all)
        if not snapshots:
            console.print("No snapshots found")
            return

        table = Table(title="Snapshots", show_header=True, header_style="bold blue")
        table.add_column("ID", style="bold")
        table.add_column("Created At")
        table.add_column("Status")
        table.add_column("Files", justify="right")

        for s in snapshots:
            file_count = conn.execute(
                "SELECT COUNT(*) FROM files WHERE snapshot_id = ?", (s["id"],)
            ).fetchone()[0]
            status_color = "green" if s["status"] == "complete" else "red"
            table.add_row(
                str(s["id"]),
                s["created_at"],
                f"[{status_color}]{s['status']}[/{status_color}]",
                str(file_count)
            )

        console.print(table)


def cmd_verify(args, config):
    from core.storage import S3Client
    from core.encryptor import decrypt
    from core.metadata import init_db, get_connection, list_snapshots

    init_db(config.db_path)
    s3 = S3Client(config.s3)

    with get_connection(config.db_path) as conn:
        if args.snapshot:
            snapshot_id = int(args.snapshot)
        else:
            snapshots = list_snapshots(conn)
            if not snapshots:
                console.print("[red]No complete snapshots found[/red]")
                return
            snapshot_id = snapshots[0]["id"]
            console.print(f"No snapshot specified — verifying latest: [bold]{snapshot_id}[/bold]")

        files = conn.execute(
            "SELECT path, blob_hash FROM files WHERE snapshot_id = ?",
            (snapshot_id,)
        ).fetchall()

        if not files:
            console.print(f"[red]No files found for snapshot {snapshot_id}[/red]")
            return

        ok = 0
        missing = 0
        corrupted = 0

        with Progress(
            SpinnerColumn(),
            TextColumn("[bold yellow]{task.description}"),
            BarColumn(),
            TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
            TimeElapsedColumn(),
            console=console,
        ) as progress:
            task = progress.add_task("Verifying...", total=len(files))

            for row in files:
                blob_hash = row["blob_hash"]
                path = row["path"]
                progress.update(task, description=f"[bold yellow]{path}")

                try:
                    encrypted = s3.download_blob(blob_hash)
                    decrypt(encrypted, config.encryption_key)
                    ok += 1
                except RuntimeError:
                    logger.error(f"MISSING blob for {path}")
                    missing += 1
                except Exception:
                    logger.error(f"CORRUPTED blob for {path}")
                    corrupted += 1

                progress.advance(task)

        if missing == 0 and corrupted == 0:
            console.print(f"\n[green]Verification passed[/green] — [bold]{ok}/{len(files)}[/bold] blobs intact")
        else:
            console.print(f"\n[red]Verification failed[/red] — {ok} ok, {missing} missing, {corrupted} corrupted")


def cmd_prune(args, config):
    from core.storage import S3Client
    from core.metadata import init_db, get_connection

    init_db(config.db_path)
    s3 = S3Client(config.s3)

    with get_connection(config.db_path) as conn:
        keep_last = config.retention.keep_last
        snapshots = conn.execute(
            "SELECT id FROM snapshots WHERE status = 'complete' ORDER BY created_at DESC"
        ).fetchall()

        if len(snapshots) <= keep_last:
            console.print(f"Nothing to prune — [bold]{len(snapshots)}[/bold] snapshots, keeping last [bold]{keep_last}[/bold]")
            return

        to_delete = snapshots[keep_last:]
        console.print(f"Pruning [bold]{len(to_delete)}[/bold] snapshot(s), keeping last [bold]{keep_last}[/bold]")

        for row in to_delete:
            snapshot_id = row["id"]
            conn.execute("DELETE FROM files WHERE snapshot_id = ?", (snapshot_id,))
            conn.execute("DELETE FROM snapshots WHERE id = ?", (snapshot_id,))
            logger.info(f"Deleted snapshot {snapshot_id}")

        orphaned = conn.execute("""
            SELECT hash FROM blobs
            WHERE hash NOT IN (SELECT DISTINCT blob_hash FROM files)
        """).fetchall()

        deleted_blobs = 0
        for row in orphaned:
            blob_hash = row["hash"]
            try:
                s3.delete_blob(blob_hash)
                conn.execute("DELETE FROM blobs WHERE hash = ?", (blob_hash,))
                deleted_blobs += 1
            except Exception as e:
                logger.error(f"Failed to delete blob {blob_hash[:8]}: {e}")

        console.print(f"[green]Pruning complete[/green] — [bold]{len(to_delete)}[/bold] snapshots removed, [bold]{deleted_blobs}[/bold] orphaned blobs deleted")

def cmd_recover_db(args, config):
    from core.storage import S3Client
    s3 = S3Client(config.s3)
    data = s3.download_blob("metadata/backup.db")
    with open(config.db_path, "wb") as f:
        f.write(data)
    console.print("[green]Database recovered from S3[/green]")


def main():
    from dotenv import load_dotenv
    load_dotenv()

    parser = argparse.ArgumentParser(
        prog="backup",
        description="Encrypted cloud backup for Obsidian vaults"
    )
    parser.add_argument("--config", default="config.yaml", help="Path to config file")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])

    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("run", help="Create a new backup snapshot")
    subparsers.add_parser("recover-db", help="Restore metadata database from S3")

    restore_p = subparsers.add_parser("restore", help="Restore from a snapshot")
    restore_p.add_argument("--snapshot", default=None, help="Snapshot ID (default: latest)")

    list_p = subparsers.add_parser("list", help="List available snapshots")
    list_p.add_argument("--all", action="store_true", help="Include failed snapshots")

    verify_p = subparsers.add_parser("verify", help="Verify snapshot integrity without restoring")
    verify_p.add_argument("--snapshot", default=None, help="Snapshot ID (default: latest)")

    subparsers.add_parser("prune", help="Apply retention policy")

    args = parser.parse_args()
    setup_logging(args.log_level)

    if args.command is None:
        parser.print_help()
        sys.exit(0)

    try:
        config = load_config(args.config)
    except (FileNotFoundError, EnvironmentError, ValueError) as e:
        logger.error(str(e))
        sys.exit(1)

    dispatch = {
        "run": cmd_backup,
        "restore": cmd_restore,
        "list": cmd_list,
        "verify": cmd_verify,
        "prune": cmd_prune,
        "recover-db": cmd_recover_db,
    }
    dispatch[args.command](args, config)


if __name__ == "__main__":
    main()