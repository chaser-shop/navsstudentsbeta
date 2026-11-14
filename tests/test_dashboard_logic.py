import io

import pytest
from PIL import Image

from backend.services.images import ImageError, process_upload
from backend.services.pricing import DEFAULT_MARKUPS, final_price, purchase_from_final


def _img(fmt="PNG", size=(3000, 2000), mode="RGB"):
    b = io.BytesIO()
    Image.new(mode, size, (200, 30, 30)).save(b, fmt)
    return b.getvalue()


def test_upload_is_resized_and_converted_to_webp():
    name, data = process_upload(_img())
    assert name.endswith(".webp") and len(name) == 17
    im = Image.open(io.BytesIO(data))
    assert im.format == "WEBP" and max(im.size) == 1200


def test_upload_same_file_gives_same_name():
    assert process_upload(_img())[0] == process_upload(_img())[0]


def test_upload_rejects_non_images_and_other_formats():
    for bad in (b"", b"not an image", b"<svg xmlns='http://www.w3.org/2000/svg'/>", _img("GIF", (10, 10), "P")):
        with pytest.raises(ImageError):
            process_upload(bad)


def test_upload_rejects_huge_file():
    with pytest.raises(ImageError):
        process_upload(b"0" * (8 * 1024 * 1024 + 1))


def test_sale_price_roundtrips_through_purchase_price():
    for cat in ("pod", "cartridge", "booster"):
        p = purchase_from_final("1200", cat, DEFAULT_MARKUPS)
        assert str(final_price(p, cat, DEFAULT_MARKUPS)) == "1200.00"


def test_sale_price_below_markup_or_unknown_category_is_rejected():
    with pytest.raises(ValueError):
        purchase_from_final("50", "pod", DEFAULT_MARKUPS)       # націнка 70
    with pytest.raises(ValueError):
        purchase_from_final("500", None, DEFAULT_MARKUPS)
