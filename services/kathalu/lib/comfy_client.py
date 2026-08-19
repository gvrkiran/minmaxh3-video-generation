"""Minimal ComfyUI client: upload an image, queue a graph, wait for the output.

Shared by the cast builder and the shot renderer. Deliberately stdlib-only so it
imports into any of the venvs on this machine.
"""
from __future__ import annotations

import json
import mimetypes
import os
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
OUTPUT_ROOT = Path(os.environ.get("COMFY_OUTPUT_ROOT", r"H:\ComfyUI_Downloads\output"))
CLIENT_ID = "kathalu-studio"


def get(path: str, timeout: int = 120):
    with urllib.request.urlopen(f"{COMFY}{path}", timeout=timeout) as r:
        return json.load(r)


def post(path: str, payload: dict, timeout: int = 120):
    req = urllib.request.Request(
        f"{COMFY}{path}", data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def free_models() -> None:
    """Hand the GPU back before another stack needs it. One swap per stage, not per item."""
    try:
        post("/free", {"unload_models": True, "free_memory": True}, timeout=90)
        time.sleep(1.5)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        pass


def upload_image(local: str | Path, name: str | None = None) -> str:
    """Multipart into ComfyUI's input dir so LoadImage can see it."""
    local = Path(local)
    name = name or local.name
    boundary = f"----kathalu{uuid.uuid4().hex}"
    ctype = mimetypes.guess_type(str(local))[0] or "application/octet-stream"

    parts = []
    for field, value in (("type", "input"), ("overwrite", "true")):
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; "
            f'name="{field}"\r\n\r\n{value}\r\n'.encode()
        )
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; "
        f'name="image"; filename="{name}"\r\nContent-Type: {ctype}\r\n\r\n'.encode()
    )
    parts.append(local.read_bytes())
    parts.append(f"\r\n--{boundary}--\r\n".encode())

    req = urllib.request.Request(
        f"{COMFY}/upload/image", data=b"".join(parts),
        headers={"content-type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        got = json.load(r)
    return f"{got['subfolder']}/{got['name']}" if got.get("subfolder") else got["name"]


def run(graph: dict, label: str, budget_s: int = 2400, quiet: bool = False) -> dict:
    """Queue a graph and block until it lands. Returns {seconds, files:[...]}"""
    started = time.time()
    queued = post("/prompt", {"prompt": graph, "client_id": CLIENT_ID})
    pid = queued.get("prompt_id")
    if not pid:
        raise RuntimeError(f"ComfyUI rejected the graph: {json.dumps(queued)[:1500]}")

    while True:
        hist = get(f"/history/{pid}")
        if pid in hist:
            entry = hist[pid]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                msgs = json.dumps(status.get("messages", []))[:2500]
                raise RuntimeError(f"[{label}] failed: {msgs}")
            files = [f for out in entry.get("outputs", {}).values()
                     for f in out.get("images", []) + out.get("videos", [])]
            elapsed = time.time() - started
            if not quiet:
                names = ", ".join(f.get("filename", "?") for f in files)
                print(f"  {label:40s} {elapsed:7.1f}s  -> {names}", flush=True)
            return {"seconds": round(elapsed, 1), "files": files}
        if time.time() - started > budget_s:
            raise TimeoutError(f"[{label}] exceeded {budget_s}s")
        time.sleep(2)


def output_path(file_entry: dict) -> Path:
    sub = file_entry.get("subfolder") or ""
    return OUTPUT_ROOT / sub / file_entry["filename"]
