"""Клієнт backend API. Бот НЕ підключається до MongoDB напряму."""
import os

import requests


class ApiError(RuntimeError):
    pass


class Api:
    def __init__(self):
        self.base = os.environ.get("API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
        self.token = None

    def _login(self):
        r = requests.post(f"{self.base}/api/auth/login", timeout=15, json={
            "username": os.environ.get("BOT_API_USERNAME", ""), "password": os.environ.get("BOT_API_PASSWORD", "")})
        if r.status_code != 200:
            raise ApiError("Бот не зміг увійти в backend (перевірте BOT_API_USERNAME/BOT_API_PASSWORD)")
        self.token = r.json()["token"]

    def call(self, method, path, **kw):
        for attempt in (0, 1):
            if not self.token:
                self._login()
            try:
                r = requests.request(method, self.base + path, timeout=20,
                                     headers={"Authorization": f"Bearer {self.token}"}, **kw)
            except requests.RequestException:
                raise ApiError("Backend недоступний")
            if r.status_code == 401 and attempt == 0:
                self.token = None
                continue
            if r.status_code >= 400:
                try:
                    detail = r.json().get("detail")
                except Exception:
                    detail = None
                raise ApiError(detail if isinstance(detail, str) else f"Помилка {r.status_code}")
            return r.json()
