"""本地 OCR 服务测试。"""
from types import SimpleNamespace

import pytest
from PIL import Image

from app.services import ocr_service


@pytest.fixture(autouse=True)
def reset_ocr_engine(monkeypatch):
    monkeypatch.setattr(ocr_service, "_engine", None)
    monkeypatch.setattr(ocr_service, "_engine_error", None)


@pytest.fixture
def image_path(tmp_path):
    path = tmp_path / "label.png"
    Image.new("RGB", (4, 2), color="white").save(path)
    return str(path)


def test_normalizes_legacy_tuple_output(monkeypatch, image_path):
    output = (
        [
            [
                [[1, 2], [11, 2], [11, 7], [1, 7]],
                " PSZP-00842 ",
                0.96,
            ],
            [
                [[3.5, 9], [12, 9], [12, 14], [3.5, 14]],
                "深圳",
                0.875,
            ],
        ],
        {"elapsed": 0.1},
    )
    engine = lambda image: output
    monkeypatch.setattr(ocr_service, "_create_engine", lambda: engine)

    result = ocr_service.recognize_text(image_path)

    assert result == {
        "lines": [
            {
                "text": "PSZP-00842",
                "confidence": 0.96,
                "box": [[1, 2], [11, 2], [11, 7], [1, 7]],
            },
            {
                "text": "深圳",
                "confidence": 0.875,
                "box": [[3.5, 9], [12, 9], [12, 14], [3.5, 14]],
            },
        ],
        "warnings": [],
    }


def test_normalizes_v3_object_output(monkeypatch, image_path):
    output = SimpleNamespace(
        boxes=[[[0, 0], [8, 0], [8, 3], [0, 3]]],
        txts=["采集日期"],
        scores=[0.91],
    )

    class Engine:
        def run(self, image):
            return output

    monkeypatch.setattr(ocr_service, "_create_engine", Engine)

    result = ocr_service.recognize_text(image_path)

    assert result["warnings"] == []
    assert result["lines"] == [{
        "text": "采集日期",
        "confidence": 0.91,
        "box": [[0, 0], [8, 0], [8, 3], [0, 3]],
    }]


def test_applies_clockwise_rotation_before_ocr(monkeypatch, image_path):
    received_shapes = []

    def engine(image):
        received_shapes.append(image.shape)
        return []

    monkeypatch.setattr(ocr_service, "_create_engine", lambda: engine)

    result = ocr_service.recognize_text(image_path, rotation_degrees=90)

    assert result == {"lines": [], "warnings": []}
    assert received_shapes == [(4, 2, 3)]


def test_engine_initialization_failure_is_cached(monkeypatch, image_path):
    attempts = 0

    def fail():
        nonlocal attempts
        attempts += 1
        raise ImportError("rapidocr is not installed")

    monkeypatch.setattr(ocr_service, "_create_engine", fail)

    first = ocr_service.recognize_text(image_path)
    second = ocr_service.recognize_text(image_path)

    assert attempts == 1
    assert first["lines"] == second["lines"] == []
    assert first["warnings"] == ["OCR unavailable (RuntimeError)"]
    assert second["warnings"] == ["OCR unavailable (RuntimeError)"]


def test_runtime_failure_returns_warning(monkeypatch, image_path):
    def fail(_image):
        raise RuntimeError("model load failed")

    monkeypatch.setattr(ocr_service, "_create_engine", lambda: fail)

    result = ocr_service.recognize_text(image_path)

    assert result == {
        "lines": [],
        "warnings": ["OCR unavailable (RuntimeError)"],
    }
