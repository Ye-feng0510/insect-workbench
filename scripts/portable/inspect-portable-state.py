#!/usr/bin/env python3
"""Inspect upgrade-sensitive portable application state without modifying it."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path, PureWindowsPath
from typing import Any


MONITORED_TABLES = (
    "app_settings",
    "users",
    "excel_templates",
    "specimen_records",
    "taxonomy_cache",
    "material_batches",
    "material_items",
    "export_artifacts",
)
SETTINGS_COLUMNS = (
    "base_url",
    "api_key",
    "model_name",
    "recognition_prompt",
    "taxonomy_prompt",
)
PATH_COLUMNS = {
    "excel_templates": ("stored_path",),
    "specimen_records": ("image_path", "processed_image_path"),
    "material_batches": ("stored_zip_path", "extract_dir"),
    "material_items": ("stored_path",),
    "export_artifacts": ("stored_path",),
}
PATH_SAMPLE_LIMIT = 20


class InspectionError(RuntimeError):
    """Raised when a database cannot be safely and completely inspected."""


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Write a secret-safe JSON summary of portable application state."
    )
    parser.add_argument(
        "--root",
        required=True,
        type=Path,
        help="Portable application root containing data/app.db.",
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Destination JSON file.",
    )
    args = parser.parse_args(argv)

    root = args.root.expanduser().resolve(strict=False)
    output = args.output.expanduser().resolve(strict=False)
    if not root.exists():
        parser.error(f"--root does not exist: {root}")
    if not root.is_dir():
        parser.error(f"--root is not a directory: {root}")
    if output.exists() and output.is_dir():
        parser.error(f"--output is a directory: {output}")
    if output == root / "data" / "app.db":
        parser.error("--output must not overwrite the application database")

    args.root = root
    args.output = output
    return args


def quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def table_names(connection: sqlite3.Connection) -> set[str]:
    rows = connection.execute(
        "SELECT name FROM sqlite_schema WHERE type = 'table'"
    ).fetchall()
    return {str(row[0]) for row in rows}


def table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    rows = connection.execute(
        f"PRAGMA table_info({quote_identifier(table)})"
    ).fetchall()
    return {str(row[1]) for row in rows}


def grouped_counts(
    connection: sqlite3.Connection, table: str, columns: set[str]
) -> dict[str, int] | None:
    if "status" not in columns:
        return None
    query = (
        f"SELECT status, COUNT(*) FROM {quote_identifier(table)} "
        "GROUP BY status ORDER BY status"
    )
    result: dict[str, int] = {}
    for status, count in connection.execute(query):
        key = "<null>" if status is None else str(status)
        result[key] = int(count)
    return result


def settings_fingerprint(
    connection: sqlite3.Connection, tables: set[str], columns: set[str]
) -> dict[str, Any]:
    if "app_settings" not in tables:
        return {"available": False, "sha256": None}
    if not set(SETTINGS_COLUMNS).issubset(columns):
        return {"available": False, "sha256": None}

    selected = ", ".join(quote_identifier(column) for column in SETTINGS_COLUMNS)
    order_by = " ORDER BY id" if "id" in columns else ""
    rows = connection.execute(
        f"SELECT {selected} FROM {quote_identifier('app_settings')}{order_by}"
    ).fetchall()
    canonical_rows = [
        {
            column: "" if value is None else str(value)
            for column, value in zip(SETTINGS_COLUMNS, row, strict=True)
        }
        for row in rows
    ]
    canonical = json.dumps(
        canonical_rows,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "available": True,
        "sha256": hashlib.sha256(canonical).hexdigest(),
    }


def classify_stored_path(value: str, root: Path) -> tuple[bool, bool]:
    """Return (is_absolute, is_rooted_at_supplied_root)."""
    candidate = Path(value)
    if candidate.is_absolute():
        try:
            candidate.resolve(strict=False).relative_to(root)
            return True, True
        except (OSError, ValueError):
            return True, False

    # A portable DB can be inspected on a non-Windows host.
    windows_candidate = PureWindowsPath(value)
    if windows_candidate.is_absolute():
        windows_root = PureWindowsPath(str(root))
        candidate_parts = tuple(part.casefold() for part in windows_candidate.parts)
        root_parts = tuple(part.casefold() for part in windows_root.parts)
        return True, candidate_parts[: len(root_parts)] == root_parts

    return False, False


def inspect_paths(
    connection: sqlite3.Connection,
    tables: set[str],
    columns_by_table: dict[str, set[str]],
    root: Path,
) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "stored_value_count": 0,
        "absolute_path_count": 0,
        "relative_path_count": 0,
        "rooted_at_supplied_root_count": 0,
        "outside_supplied_root_count": 0,
        "all_absolute_paths_rooted": None,
        "samples": [],
    }

    for table, configured_columns in PATH_COLUMNS.items():
        if table not in tables:
            continue
        for column in configured_columns:
            if column not in columns_by_table[table]:
                continue
            query = (
                f"SELECT {quote_identifier(column)} "
                f"FROM {quote_identifier(table)} "
                f"WHERE {quote_identifier(column)} IS NOT NULL "
                f"AND {quote_identifier(column)} <> ''"
            )
            for (raw_value,) in connection.execute(query):
                value = str(raw_value)
                is_absolute, rooted = classify_stored_path(value, root)
                summary["stored_value_count"] += 1
                if is_absolute:
                    summary["absolute_path_count"] += 1
                    if rooted:
                        summary["rooted_at_supplied_root_count"] += 1
                    else:
                        summary["outside_supplied_root_count"] += 1
                    if len(summary["samples"]) < PATH_SAMPLE_LIMIT:
                        summary["samples"].append(
                            {
                                "table": table,
                                "column": column,
                                "path": value,
                                "rooted_at_supplied_root": rooted,
                            }
                        )
                else:
                    summary["relative_path_count"] += 1

    if summary["absolute_path_count"]:
        summary["all_absolute_paths_rooted"] = (
            summary["outside_supplied_root_count"] == 0
        )
    return summary


def inspect_database(database: Path, root: Path) -> dict[str, Any]:
    if not database.exists():
        return {
            "present": False,
            "schema_version": None,
            "integrity": None,
            "table_row_counts": {table: None for table in MONITORED_TABLES},
            "status_counts": {
                "specimen_records": None,
                "material_items": None,
            },
            "completed_record_count": None,
            "app_settings_fingerprint": {
                "available": False,
                "sha256": None,
            },
            "stored_paths": {
                "stored_value_count": 0,
                "absolute_path_count": 0,
                "relative_path_count": 0,
                "rooted_at_supplied_root_count": 0,
                "outside_supplied_root_count": 0,
                "all_absolute_paths_rooted": None,
                "samples": [],
            },
        }
    if not database.is_file():
        raise InspectionError(f"database path is not a regular file: {database}")

    try:
        connection = sqlite3.connect(
            f"{database.as_uri()}?mode=ro",
            uri=True,
            timeout=10.0,
        )
    except sqlite3.Error as exc:
        raise InspectionError(f"unable to open database read-only: {database}") from exc

    try:
        connection.execute("PRAGMA query_only = ON")
        integrity_rows = connection.execute("PRAGMA integrity_check").fetchall()
        integrity_messages = [str(row[0]) for row in integrity_rows]
        integrity = {
            "ok": integrity_messages == ["ok"],
            "messages": integrity_messages,
        }
        if not integrity["ok"]:
            raise InspectionError(
                "SQLite integrity check failed: " + "; ".join(integrity_messages)
            )

        tables = table_names(connection)
        columns_by_table = {
            table: table_columns(connection, table)
            for table in tables
            if table in set(MONITORED_TABLES) | {"schema_version"}
        }

        schema_version = 0
        if "schema_version" in tables:
            version_columns = columns_by_table["schema_version"]
            if "version" not in version_columns:
                raise InspectionError("schema_version table has no version column")
            row = connection.execute(
                f"SELECT MAX(version) FROM {quote_identifier('schema_version')}"
            ).fetchone()
            if row is not None and row[0] is not None:
                schema_version = int(row[0])

        row_counts: dict[str, int | None] = {}
        for table in MONITORED_TABLES:
            if table not in tables:
                row_counts[table] = None
                continue
            row = connection.execute(
                f"SELECT COUNT(*) FROM {quote_identifier(table)}"
            ).fetchone()
            row_counts[table] = int(row[0]) if row is not None else 0

        status_counts: dict[str, dict[str, int] | None] = {}
        for table in ("specimen_records", "material_items"):
            if table not in tables:
                status_counts[table] = None
            else:
                status_counts[table] = grouped_counts(
                    connection, table, columns_by_table[table]
                )

        completed_count: int | None = None
        specimen_columns = columns_by_table.get("specimen_records", set())
        if "specimen_records" in tables and "status" in specimen_columns:
            row = connection.execute(
                f"SELECT COUNT(*) FROM {quote_identifier('specimen_records')} "
                "WHERE status = ?",
                ("completed",),
            ).fetchone()
            completed_count = int(row[0]) if row is not None else 0

        return {
            "present": True,
            "schema_version": schema_version,
            "integrity": integrity,
            "table_row_counts": row_counts,
            "status_counts": status_counts,
            "completed_record_count": completed_count,
            "app_settings_fingerprint": settings_fingerprint(
                connection,
                tables,
                columns_by_table.get("app_settings", set()),
            ),
            "stored_paths": inspect_paths(
                connection, tables, columns_by_table, root
            ),
        }
    except (OSError, sqlite3.Error, UnicodeError, ValueError) as exc:
        raise InspectionError(f"database inspection failed: {database}") from exc
    finally:
        connection.close()


def write_json_atomic(output: Path, payload: dict[str, Any]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=output.parent,
            prefix=f".{output.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary_name = handle.name
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, output)
    finally:
        if temporary_name is not None:
            try:
                Path(temporary_name).unlink(missing_ok=True)
            except OSError:
                pass


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    database = args.root / "data" / "app.db"
    try:
        payload = {
            "format_version": 1,
            "portable_root": str(args.root),
            "database": inspect_database(database, args.root),
        }
        write_json_atomic(args.output, payload)
    except (InspectionError, OSError) as exc:
        print(f"inspect-portable-state: error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
