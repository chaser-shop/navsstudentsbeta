"""Нова пошта API 2.0: пошук міста (з областю) та відділень. HTTP-виклик підміняється в тестах."""
import requests

URL = "https://api.novaposhta.ua/v2.0/json/"


class NPError(RuntimeError):
    pass


def _post(payload: dict) -> dict:
    r = requests.post(URL, json=payload, timeout=15)
    r.raise_for_status()
    return r.json()


class NovaPoshta:
    def __init__(self, api_key: str, post=_post):
        if not api_key:
            raise NPError("NOVA_POSHTA_API_KEY не задано")
        self.key, self._post = api_key, post

    def _call(self, model: str, method: str, props: dict) -> list:
        res = self._post({"apiKey": self.key, "modelName": model, "calledMethod": method, "methodProperties": props})
        if not res.get("success"):
            raise NPError("; ".join(res.get("errors") or ["Помилка API Нової пошти"]))
        return res.get("data") or []

    def search_cities(self, name: str, limit: int = 8) -> list[dict]:
        data = self._call("Address", "searchSettlements", {"CityName": name.strip(), "Limit": str(limit), "Page": "1"})
        out = []
        for block in data:
            for a in block.get("Addresses", []):
                if int(a.get("Warehouses") or 0) > 0 and a.get("DeliveryCity"):
                    out.append({"city": a.get("MainDescription", ""), "area": a.get("Area", ""),
                                "region": a.get("Region", ""), "present": a.get("Present", ""),
                                "city_ref": a["DeliveryCity"]})
        return out

    def warehouses(self, city_ref: str, find: str = "", page: int = 1, limit: int = 8) -> list[dict]:
        props = {"CityRef": city_ref, "Page": str(page), "Limit": str(limit)}
        if find.strip():
            props["FindByString"] = find.strip()
        return [{"title": w.get("Description", ""), "ref": w.get("Ref", ""), "number": w.get("Number", "")}
                for w in self._call("Address", "getWarehouses", props)]
