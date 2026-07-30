"""数据素材图片批次、队列、跳过和安全测试。"""
import io
import json
import zipfile

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app
from app.models import (
    MATERIAL_STATUS_COMPLETED,
    MATERIAL_STATUS_FAILED,
    MATERIAL_STATUS_PENDING,
    MATERIAL_STATUS_SKIPPED,
    STATUS_AWAITING_CONFIRMATION,
    STATUS_COMPLETED,
    MaterialBatch,
    MaterialItem,
    SpecimenRecord,
    TaxonomyCache,
)
from app.routers import materials as materials_router
from app.services import materials_service


def image_bytes(color: tuple[int, int, int] = (40, 160, 80)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (24, 16), color=color).save(buffer, format="JPEG")
    return buffer.getvalue()


def zip_bytes(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buffer.getvalue()


@pytest.fixture
def materials_client(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine)

    zip_dir = tmp_path / "zips"
    image_dir = tmp_path / "material_images"
    export_dir = tmp_path / "exports"
    recognition_dir = tmp_path / "recognition_images"
    for directory in (zip_dir, image_dir, export_dir, recognition_dir):
        directory.mkdir()

    monkeypatch.setattr(materials_service, "MATERIAL_ZIPS_DIR", zip_dir)
    monkeypatch.setattr(materials_service, "MATERIAL_IMAGES_DIR", image_dir)
    monkeypatch.setattr(materials_service, "MATERIAL_EXPORTS_DIR", export_dir)
    monkeypatch.setattr(materials_service, "IMAGES_DIR", recognition_dir)
    monkeypatch.setattr(materials_router, "MATERIAL_ZIPS_DIR", zip_dir)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app), TestSession
    app.dependency_overrides.clear()


def upload_zip(client: TestClient, files: dict[str, bytes]):
    return client.post(
        "/api/materials/upload",
        files={"file": ("昆虫素材.zip", zip_bytes(files), "application/zip")},
    )


def test_upload_extracts_images_and_reports_summary(materials_client):
    client, TestSession = materials_client
    response = upload_zip(
        client,
        {
            "甲虫/图片一.jpg": image_bytes(),
            "nested/图片二.JPG": image_bytes((180, 80, 40)),
            "说明.txt": b"ignored",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 2
    assert data["pending_count"] == 2
    assert data["completed_count"] == 0
    assert data["batch"]["original_filename"] == "昆虫素材.zip"

    items = client.get("/api/materials/items").json()
    assert [item["archive_path"] for item in items] == [
        "甲虫/图片一.jpg",
        "nested/图片二.JPG",
    ]
    db = TestSession()
    assert db.query(MaterialBatch).count() == 1
    assert db.query(MaterialItem).count() == 2
    assert all(__import__("pathlib").Path(item.stored_path).exists() for item in db.query(MaterialItem))
    db.close()


def test_new_upload_becomes_active_batch(materials_client):
    client, TestSession = materials_client
    assert upload_zip(client, {"old.jpg": image_bytes()}).status_code == 200
    assert upload_zip(client, {"new.jpg": image_bytes()}).status_code == 200

    db = TestSession()
    batches = db.query(MaterialBatch).order_by(MaterialBatch.id).all()
    assert len(batches) == 2
    assert batches[0].is_active is False
    assert batches[1].is_active is True
    db.close()


def test_upload_rejects_zip_path_traversal(materials_client):
    client, _ = materials_client
    response = upload_zip(client, {"../escape.jpg": image_bytes()})
    assert response.status_code == 400
    assert "不安全" in response.json()["detail"]


def test_upload_rejects_invalid_or_empty_zip(materials_client):
    client, _ = materials_client
    invalid = client.post(
        "/api/materials/upload",
        files={"file": ("bad.zip", b"not-a-zip", "application/zip")},
    )
    assert invalid.status_code == 400

    empty = upload_zip(client, {"readme.txt": b"no images"})
    assert empty.status_code == 400
    assert "没有支持的图片" in empty.json()["detail"]


def test_upload_rejects_excessive_archive_entries(materials_client, monkeypatch):
    client, _ = materials_client
    monkeypatch.setattr(materials_service.settings, "material_zip_max_entries", 1)

    response = upload_zip(
        client,
        {
            "one.jpg": image_bytes(),
            "two.txt": b"extra",
        },
    )
    assert response.status_code == 413
    assert "文件条目" in response.json()["detail"]


def test_upload_rejects_excessive_image_pixels(materials_client, monkeypatch):
    client, _ = materials_client
    monkeypatch.setattr(materials_service.settings, "material_image_max_pixels", 100)

    response = upload_zip(client, {"large.jpg": image_bytes()})
    assert response.status_code == 413
    assert "像素" in response.json()["detail"]


def test_upload_request_body_limit_precedes_multipart_parse(
    materials_client,
    monkeypatch,
):
    client, _ = materials_client
    monkeypatch.setattr(materials_service.settings, "material_zip_max_size_mb", 1)

    response = client.post(
        "/api/materials/upload",
        files={"file": ("large.zip", b"x" * (3 * 1024 * 1024), "application/zip")},
    )
    assert response.status_code == 413
    assert response.json()["detail"] == "素材上传请求体过大"


def test_skip_and_export_preserve_archive_paths(materials_client):
    client, _ = materials_client
    assert upload_zip(
        client,
        {
            "目录/一.jpg": image_bytes(),
            "目录/二.jpg": image_bytes((20, 40, 200)),
        },
    ).status_code == 200
    item = client.get("/api/materials/items").json()[0]
    skipped = client.post(f"/api/materials/{item['id']}/skip")
    assert skipped.status_code == 200
    assert skipped.json()["skipped_count"] == 1

    exported = client.get("/api/materials/skipped/export")
    assert exported.status_code == 200
    assert exported.headers["x-skipped-count"] == "1"
    with zipfile.ZipFile(io.BytesIO(exported.content)) as zf:
        assert zf.namelist() == ["目录/一.jpg"]
        assert zf.read("目录/一.jpg")


def test_queue_skip_complete_and_record_delete(materials_client, monkeypatch):
    client, TestSession = materials_client

    async def fake_extract(
        db,
        image_path,
        image_filename,
        rotation_degrees=0,
        record=None,
    ):
        record.status = STATUS_AWAITING_CONFIRMATION
        record.extracted_draft_json = json.dumps(
            {
                "extracted": {
                    "中名": "测试昆虫",
                    "产地3": "测试地点",
                    "图像": f"TEST-{record.id}",
                    "采集人": "",
                    "采集日期": "2026-07-30",
                },
                "confidence": {},
                "evidence": {},
                "warnings": [],
            },
            ensure_ascii=False,
        )
        db.commit()
        db.refresh(record)
        return record

    async def fake_confirm(
        db,
        record,
        confirmed,
        duplicate_action=None,
        existing_record=None,
        material_item=None,
    ):
        assert material_item is not None
        record.zhongming = confirmed["中名"]
        record.tuxiang = confirmed["图像"]
        record.chandi3 = confirmed.get("产地3", "")
        record.caijiren = confirmed.get("采集人", "")
        record.caiji_riqi = confirmed.get("采集日期", "")
        record.status = STATUS_COMPLETED
        material_item.record_id = record.id
        material_item.status = MATERIAL_STATUS_COMPLETED
        db.commit()
        db.refresh(record)
        return record

    monkeypatch.setattr(
        materials_service.recognition_service,
        "extract_image_info",
        fake_extract,
    )
    from app.routers import recognition as recognition_router
    monkeypatch.setattr(recognition_router.svc, "confirm_and_classify", fake_confirm)

    assert upload_zip(
        client,
        {
            "一.jpg": image_bytes(),
            "二.jpg": image_bytes((200, 50, 50)),
        },
    ).status_code == 200

    first = client.post("/api/materials/next-extract")
    assert first.status_code == 200
    first_data = first.json()
    active = client.get("/api/recognition/active-draft").json()
    assert active["material_item_id"] == first_data["material_item_id"]

    skipped = client.post(
        f"/api/materials/{first_data['material_item_id']}/skip"
    )
    assert skipped.json()["skipped_count"] == 1
    assert skipped.json()["pending_count"] == 1

    second = client.post("/api/materials/next-extract")
    assert second.status_code == 200
    second_data = second.json()
    confirmed = client.post(
        f"/api/recognition/{second_data['record_id']}/confirm-extraction",
        json={"confirmed": second_data["extracted"]},
    )
    assert confirmed.status_code == 200

    summary = client.get("/api/materials/summary").json()
    assert summary["completed_count"] == 1
    assert summary["skipped_count"] == 1
    assert summary["pending_count"] == 0

    deleted = client.delete(f"/api/records/{second_data['record_id']}")
    assert deleted.status_code == 200
    summary = client.get("/api/materials/summary").json()
    assert summary["completed_count"] == 0
    assert summary["pending_count"] == 1

    db = TestSession()
    statuses = {
        item.sequence: item.status
        for item in db.query(MaterialItem).order_by(MaterialItem.sequence)
    }
    assert statuses == {
        1: MATERIAL_STATUS_SKIPPED,
        2: MATERIAL_STATUS_PENDING,
    }
    assert db.query(SpecimenRecord).filter(
        SpecimenRecord.status == STATUS_COMPLETED
    ).count() == 0
    db.close()


def test_upload_rejected_while_draft_is_active(materials_client):
    client, TestSession = materials_client
    db = TestSession()
    db.add(SpecimenRecord(status=STATUS_AWAITING_CONFIRMATION))
    db.commit()
    db.close()

    response = upload_zip(client, {"one.jpg": image_bytes()})
    assert response.status_code == 409
    assert "未完成草稿" in response.json()["detail"]


def test_extraction_failure_is_reported_in_summary(materials_client, monkeypatch):
    client, TestSession = materials_client

    async def fail_extract(*args, **kwargs):
        raise HTTPException(status_code=502, detail="模型暂不可用")

    monkeypatch.setattr(
        materials_service.recognition_service,
        "extract_image_info",
        fail_extract,
    )

    assert upload_zip(client, {"failed.jpg": image_bytes()}).status_code == 200
    response = client.post("/api/materials/next-extract")
    assert response.status_code == 502

    summary = client.get("/api/materials/summary").json()
    assert summary["failed_count"] == 1
    assert summary["processing_count"] == 0
    db = TestSession()
    assert db.query(MaterialItem).one().status == MATERIAL_STATUS_FAILED
    db.close()


def test_duplicate_replace_keeps_material_link(materials_client, monkeypatch):
    client, TestSession = materials_client

    async def fake_extract(
        db,
        image_path,
        image_filename,
        rotation_degrees=0,
        record=None,
    ):
        record.status = STATUS_AWAITING_CONFIRMATION
        record.extracted_draft_json = json.dumps(
            {
                "extracted": {
                    "中名": "重复素材",
                    "产地3": "",
                    "图像": "DUPLICATE-1",
                    "采集人": "",
                    "采集日期": "",
                },
                "confidence": {},
                "evidence": {},
                "warnings": [],
            },
            ensure_ascii=False,
        )
        db.commit()
        db.refresh(record)
        return record

    monkeypatch.setattr(
        materials_service.recognition_service,
        "extract_image_info",
        fake_extract,
    )

    db = TestSession()
    existing = SpecimenRecord(
        status=STATUS_COMPLETED,
        tuxiang="DUPLICATE-1",
        zhongming="原有记录",
    )
    db.add_all(
        [
            existing,
            TaxonomyCache(
                zhongming="重复素材",
                phylum="Arthropoda",
                gang="昆虫纲",
                klass="Insecta",
                order_field="Coleoptera",
                zhongwen_ke="瓢虫科",
                ke="Coccinellidae",
                shu="Harmonia",
                zhong="axyridis",
            ),
        ]
    )
    db.commit()
    existing_id = existing.id
    db.close()

    assert upload_zip(client, {"duplicate.jpg": image_bytes()}).status_code == 200
    extracted = client.post("/api/materials/next-extract").json()
    response = client.post(
        f"/api/recognition/{extracted['record_id']}/confirm-extraction",
        json={
            "confirmed": extracted["extracted"],
            "duplicate_action": "replace",
        },
    )
    assert response.status_code == 200
    assert response.json()["record_id"] == existing_id

    db = TestSession()
    item = db.get(MaterialItem, extracted["material_item_id"])
    assert item.status == MATERIAL_STATUS_COMPLETED
    assert item.record_id == existing_id
    batch = db.get(MaterialBatch, item.batch_id)
    batch.total_count = 2
    db.add(
        MaterialItem(
            batch_id=batch.id,
            sequence=2,
            original_filename="duplicate-two.jpg",
            archive_path="duplicate-two.jpg",
            stored_path=item.stored_path,
            status=MATERIAL_STATUS_COMPLETED,
            record_id=existing_id,
        )
    )
    db.commit()
    db.close()

    assert client.delete(f"/api/records/{existing_id}").status_code == 200
    db = TestSession()
    linked_items = db.query(MaterialItem).order_by(MaterialItem.sequence).all()
    assert [item.status for item in linked_items] == [
        MATERIAL_STATUS_PENDING,
        MATERIAL_STATUS_PENDING,
    ]
    assert all(item.record_id is None for item in linked_items)
    db.close()


def test_delete_batch_clears_items_and_files(materials_client):
    client, TestSession = materials_client
    assert upload_zip(
        client,
        {
            "a.jpg": image_bytes(),
            "b.jpg": image_bytes((10, 20, 30)),
        },
    ).status_code == 200

    db = TestSession()
    batch = db.query(MaterialBatch).one()
    extract_dir = __import__("pathlib").Path(batch.extract_dir)
    zip_path = __import__("pathlib").Path(batch.stored_zip_path)
    assert extract_dir.exists()
    assert zip_path.exists()
    db.close()

    deleted = client.delete("/api/materials/batch")
    assert deleted.status_code == 200
    assert deleted.json()["total_count"] == 0
    assert deleted.json()["batch"] is None

    db = TestSession()
    assert db.query(MaterialBatch).count() == 0
    assert db.query(MaterialItem).count() == 0
    db.close()

    assert not extract_dir.exists()
    assert not zip_path.exists()


def test_delete_batch_with_processing_cleans_draft(materials_client):
    client, TestSession = materials_client
    assert upload_zip(client, {"x.jpg": image_bytes()}).status_code == 200

    db = TestSession()
    batch = db.query(MaterialBatch).one()
    item = db.query(MaterialItem).one()
    record = SpecimenRecord(
        image_filename="x.jpg",
        image_path="/tmp/fake.jpg",
        status=STATUS_AWAITING_CONFIRMATION,
    )
    db.add(record)
    db.commit()
    item.record_id = record.id
    item.status = "processing"
    db.commit()
    record_id = record.id
    db.close()

    deleted = client.delete("/api/materials/batch")
    assert deleted.status_code == 200

    db = TestSession()
    assert db.query(MaterialBatch).count() == 0
    assert db.query(MaterialItem).count() == 0
    record = db.get(SpecimenRecord, record_id)
    assert record.status == "discarded"
    db.close()


def test_delete_batch_with_completed_is_rejected(materials_client):
    client, TestSession = materials_client
    assert upload_zip(client, {"done.jpg": image_bytes()}).status_code == 200

    db = TestSession()
    batch = db.query(MaterialBatch).one()
    item = db.query(MaterialItem).one()
    record = SpecimenRecord(
        image_filename="done.jpg",
        image_path="/tmp/done.jpg",
        status=STATUS_COMPLETED,
        tuxiang="DONE-1",
        zhongming="测试",
    )
    db.add(record)
    db.commit()
    item.record_id = record.id
    item.status = MATERIAL_STATUS_COMPLETED
    db.commit()
    db.close()

    deleted = client.delete("/api/materials/batch")
    assert deleted.status_code == 409
    assert "已完成" in deleted.json()["detail"]

    db = TestSession()
    assert db.query(MaterialBatch).count() == 1
    assert db.query(MaterialItem).count() == 1
    db.close()


def test_delete_batch_when_none_returns_404(materials_client):
    client, _ = materials_client
    deleted = client.delete("/api/materials/batch")
    assert deleted.status_code == 404
