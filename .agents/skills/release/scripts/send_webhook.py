#!/usr/bin/env python3
"""Send one release notification using initialized Webhook configuration."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


PROVIDERS = {"generic", "slack", "discord", "feishu", "dingtalk"}
STATUSES = ("published", "failed", "partial")
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send a configured release Webhook.")
    parser.add_argument("--config", type=Path, default=Path(".release-webhook.json"))
    parser.add_argument("--repository", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--status", choices=STATUSES, default="published")
    parser.add_argument("--tag")
    parser.add_argument("--release-url")
    parser.add_argument("--summary")
    parser.add_argument("--event-id")
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def load_config(path: Path) -> dict[str, Any]:
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Cannot read Webhook config: {error}") from error
    required = {"version", "provider", "url_env", "failure_policy", "allow_http"}
    if set(config) != required or config["version"] != 1:
        raise ValueError("Unsupported Webhook config schema.")
    if config["provider"] not in PROVIDERS:
        raise ValueError("Unsupported Webhook provider.")
    if config["failure_policy"] not in {"best-effort", "blocking"}:
        raise ValueError("Unsupported Webhook failure policy.")
    if not isinstance(config["url_env"], str) or not ENV_NAME.fullmatch(config["url_env"]):
        raise ValueError("Webhook url_env is invalid.")
    if not isinstance(config["allow_http"], bool):
        raise ValueError("Webhook allow_http is invalid.")
    return config


def release_data(args: argparse.Namespace, event_id: str) -> dict[str, str]:
    values = {
        "event": f"release.{args.status}",
        "event_id": event_id,
        "repository": args.repository,
        "version": args.version,
        "status": args.status,
        "tag": args.tag or "",
        "release_url": args.release_url or "",
        "summary": args.summary or "",
    }
    return {key: value for key, value in values.items() if value}


def payload(provider: str, data: dict[str, str]) -> dict[str, Any]:
    message = f"Release {data['repository']} {data['version']}: {data['status']}"
    if data.get("release_url"):
        message += f"\n{data['release_url']}"
    if data.get("summary"):
        message += f"\n{data['summary']}"
    if provider == "generic":
        return data
    if provider == "slack":
        return {"text": message}
    if provider == "discord":
        return {"content": message}
    if provider == "feishu":
        return {"msg_type": "text", "content": {"text": message}}
    return {"msgtype": "text", "text": {"content": message}}


def validate_url(url: str, allow_http: bool) -> None:
    parsed = urllib.parse.urlsplit(url)
    allowed = {"https"} | ({"http"} if allow_http else set())
    if parsed.scheme not in allowed or not parsed.netloc or parsed.username or parsed.password:
        expected = "HTTP(S)" if allow_http else "HTTPS"
        raise ValueError(f"Webhook URL must be an absolute {expected} URL without credentials.")


def main() -> int:
    args = parse_args()
    try:
        config = load_config(args.config)
        event_id = args.event_id or hashlib.sha256(
            "\0".join(
                (args.repository, args.version, args.status, args.tag or "")
            ).encode("utf-8")
        ).hexdigest()[:24]
        body = payload(config["provider"], release_data(args, event_id))
        encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

        if args.dry_run:
            print(json.dumps(body, indent=2, ensure_ascii=False))
            print(f"provider={config['provider']} event_id={event_id}", file=sys.stderr)
            return 0

        url = os.environ.get(config["url_env"], "")
        if not url:
            raise ValueError(f"Required secret environment variable {config['url_env']} is unset.")
        validate_url(url, config["allow_http"])
        request = urllib.request.Request(
            url,
            data=encoded,
            method="POST",
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "User-Agent": "release-skill-webhook/1",
                "X-Release-Event-ID": event_id,
            },
        )
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            status = response.status
        if not 200 <= status < 300:
            raise ValueError(f"Webhook returned HTTP {status}.")
        print(
            f"Webhook delivered: provider={config['provider']} event_id={event_id} status={status}"
        )
        return 0
    except urllib.error.HTTPError as error:
        print(f"Webhook delivery failed: HTTP {error.code}.", file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        reason_type = type(error.reason).__name__
        print(f"Webhook delivery failed: network error ({reason_type}).", file=sys.stderr)
        return 1
    except TimeoutError:
        print("Webhook delivery failed: request timed out.", file=sys.stderr)
        return 1
    except ValueError as error:
        print(f"Webhook delivery failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
