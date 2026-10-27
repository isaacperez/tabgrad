"""Project selected TOML fields; this parser does not admit a running server."""

import json
import sys
import tomllib


def main() -> None:
    """Read bounded UTF-8 TOML from stdin and emit only the inspected fields."""
    if len(sys.argv) != 3:
        raise ValueError("LAB_INPUT")
    if (
        sys.version_info[:2] != (3, 11)
        or sys.prefix == sys.base_prefix
        or sys.prefix != sys.argv[2]
    ):
        raise ValueError("LAB_TOOL")
    limit = int(sys.argv[1])
    if limit <= 0 or limit > sys.maxsize - 1:
        raise ValueError("LAB_LIMIT")
    raw = sys.stdin.buffer.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("LAB_LIMIT")
    document = tomllib.loads(raw.decode("utf-8"))
    result: dict[str, object] = {}
    for key in ("version", "root", "state", "imports", "disabled_plugins"):
        value: object = document.get(key)
        result[key] = value
    for key in ("grpc", "debug", "ttrpc", "metrics", "proxy_plugins"):
        table: object = document.get(key)
        if not isinstance(table, dict):
            result[key] = None
            continue
        result[key] = table
    sys.stdout.write(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, tomllib.TOMLDecodeError):
        # Original input stays in the caller's protected file; never print it.
        sys.stderr.write("LAB_PROTOCOL\n")
        raise SystemExit(1) from None
