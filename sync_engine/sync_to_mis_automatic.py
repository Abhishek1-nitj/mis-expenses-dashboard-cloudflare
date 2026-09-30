"""
Automatic Volopay to Google Sheets Sync Engine (with Incremental Delta Sync)
-----------------------------------------------------------------------------
Target Sheet: MIS just expenses Volopay automatic (1vPEODBdDdrEjfbTk7lGQqwgVHB7ILf39nlPw_QvBl9o)
Cutoff Date: 01-Jan-2025
Tabs Synced:
1. Claims (accounting/reimbursements)
2. Expenses (accounting/expenses)
3. Purchase Bills (accounting/bill-pay)
4. Payrolls (accounting/payrolls)
5. Project Classification (Master Classification matrix)

Supports two sync modes:
- Delta / Incremental Sync (Default, ~5-10s): Fetches only latest pages + 60-day rolling lookback for status changes.
- Full Sync (--full, ~45s): Exhaustively re-scans all pages from 01-Jan-2025.
"""

import os
import sys
import json
import time
import argparse
from datetime import datetime, timedelta
from pathlib import Path
import gspread
import requests
from google.oauth2.service_account import Credentials
from volopay_client import VolopayClient, sync_tokens_from_chrome

TARGET_SPREADSHEET_ID = "1vPEODBdDdrEjfbTk7lGQqwgVHB7ILf39nlPw_QvBl9o"
REFERENCE_SPREADSHEET_ID = "1Me9loF1LmHtVmJBwtfcGcU3cLb_Nhz4pezxp09q3_gY"
SERVICE_ACCOUNT_PATH = Path(__file__).parent / "Google Sheet jason" / "google-sheets.service-account.json"
CACHE_DIR = Path(__file__).parent / "sync_cache"
CACHE_DIR.mkdir(exist_ok=True)

CUTOFF_DATE_STR = "2025-01-01"
CUTOFF_DATE = datetime.strptime(CUTOFF_DATE_STR, "%Y-%m-%d")

CLAIMS_HEADERS = [
    "Created at", "Transaction/travel date", "Settlement date", "Reimbursement type",
    "Claim owner", "Claim owner email", "Linked to", "Merchant", "Claim amount",
    "Claim currency", "Volopay category", "Transaction status", "Sent amount",
    "Sent currency", "Total amount", "Total fee", "Exchange rate", "Received amount",
    "Received currency", "Remarks", "Receipts", "Approval date", "Tally category", "Tally tax codes"
]

EXPENSES_HEADERS = [
    "Owner name", "Owner email", "Linked to", "Payment type", "Merchant", "Provider merchant",
    "Total amount", "Line amount", "Currency", "Txn date", "Ledger date", "Transaction",
    "Parent transaction", "Status", "Gst applied", "Note", "Transaction currency code",
    "Fx rate", "Sub category name", "Tally category", "Tally tax codes", "Receipts", "Date"
]

PURCHASE_BILLS_HEADERS = [
    "Owner name", "Owner email", "Linked to", "Payment type", "Vendor", "Invoice number",
    "Invoice date", "Due date", "Transaction date", "Invoice subtotal", "Total tax",
    "Invoice total", "Total tds", "Invoice payable amount", "Exchange rate", "Received amount",
    "Received currency", "Line item description", "Line amount", "Line item tax amount",
    "Line item total", "Bill description", "Tally category", "Tally tax codes", "Receipts"
]

PAYROLLS_HEADERS = [
    "Employee id", "Employee name", "Employee email", "Payment type", "Transaction date",
    "Total", "Received amount", "Received currency", "Exchange rate", "Memo", "Description",
    "Tally category", "Tally tax codes", "Projects for payroll"
]


def to_str(val):
    if val is None:
        return ""
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, dict):
        return str(val.get("name") or val.get("value") or val.get("title") or val.get("id") or "")
    if isinstance(val, list):
        return ", ".join(to_str(x) for x in val if x)
    return str(val).strip()


def parse_date(d_str):
    if not d_str:
        return None
    d_str = str(d_str).strip()
    for fmt in [
        "%Y-%m-%d", "%d-%b-%Y", "%d %b %Y", "%Y-%m-%dT%H:%M:%S.%fZ",
        "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y"
    ]:
        try:
            return datetime.strptime(d_str.split("T")[0] if "T" in d_str and fmt == "%Y-%m-%d" else d_str, fmt)
        except:
            continue
    return None

def format_date_display(d_str, target_fmt="%d %b %Y"):
    dt = parse_date(d_str)
    return dt.strftime(target_fmt) if dt else to_str(d_str)

def format_date_dash(d_str):
    dt = parse_date(d_str)
    return dt.strftime("%d-%b-%Y") if dt else to_str(d_str)


def get_gspread_client():
    scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
    creds = Credentials.from_service_account_file(str(SERVICE_ACCOUNT_PATH), scopes=scopes)
    return gspread.authorize(creds)


def update_sheet_tab(sh, title, rows, max_retries=5):
    print(f"Syncing tab [{title}] with {len(rows)} rows...", flush=True)
    existing = {ws.title: ws for ws in sh.worksheets()}
    
    clean_rows = []
    for r in rows:
        clean_rows.append([to_str(c) for c in r])
        
    num_rows = max(len(clean_rows) + 50, 100)
    num_cols = max(len(clean_rows[0]) + 2, 26)

    if title in existing:
        ws = existing[title]
        try:
            ws.resize(rows=num_rows, cols=num_cols)
        except Exception as e:
            pass
    else:
        ws = sh.add_worksheet(title=title, rows=num_rows, cols=num_cols)

    for attempt in range(1, max_retries + 1):
        try:
            ws.clear()
            chunk_size = 1000
            for i in range(0, len(clean_rows), chunk_size):
                chunk = clean_rows[i:i + chunk_size]
                start_row = i + 1
                end_row = i + len(chunk)
                cols_count = len(chunk[0])
                if cols_count <= 26:
                    end_col = chr(ord('A') + cols_count - 1)
                else:
                    end_col = f"A{chr(ord('A') + cols_count - 27)}"
                range_str = f"A{start_row}:{end_col}{end_row}"
                ws.update(range_name=range_str, values=chunk)
                time.sleep(0.3)
            print(f"✅ Successfully updated tab: [{title}] ({len(clean_rows)-1} data rows)", flush=True)
            return True
        except Exception as e:
            if "429" in str(e) or "Quota exceeded" in str(e):
                wait_time = 15 * attempt
                print(f"⚠️ Rate limit on [{title}]. Retrying in {wait_time}s...", flush=True)
                time.sleep(wait_time)
            elif "exceeds grid limits" in str(e):
                ws.resize(rows=len(clean_rows) + 200, cols=num_cols)
                time.sleep(1)
            else:
                print(f"❌ Error updating [{title}]: {e}", flush=True)
                time.sleep(3)
    return False


def get_record_id(item):
    return str(item.get("id") or item.get("_id") or item.get("accountingId") or item.get("transactionNumber") or "")


def fetch_delta_smart(client, endpoint, cache_name, full_scan=False, limit=100, rolling_lookback_days=60):
    """
    Incremental (Delta) Fetcher:
    - Loads local cache as baseline.
    - Scans recent pages (Page 1, 2, 3...) sorted by latest.
    - Updates existing records in-place if status/amounts changed (UPSERT).
    - Appends brand new records.
    - Stops pagination early as soon as an entire page matches known settled records.
    - Checks 60-day rolling lookback for non-settled records to catch late approvals/settlements.
    """
    cache_file = CACHE_DIR / f"{cache_name}.json"
    cached_list = []
    if cache_file.exists():
        try:
            with open(cache_file, "r") as f:
                cached_list = json.load(f)
        except:
            cached_list = []

    id_to_item = {get_record_id(it): it for it in cached_list if get_record_id(it)}
    
    if client is None:
        print(f"  ⚡ Using cached baseline for {cache_name} ({len(id_to_item)} items)...", flush=True)
        return list(id_to_item.values()), True, {"new": 0, "updated": 0, "total": len(id_to_item)}

    if full_scan or len(cached_list) == 0:
        print(f"  🔄 Running Full Scan for {cache_name} from {CUTOFF_DATE_STR}...", flush=True)
        items = fetch_all_paginated(client, endpoint, cache_name, {"from_date": CUTOFF_DATE_STR}, limit=limit)
        return items, True, {"new": len(items), "updated": 0, "total": len(items)}

    print(f"  ⚡ Running Fast Delta Scan for {cache_name} (baseline: {len(id_to_item)} items)...", flush=True)
    
    page = 1
    new_count = 0
    updated_count = 0
    max_delta_pages = 5  # Scan up to 500 latest items

    while page <= max_delta_pages:
        params = {"page": page, "limit": limit}
        try:
            res = client.get(endpoint, params=params, timeout=30)
            items = res.get("list") or res.get("data") or []
            if not items:
                break
                
            page_all_existing_and_settled = True
            
            for item in items:
                rec_id = get_record_id(item)
                if not rec_id:
                    continue
                    
                if rec_id not in id_to_item:
                    id_to_item[rec_id] = item
                    new_count += 1
                    page_all_existing_and_settled = False
                else:
                    existing = id_to_item[rec_id]
                    # Check for status/amount changes
                    old_status = existing.get("status") or existing.get("accountingStatus") or existing.get("transactionStatus")
                    new_status = item.get("status") or item.get("accountingStatus") or item.get("transactionStatus")
                    old_amt = str(existing.get("amountToBePaid") or existing.get("amount") or "")
                    new_amt = str(item.get("amountToBePaid") or item.get("amount") or "")
                    
                    if old_status != new_status or old_amt != new_amt:
                        id_to_item[rec_id] = item
                        updated_count += 1
                        page_all_existing_and_settled = False
                    else:
                        # Item already matches
                        is_settled = (
                            new_status in ["paid", "settled", "paid_outside_volopay", "synced", "verified", "approved", "completed"] or
                            str(item.get("settlementStatus") or "").lower() in ["settled", "paid"] or
                            str(item.get("transactionStatus") or "").lower() in ["paid", "settled", "paid_outside_volopay", "approved", "completed"]
                        )
                        if not is_settled:
                            page_all_existing_and_settled = False

            if page_all_existing_and_settled:
                print(f"  ✓ Reached settled boundary at page {page}. Stopping delta scan early.", flush=True)
                break
                
            page += 1
            time.sleep(0.2)
        except Exception as e:
            print(f"  ⚠️ Delta scan page {page} warning: {e}", flush=True)
            break

    # Lookback scan for recently active pending items (only if recent changes or pending items were found)
    if (not page_all_existing_and_settled) or new_count > 0 or updated_count > 0:
        lookback_date = (datetime.now() - timedelta(days=rolling_lookback_days)).strftime("%Y-%m-%d")
        try:
            res = client.get(endpoint, params={"page": 1, "limit": 100, "from_date": lookback_date}, timeout=15)
            recent_items = res.get("list") or res.get("data") or []
            for item in recent_items:
                rec_id = get_record_id(item)
                if not rec_id:
                    continue
                if rec_id not in id_to_item:
                    id_to_item[rec_id] = item
                    new_count += 1
                else:
                    existing = id_to_item[rec_id]
                    old_status = existing.get("status") or existing.get("accountingStatus") or existing.get("transactionStatus")
                    new_status = item.get("status") or item.get("accountingStatus") or item.get("transactionStatus")
                    if old_status != new_status:
                        id_to_item[rec_id] = item
                        updated_count += 1
        except Exception as e:
            pass

    merged_list = list(id_to_item.values())
    has_changes = (new_count > 0 or updated_count > 0)
    stats = {"new": new_count, "updated": updated_count, "total": len(merged_list)}
    print(f"  ✓ Delta results for {cache_name}: {new_count} new, {updated_count} updated. Total: {len(merged_list)} items.", flush=True)

    if has_changes or not cache_file.exists():
        with open(cache_file, "w") as f:
            json.dump(merged_list, f)

    return merged_list, has_changes, stats


def fetch_all_paginated(client, endpoint, cache_name, params_extra=None, limit=100, max_retries=3):
    cache_file = CACHE_DIR / f"{cache_name}.json"
    all_items = []
    page = 1
    params = {"page": page, "limit": limit}
    if params_extra:
        params.update(params_extra)
        
    while True:
        params["page"] = page
        success = False
        for attempt in range(1, max_retries + 1):
            try:
                res = client.get(endpoint, params=params, timeout=40)
                items = res.get("list") or res.get("data") or []
                all_items.extend(items)
                total = res.get("total", 0)
                print(f"  Fetched page {page} ({len(all_items)}/{total} items from {endpoint})", flush=True)
                if len(all_items) >= total or len(items) < limit:
                    with open(cache_file, "w") as f:
                        json.dump(all_items, f)
                    return all_items
                page += 1
                success = True
                time.sleep(0.2)
                break
            except Exception as e:
                print(f"⚠️ Attempt {attempt}/{max_retries} error on {endpoint} page {page}: {e}")
                time.sleep(2 * attempt)
        if not success:
            break
            
    with open(cache_file, "w") as f:
        json.dump(all_items, f)
    return all_items


def process_claims(client, full_scan=False):
    print("\n--- Processing Claims ---", flush=True)
    raw_claims, has_changes, stats = fetch_delta_smart(client, "accounting/reimbursements", "claims_cache", full_scan=full_scan)
    rows = [CLAIMS_HEADERS]
    
    for c in raw_claims:
        created_at = format_date_display(c.get("created_at") or c.get("createdAt") or c.get("transactionDate"))
        txn_date = format_date_dash(c.get("transactionDate") or c.get("travelDate"))
        settle_date = format_date_display(c.get("settlementDate") or c.get("settledAt"))
        rtype = to_str(c.get("type", "out_of_pocket"))
        owner_obj = c.get("createdBy") or c.get("user") or {}
        owner_name = to_str((owner_obj.get("displayName") or owner_obj.get("name")) if isinstance(owner_obj, dict) else c.get("claimOwner"))
        owner_email = to_str(owner_obj.get("email") if isinstance(owner_obj, dict) else c.get("claimOwnerEmail"))
        
        linked = c.get("linkedTo") or ""
        if isinstance(linked, dict):
            linked = linked.get("name") or linked.get("project_name") or ""
            
        merchant = to_str(c.get("merchant"))
        
        amt_val = c.get("amountToBePaid") or (c.get("amount", {}).get("value") if isinstance(c.get("amount"), dict) else c.get("amount"))
        claim_amt = to_str(amt_val)
        curr = to_str(c.get("amount", {}).get("currency") if isinstance(c.get("amount"), dict) else "INR")
        volo_cat = to_str(c.get("accountingVendorName") or c.get("category") or "Other")
        status = to_str(c.get("status") or c.get("accountingStatus"))
        sent_amt = claim_amt
        sent_curr = curr
        remarks = to_str(c.get("memo") or c.get("accountingMemo"))
        
        receipts = c.get("accountingReceipts") or []
        receipt_urls = []
        if isinstance(receipts, list):
            for r in receipts:
                url = r.get("url") if isinstance(r, dict) else to_str(r)
                if url:
                    receipt_urls.append(url)
        receipt_str = ", ".join(receipt_urls)
        
        approval_date = format_date_display(c.get("approvalDate") or c.get("approvedAt"))
        tally_cat = ""
        for tag in (c.get("accountingTags") or []):
            tval = tag.get("tagValue") or tag.get("customTextValue") or ""
            if tval:
                tally_cat = to_str(tval)
                break
                
        tally_tax = ""
        
        rows.append([
            created_at, txn_date, settle_date, rtype, owner_name, owner_email,
            to_str(linked), merchant, claim_amt, curr, volo_cat, status, sent_amt,
            sent_curr, "", "", "", "", "", remarks, receipt_str, approval_date,
            tally_cat, tally_tax
        ])
    return rows, has_changes, stats


def process_expenses(client, full_scan=False):
    print("\n--- Processing Expenses ---", flush=True)
    raw_exp, has_changes, stats = fetch_delta_smart(client, "accounting/expenses", "expenses_cache", full_scan=full_scan)
    rows = [EXPENSES_HEADERS]
    
    for e in raw_exp:
        card_holder = e.get("cardHolder") or {}
        owner_name = to_str((card_holder.get("displayName") or card_holder.get("name")) if isinstance(card_holder, dict) else "")
        owner_email = to_str(card_holder.get("email") if isinstance(card_holder, dict) else "")
        
        # Resolve real project / department name
        proj_obj = e.get("project") or {}
        dept_obj = e.get("department") or {}
        if isinstance(proj_obj, dict) and proj_obj.get("name"):
            linked = proj_obj.get("name")
        elif isinstance(dept_obj, dict) and dept_obj.get("name"):
            linked = dept_obj.get("name")
        elif isinstance(e.get("linkedTo"), dict):
            linked = e["linkedTo"].get("name") or e["linkedTo"].get("project_name") or ""
        else:
            linked = to_str(e.get("linkedTo"))
            
        ptype = "Card Expense" if not e.get("expenseViaUpi") else "UPI"
        merchant = to_str(e.get("merchant"))
        p_merchant = to_str(e.get("accountingVendorName") or merchant)
        
        amt_obj = e.get("amount") or {}
        if isinstance(amt_obj, dict):
            tot_amt = to_str(amt_obj.get("value"))
            curr = to_str(amt_obj.get("currency") or "INR")
        else:
            tot_amt = to_str(amt_obj)
            curr = "INR"
        
        txn_date = format_date_dash(e.get("transactionDate") or e.get("accountingDate"))
        ledger_date = format_date_display(e.get("accountingDate") or e.get("transactionDate"), "%Y-%m-%d")
        txn_id = to_str(e.get("accountingId") or e.get("id"))
        parent_id = ""
        status = to_str(e.get("accountingStatus") or e.get("transactionStatus"))
        gst = "Yes" if e.get("gstApplied") else ""
        note = to_str(e.get("memo"))
        fx = "1"
        sub_cat = ""
        
        tally_cat = ""
        for tag in (e.get("accountingTags") or []):
            tval = tag.get("tagValue") or tag.get("customTextValue") or ""
            if tval:
                tally_cat = to_str(tval)
                break
        tally_tax = ""
        receipts = ""
        
        rows.append([
            owner_name, owner_email, to_str(linked), ptype, merchant, p_merchant,
            tot_amt, tot_amt, curr, txn_date, ledger_date, txn_id, parent_id,
            status, gst, note, curr, fx, sub_cat, tally_cat, tally_tax, receipts, ""
        ])
    return rows, has_changes, stats


def process_purchase_bills(client, full_scan=False):
    print("\n--- Processing Purchase Bills ---", flush=True)
    raw_bills, has_changes, stats = fetch_delta_smart(client, "accounting/bill-pay", "bills_cache", full_scan=full_scan)
    rows = [PURCHASE_BILLS_HEADERS]
    
    for b in raw_bills:
        user_obj = b.get("user") or b.get("vendorOwner") or {}
        owner_name = to_str((user_obj.get("displayName") or user_obj.get("name")) if isinstance(user_obj, dict) else "")
        v_owner = b.get("vendorOwner") or {}
        owner_email = to_str(user_obj.get("email") if (isinstance(user_obj, dict) and user_obj.get("email")) else (v_owner.get("email") if isinstance(v_owner, dict) else ""))
        
        linked = b.get("linkedTo") or ""
        if isinstance(linked, dict):
            linked = linked.get("name") or linked.get("project_name") or ""
            
        ptype = "PurchaseBill"
        vendor_obj = b.get("vendor") or {}
        vendor_name = to_str(vendor_obj.get("name") if isinstance(vendor_obj, dict) else (b.get("accountingVendorName") or ""))
        inv_no = to_str(b.get("invoiceNumber"))
        
        inv_date = format_date_dash(b.get("invoiceDate"))
        due_date = format_date_display(b.get("dueDate"))
        txn_date = format_date_display(b.get("transactionDate") or b.get("paymentDate"), "%Y-%m-%d")
        
        subtotal = 0.0
        tax = 0.0
        line_desc = ""
        line_items = b.get("lineItems") or []
        if line_items:
            for li in line_items:
                amt = li.get("amount") or {}
                subtotal += float(amt.get("value") or 0.0) if isinstance(amt, dict) else float(amt or 0.0)
                for t in (li.get("taxes") or []):
                    tamt = t.get("amount") or {}
                    tax += float(tamt.get("value") or 0.0) if isinstance(tamt, dict) else float(tamt or 0.0)
                if not line_desc and li.get("description"):
                    line_desc = to_str(li.get("description"))
        else:
            amt = b.get("amount") or {}
            subtotal = float(amt.get("value") or 0.0) if isinstance(amt, dict) else float(amt or 0.0)
            
        inv_total = subtotal + tax
        net_payable = float(b.get("amountToBePaid") or (b.get("quote") or {}).get("totalAmount", {}).get("value") or inv_total)
        tds = max(0.0, round(inv_total - net_payable, 2))
        
        quote = b.get("quote") or {}
        fx = to_str(quote.get("exchangeRate") or "1.0")
        curr_obj = b.get("amount") or {}
        recv_curr = to_str(curr_obj.get("currency") if isinstance(curr_obj, dict) else "INR")
        bill_desc = to_str(b.get("note") or line_desc)
        
        tally_cat = ""
        for tag in (b.get("customTags") or []):
            tval = tag.get("tagValue") or tag.get("customTextValue") or ""
            if tval:
                tally_cat = to_str(tval)
                break
        tally_tax = ""
        receipts = ""
        
        rows.append([
            owner_name, owner_email, to_str(linked), ptype, vendor_name, inv_no,
            inv_date, due_date, txn_date, str(subtotal), str(tax), str(inv_total),
            str(tds), str(net_payable), fx, str(net_payable), recv_curr,
            line_desc, str(subtotal), str(tax), str(inv_total), bill_desc,
            tally_cat, tally_tax, receipts
        ])
    return rows, has_changes, stats


def process_payrolls(client, full_scan=False):
    print("\n--- Processing Payrolls ---", flush=True)
    raw_payrolls, has_changes, stats = fetch_delta_smart(client, "accounting/payrolls", "payrolls_cache", full_scan=full_scan)
    rows = [PAYROLLS_HEADERS]
    
    for p in raw_payrolls:
        vendor = p.get("vendor") or {}
        user = p.get("user") or {}
        vo = p.get("vendorOwner") or {}
        
        emp_id = to_str(vendor.get("employeeId") or p.get("accountingId") or p.get("id"))
        emp_name = to_str(
            vendor.get("name")
            or (user.get("displayName") if isinstance(user, dict) else "")
            or (user.get("name") if isinstance(user, dict) else "")
            or (vo.get("name") if isinstance(vo, dict) else "")
            or p.get("accountingVendorName")
            or ""
        )
        emp_email = to_str(
            vendor.get("email")
            or (user.get("email") if isinstance(user, dict) else "")
            or ""
        )
        ptype = "Payroll"
        txn_date = format_date_dash(p.get("transactionDate") or p.get("paymentDate"))
        
        amt_obj = p.get("amount") or {}
        if isinstance(amt_obj, dict):
            tot_amt = to_str(amt_obj.get("value"))
            curr = to_str(amt_obj.get("currency") or "INR")
        else:
            tot_amt = to_str(amt_obj)
            curr = "INR"
            
        fx = "1.0"
        memo = to_str(p.get("note"))
        desc = memo
        
        tally_cat = ""
        for tag in (p.get("accountingTags") or []):
            tval = tag.get("tagValue") or tag.get("customTextValue") or ""
            if tval:
                tally_cat = to_str(tval)
                break
        tally_tax = ""
        payroll_proj = to_str(p.get("projectName") or vendor.get("projectName") or "")
        
        rows.append([
            emp_id, emp_name, emp_email, ptype, txn_date, tot_amt,
            tot_amt, curr, fx, memo, desc, tally_cat, tally_tax, payroll_proj
        ])
    return rows, has_changes, stats


def copy_project_classification(gc, target_sh):
    print("\n--- Copying Project Classification tab ---", flush=True)
    try:
        ref_sh = gc.open_by_key(REFERENCE_SPREADSHEET_ID)
        ref_ws = ref_sh.worksheet("Project Classification")
        values = ref_ws.get_all_values()
        if values:
            update_sheet_tab(target_sh, "Project Classification", values)
    except Exception as e:
        print(f"Note on Project Classification: {e}")


def run_sync(full_scan=False, trigger_d1=True, force_sheets_write=False, target_tab=None):
    mode_str = "Full Historical Scan" if full_scan else "⚡ Fast Incremental (Delta) Sync"
    if target_tab:
        mode_str += f" [Target Tab: {target_tab}]"
    print(f"Starting Volopay Sync ({mode_str})...")
    print(f"Target Sheet ID: {TARGET_SPREADSHEET_ID}\n")
    
    try:
        gc = get_gspread_client()
        target_sh = gc.open_by_key(TARGET_SPREADSHEET_ID)
    except Exception as e:
        print(f"⚠️ Google Sheets connection unavailable (network offline?): {e}", flush=True)
        return {"ok": False, "error": f"Google Sheets connection unavailable: {e}"}
    
    client = None
    try:
        client = VolopayClient()
        # Actively test token validity
        print("Verifying Volopay API connection...", flush=True)
        client.get("company/projects", params={"limit": 1}, timeout=15)
        print("✓ Volopay API connection active!\n", flush=True)
    except Exception as e:
        print(f"⚠️ Stored Volopay tokens expired or invalid: {e}")
        print("🔄 Auto-syncing fresh session tokens from Google Chrome...", flush=True)
        if sync_tokens_from_chrome():
            try:
                client = VolopayClient()
                client.get("company/projects", params={"limit": 1}, timeout=15)
                print("✓ Fresh Volopay tokens verified successfully!\n", flush=True)
            except Exception as v_err:
                print(f"❌ Extracted tokens failed API test: {v_err}")
                if force_sheets_write or target_tab:
                    print("⚡ Proceeding with local cache data to write sheets...", flush=True)
                    client = None
                else:
                    print("👉 Please log into https://iskconwhitefield.volopay.co.in in Google Chrome and re-run.")
                    return {"ok": False, "error": "Extracted tokens failed API test"}
        else:
            if force_sheets_write or target_tab:
                print("⚡ Chrome session not open. Proceeding with local cache data to write sheets...", flush=True)
                client = None
            else:
                print("👉 Please log into https://iskconwhitefield.volopay.co.in in Google Chrome and re-run.")
                return {"ok": False, "error": "Could not extract fresh tokens from Chrome"}

    t0 = time.time()
    tab_filter = target_tab.strip().lower() if target_tab else None
    
    # 1. Claims
    claims_stats = {"new": 0, "updated": 0, "total": 0}
    if not tab_filter or tab_filter in ["claims", "claim"]:
        claims_rows, claims_changed, claims_stats = process_claims(client, full_scan=full_scan)
        if claims_changed or full_scan or force_sheets_write:
            update_sheet_tab(target_sh, "Claims", claims_rows)
        else:
            print(f"  ✓ [Claims] sheet already up to date ({claims_stats.get('new', 0)} new, {claims_stats.get('updated', 0)} updated). Skipping write.", flush=True)
    
    # 2. Expenses
    expenses_stats = {"new": 0, "updated": 0, "total": 0}
    if not tab_filter or tab_filter in ["expenses", "expense"]:
        expenses_rows, expenses_changed, expenses_stats = process_expenses(client, full_scan=full_scan)
        if expenses_changed or full_scan or force_sheets_write:
            update_sheet_tab(target_sh, "Expenses", expenses_rows)
        else:
            print(f"  ✓ [Expenses] sheet already up to date ({expenses_stats.get('new', 0)} new, {expenses_stats.get('updated', 0)} updated). Skipping write.", flush=True)
    
    # 3. Purchase Bills
    bills_stats = {"new": 0, "updated": 0, "total": 0}
    if not tab_filter or tab_filter in ["purchase bills", "bills", "purchase_bills", "bill"]:
        bills_rows, bills_changed, bills_stats = process_purchase_bills(client, full_scan=full_scan)
        if bills_changed or full_scan or force_sheets_write:
            update_sheet_tab(target_sh, "Purchase Bills", bills_rows)
        else:
            print(f"  ✓ [Purchase Bills] sheet already up to date ({bills_stats.get('new', 0)} new, {bills_stats.get('updated', 0)} updated). Skipping write.", flush=True)
    
    # 4. Payrolls
    payrolls_stats = {"new": 0, "updated": 0, "total": 0}
    if not tab_filter or tab_filter in ["payrolls", "payroll"]:
        payrolls_rows, payrolls_changed, payrolls_stats = process_payrolls(client, full_scan=full_scan)
        if payrolls_changed or full_scan or force_sheets_write:
            update_sheet_tab(target_sh, "Payrolls", payrolls_rows)
        else:
            print(f"  ✓ [Payrolls] sheet already up to date ({payrolls_stats.get('new', 0)} new, {payrolls_stats.get('updated', 0)} updated). Skipping write.", flush=True)
    
    # 5. Project Classification
    if full_scan:
        copy_project_classification(gc, target_sh)
        
    duration = round(time.time() - t0, 1)
    total_new = claims_stats.get("new", 0) + expenses_stats.get("new", 0) + bills_stats.get("new", 0) + payrolls_stats.get("new", 0)
    total_updated = claims_stats.get("updated", 0) + expenses_stats.get("updated", 0) + bills_stats.get("updated", 0) + payrolls_stats.get("updated", 0)
    summary_str = f"{total_new} new, {total_updated} updated" if (total_new > 0 or total_updated > 0) else "All sheets up to date"

    print(f"\n🎉 GOOGLE SHEET SYNC COMPLETED IN {duration}s! ({summary_str})", flush=True)

    # Automatically refresh Cloudflare D1 Dashboard
    if trigger_d1:
        trigger_dashboard_sync()

    return {
        "ok": True,
        "duration_sec": duration,
        "total_new": total_new,
        "total_updated": total_updated,
        "summary": summary_str,
        "changes": {
            "claims": claims_stats,
            "expenses": expenses_stats,
            "purchase_bills": bills_stats,
            "payrolls": payrolls_stats,
        }
    }


def trigger_dashboard_sync():
    print("\n--- Triggering Cloudflare Dashboard Sync ---", flush=True)
    endpoints = [
        "https://mis-expenses-dashboard.zoom-attendance-live.workers.dev",
        "https://mis-expenses-dashboard.abhishek-nitj-002-1.workers.dev",
    ]
    for base in endpoints:
        try:
            step, offset = 0, 0
            while True:
                r = requests.post(f"{base}/api/sync?step={step}&offset={offset}&mode=delta", timeout=60)
                data = r.json()
                if data.get("done") or not data.get("hasMore"):
                    totals = data.get("totals") or {}
                    print(f"  ✓ Dashboard at {base} refreshed successfully ({totals.get('rows', 0)} rows, ₹{totals.get('total', 0):,.2f})", flush=True)
                    break
                step = data.get("nextStep")
                offset = data.get("offset", 0)
        except Exception as e:
            print(f"  ⚠️ Warning refreshing {base}: {e}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true", help="Perform full historical scan")
    parser.add_argument("--force-write", action="store_true", help="Force rewrite Google Sheet tabs even if delta has 0 changes")
    parser.add_argument("--no-d1", action="store_true", help="Skip triggering Cloudflare D1 sync")
    parser.add_argument("--tab", type=str, default=None, help="Sync only a specific tab (e.g. Payrolls)")
    args = parser.parse_args()
    run_sync(full_scan=args.full, trigger_d1=not args.no_d1, force_sheets_write=args.force_write, target_tab=args.tab)
