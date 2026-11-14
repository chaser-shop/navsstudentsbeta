import re


def normalize_phone(raw: str) -> str:
    """Український номер -> +380XXXXXXXXX. ValueError, якщо формат не підходить."""
    d = re.sub(r"\D", "", raw or "")
    if len(d) == 10 and d.startswith("0"):
        d = "38" + d
    elif len(d) == 11 and d.startswith("80"):
        d = "3" + d
    if not (len(d) == 12 and d.startswith("380")):
        raise ValueError("Номер у форматі +380XXXXXXXXX або 0XXXXXXXXX")
    return "+" + d
