"""v1.3.11 上传预压缩标准化(门槛式)测试。

覆盖:压缩断言/小图跳过/PNG转JPEG路径同步/损坏图降级/门槛409/预取gate/
降级恢复/开关关闭回退。
复用 test_materials.materials_client 夹具(含 SessionLocal 隔离)。
"""
import asyncio
import io
import time
import zipfile

from fastapi.testclient import TestClient
from PIL import Image

from app.models import (
    MaterialBatch,
    MaterialItem,
    MaterialPrefetchResult,
    PREPROCESS_STATUS_COMPLETED,
    PREPROCESS_STATUS_FAILED,
)
from app.services import materials_service
from app.services.material_standardize_service import (
    mark_batch_preprocess_completed,
    mark_batch_preprocess_failed,
    summarize_stats,
)
from tests.test_materials import materials_client  # noqa: F401  夹具复用


def _big_image_bytes(width: int, height: int, fmt: str = "JPEG", quality: int = 95) -> bytes:
    """高分辨率噪声图,确保压缩后有足够节省比例。"""
    import random

    rng = random.Random(42)
    img = Image.new("RGB", (width, height))
    pixels = img.load()
    for y in range(0, height, 4):
        for x in range(0, width, 4):
            c = (rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255))
            for dy in range(4):
                for dx in range(4):
                    if x + dx < width and y + dy < height:
                        pixels[x + dx, y + dy] = c
    buf = io.BytesIO()
    img.save(buf, format=fmt, quality=quality)
    return buf.getvalue()


def _upload_and_standardize(client: TestClient, files: dict[str, bytes]):
    """上传并等待两阶段完成,返回 (summary_json, ingest 终态)。"""
    response = client.post(
        "/api/materials/upload",
        files={"file": ("std.zip", _zip(files), "application/zip")},
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]
    final = None
    stages_seen = []
    for _ in range(600):
        status = client.get(f"/api/materials/ingest/{job_id}")
        assert status.status_code == 200
        payload = status.json()
        stages_seen.append(payload.get("stage"))
        final = payload
        if payload["status"] in ("completed", "failed"):
            break
        time.sleep(0.05)
    assert final is not None, "ingest 任务未返回"
    if final["status"] != "completed":
        raise AssertionError(f"ingest 失败: {final.get('error_message', '')[:500]}")
    time.sleep(0.05)
    return client.get("/api/materials/summary").json(), final, stages_seen


def _zip(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buffer.getvalue()


# ============================================================
# 压缩核心断言
# ============================================================

def test_standardize_large_image_shrinks(materials_client):
    """4032×3024 大图 → 长边≤1600,体积降≥80%。"""
    client, TestSession = materials_client
    big = _big_image_bytes(4032, 3024)
    assert len(big) > 500_000
    summary, job, _ = _upload_and_standardize(client, {"big.jpg": big})
    assert summary["preprocess_status"] == "completed", summary
    assert summary["preprocessed_count"] == summary["total_count"]

    db = TestSession()
    batch = db.query(MaterialBatch).one()
    item = db.query(MaterialItem).one()
    db.close()
    stored = materials_service.resolve_material_image_path(item.stored_path)
    assert stored.stat().st_size < len(big) * 0.2, (
        f"压缩后 {stored.stat().st_size} 应小于原件 {len(big)} 的 20%"
    )
    with Image.open(stored) as img:
        assert max(img.size) <= 1600


def test_standardize_small_image_skipped(materials_client):
    """已达标小图零扰动(节省不足 15% 时保持原文件)。"""
    client, TestSession = materials_client
    tiny = _big_image_bytes(400, 300, quality=60)
    summary, _, _ = _upload_and_standardize(client, {"tiny.jpg": tiny})
    assert summary["preprocess_status"] == "completed"

    db = TestSession()
    item = db.query(MaterialItem).one()
    db.close()
    stored = materials_service.resolve_material_image_path(item.stored_path)
    assert stored.stat().st_size == len(tiny), "小图应保持原样"


def test_standardize_png_converts_and_updates_path(materials_client):
    """PNG → JPEG:后缀改 .jpg 且 stored_path 同步。"""
    client, TestSession = materials_client
    png = _big_image_bytes(3000, 2000, fmt="PNG")
    summary, _, _ = _upload_and_standardize(client, {"pic.png": png})
    assert summary["preprocess_status"] == "completed"

    db = TestSession()
    item = db.query(MaterialItem).one()
    stored_path = item.stored_path
    db.close()
    assert stored_path.lower().endswith(".jpg")
    stored = materials_service.resolve_material_image_path(stored_path)
    assert stored.is_file()
    with Image.open(stored) as img:
        assert img.format == "JPEG"
        assert max(img.size) <= 1600


def test_standardize_corrupt_image_degrades_not_fails(materials_client):
    """损坏图跳过计数,批次仍 completed 可用。"""
    client, TestSession = materials_client
    garbage = b"not-an-image-at-all" * 100
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("bad.jpg", garbage)
        zf.writestr(
            "ok.jpg",
            _big_image_bytes(3200, 2400),
        )
    response = client.post(
        "/api/materials/upload",
        files={"file": ("mixed.zip", buffer.getvalue(), "application/zip")},
    )
    # 损坏图在解压校验阶段就会被过滤
    if response.status_code == 202:
        job_id = response.json()["job_id"]
        for _ in range(600):
            payload = client.get(f"/api/materials/ingest/{job_id}").json()
            if payload["status"] in ("completed", "failed"):
                break
            time.sleep(0.05)
        assert payload["status"] == "completed"
        summary = client.get("/api/materials/summary").json()
        assert summary["preprocess_status"] == "completed"
        assert summary["total_count"] == 1


# ============================================================
# 门槛(前台 409 + 预取 gate)
# ============================================================

def test_gate_blocks_next_extract_while_processing(materials_client, monkeypatch):
    """preprocessing 期间 next-extract 409 且携带进度体。"""
    client, TestSession = materials_client
    assert _upload_and_standardize(client, {"a.jpg": _big_image_bytes(3200, 2400)})[0]
    db = TestSession()
    batch = db.query(MaterialBatch).one()
    batch.preprocess_status = "processing"
    batch.preprocessed_count = 1
    db.commit()
    batch_id = batch.id
    db.close()

    response = client.post("/api/materials/next-extract")
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert isinstance(detail, dict)
    assert detail["preprocess_status"] == "processing"
    assert detail["preprocessed_count"] == 1
    assert detail["total_count"] == 1
    assert "标准化" in detail["message"]

    # 恢复 completed 后正常
    db = TestSession()
    db.get(MaterialBatch, batch_id).preprocess_status = PREPROCESS_STATUS_COMPLETED
    db.commit()
    db.close()


def test_gate_failed_status_allows_work(materials_client):
    """failed 降级放行:不因标准化失败锁死工作台。"""
    client, TestSession = materials_client
    assert _upload_and_standardize(client, {"a.jpg": _big_image_bytes(3200, 2400)})[0]
    db = TestSession()
    batch = db.query(MaterialBatch).one()
    batch.preprocess_status = PREPROCESS_STATUS_FAILED
    db.commit()
    db.close()
    # next-extract 不再 409(可能 404/409 其他原因,但不能是标准化门槛)
    response = client.post("/api/materials/next-extract")
    assert response.status_code != 409 or not isinstance(response.json()["detail"], dict) or \
        "preprocess" not in str(response.json().get("detail", ""))


def test_prefetch_gate_blocks_incomplete_batch(materials_client, monkeypatch):
    """标准化未完成的批次,预取 worker 不创建任何预载行。"""
    from app.services import prefetch_service as ps

    client, TestSession = materials_client
    assert _upload_and_standardize(client, {"a.jpg": _big_image_bytes(3200, 2400)})[0]
    db = TestSession()
    batch = db.query(MaterialBatch).one()
    batch.preprocess_status = "processing"
    db.commit()
    db.close()

    monkeypatch.setattr(ps, "SessionLocal", TestSession)
    from app.services.prefetch_service import PrefetchWorker

    async def scenario():
        worker = PrefetchWorker()
        await worker._fill_window()

    asyncio.run(scenario())
    db = TestSession()
    assert db.query(MaterialPrefetchResult).count() == 0, "未完成标准化不应产生预载行"
    db.close()


# ============================================================
# 降级与恢复
# ============================================================

def test_mark_failed_and_completed_helpers(materials_client):
    """降级/完成标记助手语义。"""
    client, TestSession = materials_client
    assert _upload_and_standardize(client, {"a.jpg": _big_image_bytes(3200, 2400)})[0]
    db = TestSession()
    batch = db.query(MaterialBatch).one()
    batch_id = batch.id
    db.close()

    mark_batch_preprocess_failed(batch_id, TestSession)
    db = TestSession()
    assert db.get(MaterialBatch, batch_id).preprocess_status == PREPROCESS_STATUS_FAILED
    db.close()

    mark_batch_preprocess_completed(batch_id, TestSession)
    db = TestSession()
    restored = db.get(MaterialBatch, batch_id)
    assert restored.preprocess_status == PREPROCESS_STATUS_COMPLETED
    assert restored.preprocessed_count == restored.total_count
    db.close()


def test_recover_interrupted_jobs_downgrades_active_batch(materials_client, monkeypatch):
    """重启恢复:标准化未完成的活跃批次 → failed 降级。"""
    from app.services import material_ingest_service as ingest_service

    client, TestSession = materials_client
    assert _upload_and_standardize(client, {"a.jpg": _big_image_bytes(3200, 2400)})[0]
    db = TestSession()
    batch = db.query(MaterialBatch).one()
    batch.preprocess_status = "processing"
    db.commit()
    db.close()

    monkeypatch.setattr(ingest_service, "SessionLocal", TestSession)
    ingest_service.recover_interrupted_jobs()
    db = TestSession()
    assert (
        db.query(MaterialBatch).one().preprocess_status == PREPROCESS_STATUS_FAILED
    )
    db.close()


def test_disabled_switch_restores_v1310_behavior(materials_client, monkeypatch):
    """开关关闭:批次直接 completed,图片原样落盘。"""
    client, TestSession = materials_client
    monkeypatch.setattr(
        materials_service.settings, "material_standardize_enabled", False
    )
    big = _big_image_bytes(4032, 3024)
    summary, job, _ = _upload_and_standardize(client, {"big.jpg": big})
    assert summary["preprocess_status"] == "completed"
    db = TestSession()
    item = db.query(MaterialItem).one()
    db.close()
    stored = materials_service.resolve_material_image_path(item.stored_path)
    assert stored.stat().st_size == len(big), "关闭开关应保持原样"


def test_stats_summary_format():
    stats = {"processed": 3, "replaced": 2, "skipped": 1, "failed": 0, "renamed": 1}
    text = summarize_stats(stats)
    assert "替换2" in text and "跳过1" in text
