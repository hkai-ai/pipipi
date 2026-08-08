#!/usr/bin/env python3
"""Initialize non-secret release Webhook configuration."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


PROVIDERS = ("generic", "slack", "discord", "feishu", "dingtalk")
FAILURE_POLICIES = ("best-effort", "blocking")
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def repository_root(start: Path) -> Path:
    result = subprocess.run(
        ["git", "-C", str(start), "rev-parse", "--show-toplevel"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return Path(result.stdout.strip()).resolve()
    return start.resolve()


def choose(label: str, values: tuple[str, ...], default: str) -> str:
    print(label)
    for index, value in enumerate(values, start=1):
        suffix = " (default)" if value == default else ""
        print(f"  {index}. {value}{suffix}")
    while True:
        answer = input(f"Choose [default: {default}]: ").strip()
        if not answer:
            return default
        if answer in values:
            return answer
        if answer.isdigit() and 1 <= int(answer) <= len(values):
            return values[int(answer) - 1]
        print("Invalid choice; enter a number or value.", file=sys.stderr)


def confirm(prompt: str, default: bool) -> bool:
    hint = "Y/n" if default else "y/N"
    answer = input(f"{prompt} [{hint}]: ").strip().lower()
    if not answer:
        return default
    return answer in {"y", "yes"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create a repository Webhook config without storing the secret URL. "
            "Run without flags for an interactive setup."
        )
    )
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--config", type=Path, default=Path(".release-webhook.json"))
    parser.add_argument("--provider", choices=PROVIDERS)
    parser.add_argument("--url-env", default="RELEASE_WEBHOOK_URL")
    parser.add_argument("--failure-policy", choices=FAILURE_POLICIES)
    parser.add_argument("--allow-http", action="store_true")
    parser.add_argument("--non-interactive", action="store_true")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = repository_root(args.repo)
    config_path = args.config if args.config.is_absolute() else root / args.config

    try:
        config_path.resolve().relative_to(root)
    except ValueError:
        print("Config must be inside the repository.", file=sys.stderr)
        return 1

    interactive = not args.non_interactive and sys.stdin.isatty()
    if config_path.exists() and not args.force:
        if not interactive or not confirm(f"{config_path} exists. Replace it?", False):
            print("Existing config preserved. Use --force to replace it.", file=sys.stderr)
            return 1

    if interactive and not config_path.exists():
        if not confirm("No release Webhook is configured. Configure one now?", True):
            print("Webhook setup skipped; release notifications remain disabled.")
            return 2

    provider = args.provider
    if provider is None:
        if not interactive:
            print("--provider is required with --non-interactive.", file=sys.stderr)
            return 1
        provider = choose("Webhook provider:", PROVIDERS, "generic")

    failure_policy = args.failure_policy
    if failure_policy is None:
        failure_policy = (
            choose("Failure policy:", FAILURE_POLICIES, "best-effort")
            if interactive
            else "best-effort"
        )

    url_env = args.url_env
    if interactive:
        answer = input(f"Secret URL environment variable [default: {url_env}]: ").strip()
        if answer:
            url_env = answer
    if not ENV_NAME.fullmatch(url_env):
        print("--url-env must be a valid environment variable name.", file=sys.stderr)
        return 1

    config = {
        "version": 1,
        "provider": provider,
        "url_env": url_env,
        "failure_policy": failure_policy,
        "allow_http": bool(args.allow_http),
    }
    config_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=config_path.parent, delete=False
    ) as handle:
        json.dump(config, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        temporary_path = Path(handle.name)
    os.replace(temporary_path, config_path)

    relative = config_path.relative_to(root)
    print(f"Created {relative} for provider={provider}, policy={failure_policy}.")
    print(f"Store the secret URL in {url_env} via the environment or a secret manager.")
    print("The URL was not requested or written to disk.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
