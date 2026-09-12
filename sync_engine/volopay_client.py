"""
Volopay Standalone API Client
-----------------------------
Provides direct, headless API access to Volopay (https://api-in.volopay.co/api/v3)
without requiring Google Chrome or active browser tabs.

Reads credentials from .env.local or .env.
"""

import os
import sys
import json
import time
import argparse
from pathlib import Path
import requests

ENV_FILE_LOCAL = Path(__file__).parent / ".env.local"
ENV_FILE = Path(__file__).parent / ".env"

def load_env():
    """Loads key-value pairs from .env.local or .env into os.environ."""
    target = ENV_FILE_LOCAL if ENV_FILE_LOCAL.exists() else ENV_FILE
    if target.exists():
        with open(target, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip("'").strip('"')
                os.environ[k] = v

load_env()

class VolopayClient:
    def __init__(self):
        load_env()
        self.access_token = os.environ.get("VOLOPAY_ACCESS_TOKEN", "").strip()
        self.client = os.environ.get("VOLOPAY_CLIENT", "").strip()
        self.uid = os.environ.get("VOLOPAY_UID", "abhishek.nitj.002@gmail.com").strip()
        self.account = os.environ.get("VOLOPAY_ACCOUNT", "iskconwhitefield").strip()
        self.base_url = os.environ.get("VOLOPAY_BASE_URL", "https://api-in.volopay.co/api/v3").rstrip("/")
        
        if not self.access_token or not self.client:
            raise ValueError(
                "Missing Volopay credentials! Please ensure VOLOPAY_ACCESS_TOKEN and VOLOPAY_CLIENT "
                "are defined in .env.local or .env."
            )
            
        self.session = requests.Session()
        self.session.headers.update({
            "access-token": self.access_token,
            "client": self.client,
            "uid": self.uid,
            "token-type": "Bearer",
            "account": self.account,
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "Origin": f"https://{self.account}.volopay.co.in",
            "Referer": f"https://{self.account}.volopay.co.in/",
            "Accept": "application/json, text/plain, */*"
        })

    def _update_tokens_if_rotated(self, response_headers):
        """Updates stored tokens if Volopay server rotates them in response headers."""
        new_token = response_headers.get("access-token")
        new_client = response_headers.get("client")
        new_expiry = response_headers.get("expiry")
        new_uid = response_headers.get("uid")

        updated = False
        if new_token and new_token != self.access_token:
            self.access_token = new_token
            os.environ["VOLOPAY_ACCESS_TOKEN"] = new_token
            updated = True
        if new_client and new_client != self.client:
            self.client = new_client
            os.environ["VOLOPAY_CLIENT"] = new_client
            updated = True
            
        if updated:
            self.session.headers.update({
                "access-token": self.access_token,
                "client": self.client
            })
            self._save_env(new_expiry)

    def _save_env(self, expiry=None):
        content = f"""# Volopay Authentication & API Configuration
VOLOPAY_ACCESS_TOKEN={self.access_token}
VOLOPAY_CLIENT={self.client}
VOLOPAY_UID={self.uid}
VOLOPAY_EXPIRY={expiry or os.environ.get('VOLOPAY_EXPIRY', '')}
VOLOPAY_ACCOUNT={self.account}
VOLOPAY_BASE_URL={self.base_url}
"""
        with open(ENV_FILE_LOCAL, "w") as f:
            f.write(content)
        with open(ENV_FILE, "w") as f:
            f.write(content)

    def request(self, method: str, endpoint: str, params=None, json_data=None, timeout=30):
        url = endpoint if endpoint.startswith("http") else f"{self.base_url}/{endpoint.lstrip('/')}"
        resp = self.session.request(method=method, url=url, params=params, json=json_data, timeout=timeout)
        self._update_tokens_if_rotated(resp.headers)
        
        if resp.status_code == 401:
            print("  🔄 401 detected: Auto-refreshing session tokens from Chrome...", flush=True)
            if sync_tokens_from_chrome():
                load_env()
                self.access_token = os.environ.get("VOLOPAY_ACCESS_TOKEN", "").strip()
                self.client = os.environ.get("VOLOPAY_CLIENT", "").strip()
                self.session.headers.update({
                    "access-token": self.access_token,
                    "client": self.client
                })
                # Retry request with fresh token
                resp = self.session.request(method=method, url=url, params=params, json=json_data, timeout=timeout)
                self._update_tokens_if_rotated(resp.headers)
                if resp.status_code == 401:
                    raise PermissionError("401 Unauthorized even after refreshing tokens from Chrome.")
            else:
                raise PermissionError(
                    "401 Unauthorized: Volopay session token has expired. "
                    "Run `python3 volopay_client.py sync` with Chrome open to refresh tokens."
                )
        resp.raise_for_status()
        return resp.json()

    def get(self, endpoint: str, params=None, timeout=30):
        return self.request("GET", endpoint, params=params, timeout=timeout)

    def post(self, endpoint: str, data=None, timeout=30):
        return self.request("POST", endpoint, json_data=data, timeout=timeout)

    # --- High-level Volopay API Methods ---

    def get_projects(self, page_limit=50):
        """Fetches all projects configured in the account (paginated)."""
        all_projects = []
        page = 1
        while True:
            res = self.get("company/projects", params={"page": page, "limit": page_limit})
            items = res.get("list", []) if isinstance(res, dict) else res
            if not items:
                break
            all_projects.extend(items)
            total = res.get("total", 0) if isinstance(res, dict) else len(items)
            if len(all_projects) >= total or len(items) < page_limit:
                break
            page += 1
        return all_projects

    def get_bills(self, page=1, limit=50, project_id=None, statuses=None, from_date=None, to_date=None):
        """Fetches purchase bills / bill-pay transactions."""
        if statuses is None:
            statuses = ["verified", "pending", "sync_in_progress", "sync_failed", "synced"]
            
        params = [
            ("page", str(page)),
            ("limit", str(limit))
        ]
        for s in statuses:
            params.append(("accounting_status[]", s))
            
        if project_id is not None:
            params.append(("project_ids[]", str(project_id)))
        if from_date:
            params.append(("from_date", from_date))
        if to_date:
            params.append(("to_date", to_date))
            
        return self.get("accounting/bill-pay", params=params)

    def get_all_bills_for_project(self, project_id, max_pages=100, page_limit=50):
        """Iterates through all pages to retrieve every bill for a specific project."""
        all_items = []
        page = 1
        while page <= max_pages:
            data = self.get_bills(page=page, limit=page_limit, project_id=project_id)
            items = data.get("list") or data.get("data") or []
            if not items:
                break
            all_items.extend(items)
            total = data.get("total", 0)
            if len(all_items) >= total or len(items) < page_limit:
                break
            page += 1
        return all_items

    def get_bill_detail(self, bill_id):
        """Fetches full details of a specific bill."""
        return self.get(f"accounting/bill-pay/{bill_id}")


def sync_tokens_from_chrome():
    """Utility function to extract fresh session tokens from open Chrome tab if ever needed."""
    import subprocess
    as_script = """
    tell application "Google Chrome"
        repeat with w in windows
            repeat with t in tabs of w
                if (URL of t) starts with "https://iskconwhitefield.volopay.co.in" then
                    return execute t javascript "JSON.stringify({
                        access_token: localStorage.getItem('access-token'),
                        client: localStorage.getItem('client'),
                        uid: localStorage.getItem('uid'),
                        expiry: localStorage.getItem('expiry')
                    })"
                end if
            end repeat
        end repeat
        return "{}"
    end tell
    """
    res = subprocess.run(["osascript", "-e", as_script], capture_output=True, text=True)
    try:
        data = json.loads(res.stdout.strip())
        if data.get("access_token") and data.get("client"):
            content = f"""# Volopay Authentication & API Configuration
VOLOPAY_ACCESS_TOKEN={data['access_token']}
VOLOPAY_CLIENT={data['client']}
VOLOPAY_UID={data.get('uid', 'abhishek.nitj.002@gmail.com')}
VOLOPAY_EXPIRY={data.get('expiry', '')}
VOLOPAY_ACCOUNT=iskconwhitefield
VOLOPAY_BASE_URL=https://api-in.volopay.co/api/v3
"""
            with open(ENV_FILE_LOCAL, "w") as f:
                f.write(content)
            with open(ENV_FILE, "w") as f:
                f.write(content)
            print("Successfully refreshed Volopay tokens from Chrome!")
            return True
        else:
            print("Could not find active Volopay session in Chrome.")
            return False
    except Exception as e:
        print(f"Error syncing tokens: {e}")
        return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Volopay Headless API Client")
    parser.add_argument("command", choices=["test", "projects", "bills", "sync"], help="Command to run")
    parser.add_argument("--project", help="Project ID for bills query", default=None)
    parser.add_argument("--limit", type=int, help="Limit number of items", default=10)
    args = parser.parse_args()

    if args.command == "sync":
        sync_tokens_from_chrome()
        sys.exit(0)

    client = VolopayClient()
    
    if args.command == "test":
        print(f"Connecting directly to {client.base_url} (No browser required)...")
        projects = client.get_projects(page_limit=5)
        print(f"Direct API Connection SUCCESSFUL!")
        print(f"Total Projects Sample: {len(projects)}")
        for p in projects[:5]:
            print(f"  • ID: {p.get('id')} | Name: {p.get('name')}")
            
    elif args.command == "projects":
        projects = client.get_projects()
        print(f"Found {len(projects)} total projects:")
        for p in projects:
            print(f"- ID: {p.get('id'):<5} | Code: {p.get('code', 'N/A'):<15} | Name: {p.get('name')}")
            
    elif args.command == "bills":
        bills = client.get_bills(page=1, limit=args.limit, project_id=args.project)
        print(f"Total matching bills: {bills.get('total')}")
        print(f"Showing first {min(args.limit, len(bills.get('list', [])))} items:")
        for b in bills.get("list", []):
            vendor = b.get("vendorName") or b.get("vendor_name") or "Unknown Vendor"
            print(f"- Invoice #{b.get('invoiceNumber', 'N/A')} | Vendor: {vendor:<30} | Amount: ₹{b.get('grossTotal', 0):,.2f} | Status: {b.get('accountingStatus')}")
