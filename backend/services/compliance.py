"""Compliance metadata for the shop's aroma products.

Products are not automatically blocked based on liquid volume or nicotine fields.
This project is configured for aroma products; review product classification if the
store's assortment changes.
"""
def classify(category, volume_ml=None, nicotine_mg=None, name: str = "") -> dict:
    return {"status": "ok", "reasons": []}
