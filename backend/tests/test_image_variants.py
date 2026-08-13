from pathlib import Path

from PIL import Image

from app.services.image_variant_service import PREVIEW_MAX_EDGE, get_preview_path


def test_preview_is_cached_and_smaller_than_source(tmp_path: Path):
    source = tmp_path / "large.jpg"
    Image.new("RGB", (4200, 2800), "white").save(source, quality=95)

    preview = get_preview_path(source)
    cached = get_preview_path(source)

    assert preview == cached
    assert preview.suffix == ".webp"
    assert preview.stat().st_size < source.stat().st_size
    with Image.open(preview) as image:
        assert max(image.size) == PREVIEW_MAX_EDGE


def test_preview_cache_changes_when_source_changes(tmp_path: Path):
    source = tmp_path / "source.png"
    Image.new("RGB", (2400, 1600), "red").save(source)
    first = get_preview_path(source)

    Image.new("RGB", (2401, 1600), "blue").save(source)
    second = get_preview_path(source)

    assert first != second
    assert second.is_file()
