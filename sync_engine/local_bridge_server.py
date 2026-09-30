#!/usr/bin/env python3
"""
Local Background Bridge Server for MIS Volopay Dashboard
--------------------------------------------------------
Runs silently in the background on http://127.0.0.1:8765 via com.iskcon.volopay.sync.plist.
Allows the web dashboard (mis-expenses-dashboard.zoom-attendance-live.workers.dev)
to trigger:
1. Fresh Chrome session token capture with 0 user clicks.
2. Full automated end-to-end sync (Volopay -> Google Sheets -> Cloudflare D1).
"""

import sys
import os
import json
import time
import threading
from datetime import datetime
from urllib.parse import urlparse, parse_qs
from http.server import HTTPServer, BaseHTTPRequestHandler

# Ensure current script directory is in Python path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from volopay_client import sync_tokens_from_chrome
import sync_to_mis_automatic

PORT = 8765

sync_lock = threading.Lock()
sync_state = {
    "is_syncing": False,
    "last_sync_time": None,
    "last_duration_sec": None,
    "last_result": None,
    "last_error": None
}


class BridgeHandler(BaseHTTPRequestHandler):
    def _set_cors_headers(self):
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin, Access-Control-Request-Private-Network")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self):
        self.send_response(204)
        self._set_cors_headers()
        self.end_headers()

    def _send_json(self, status_code, data):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self._set_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data, default=str).encode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path in ["", "/health", "/status"]:
            self._send_json(200, {
                "ok": True,
                "service": "MIS Volopay Local Bridge",
                "port": PORT,
                "version": "2.0",
                "is_syncing": sync_state["is_syncing"],
                "last_sync_time": sync_state["last_sync_time"],
                "last_duration_sec": sync_state["last_duration_sec"],
                "last_summary": (sync_state["last_result"] or {}).get("summary") if isinstance(sync_state["last_result"], dict) else None
            })
        elif path == "/sync-status":
            self._send_json(200, {
                "ok": True,
                **sync_state
            })
        else:
            self._send_json(404, {"ok": False, "error": f"Endpoint {path} not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        query = parse_qs(parsed.query)

        # Parse JSON body if present
        body_data = {}
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 0:
            try:
                body_raw = self.rfile.read(content_length)
                body_data = json.loads(body_raw.decode("utf-8"))
            except:
                pass

        if path in ["/sync-tokens", "/api/sync-tokens"]:
            try:
                success = sync_tokens_from_chrome()
                self._send_json(200 if success else 400, {
                    "ok": success,
                    "message": "Fresh Volopay tokens captured from Chrome and sent to Cloudflare" if success else "Could not extract tokens. Ensure Volopay is open in Chrome."
                })
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})

        elif path in ["/trigger-full-sync", "/trigger-sync", "/api/trigger-sync"]:
            # Query & Body parameters
            full_scan = (query.get("full", ["false"])[0].lower() == "true") or bool(body_data.get("full", False))
            
            # trigger_d1 defaults to True unless caller explicitly sets trigger_d1=false
            trigger_d1_param = query.get("trigger_d1", [str(body_data.get("trigger_d1", "true"))])[0].lower()
            trigger_d1 = (trigger_d1_param != "false")

            force_write = (query.get("force_write", ["false"])[0].lower() == "true") or bool(body_data.get("force_write", False))

            if not sync_lock.acquire(blocking=False):
                self._send_json(200, {
                    "ok": True,
                    "in_progress": True,
                    "message": "A sync is already actively running in the background.",
                    "status": sync_state
                })
                return

            t_start = time.time()
            sync_state["is_syncing"] = True
            sync_state["last_error"] = None
            try:
                print(f"\n[Bridge] 🚀 Triggering sync (full_scan={full_scan}, trigger_d1={trigger_d1})...", flush=True)
                # Auto-sync tokens first
                try:
                    sync_tokens_from_chrome()
                except Exception as t_err:
                    print(f"[Bridge] Token extraction note: {t_err}", flush=True)

                res = sync_to_mis_automatic.run_sync(
                    full_scan=full_scan,
                    trigger_d1=trigger_d1,
                    force_sheets_write=force_write
                )

                duration = round(time.time() - t_start, 1)
                sync_state["last_sync_time"] = datetime.now().isoformat()
                sync_state["last_duration_sec"] = duration
                sync_state["last_result"] = res

                if isinstance(res, dict):
                    self._send_json(200, res)
                else:
                    self._send_json(200, {
                        "ok": bool(res),
                        "duration_sec": duration,
                        "summary": "Sync finished successfully" if res else "Sync encountered errors"
                    })
            except Exception as e:
                err_str = str(e)
                print(f"[Bridge] ❌ Sync error: {err_str}", flush=True)
                sync_state["last_error"] = err_str
                self._send_json(500, {"ok": False, "error": err_str})
            finally:
                sync_state["is_syncing"] = False
                sync_lock.release()

        else:
            self._send_json(404, {"ok": False, "error": f"Path {path} not found"})

    def log_message(self, format, *args):
        # Clean logs to stdout
        print(f"[Bridge HTTP] {self.command} {self.path} - {format % args}", flush=True)


def run():
    server_address = ("127.0.0.1", PORT)
    httpd = HTTPServer(server_address, BridgeHandler)
    print(f"🚀 MIS Volopay Local Bridge listening on http://127.0.0.1:{PORT}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping bridge server...", flush=True)
        httpd.server_close()


if __name__ == "__main__":
    run()
