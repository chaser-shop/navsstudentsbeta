"""Запуск чистих тестів без pytest: python -m tests.run_pure"""
import importlib, sys, traceback
fails = 0
for m in ("test_compliance", "test_bot_logic", "test_catalog", "test_dashboard_logic", "test_lines", "test_subscription", "test_sheet_sync", "test_discounts", "test_promo", "test_receipt"):
    mod = importlib.import_module(f"tests.{m}")
    for n in sorted(x for x in dir(mod) if x.startswith("test_")):
        try:
            getattr(mod, n)(); print("PASS", m, n)
        except Exception:
            fails += 1; print("FAIL", m, n); traceback.print_exc()
sys.exit(1 if fails else 0)
