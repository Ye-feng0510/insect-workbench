"""Excel 预览服务测试。"""
import json
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app
from app.models import SpecimenRecord, ExcelTemplate, STATUS_COMPLETED
from app.services import recognition_service

TEST_TEMPLATE = __import__("pathlib").Path(__file__).resolve().parent.parent.parent / "test-data" / "示例模板表.xlsx"


@pytest.fixture
def client_with_template():
    """带模板和已完成记录的测试客户端。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    # 创建部分唯一索引
    with engine.connect() as conn:
        from sqlalchemy import text
        conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_specimen_tuxiang_completed "
            "ON specimen_records (tuxiang) WHERE status = 'completed'"
        ))
        conn.commit()
    TestSession = sessionmaker(bind=engine)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)
    client.test_session_factory = TestSession

    # 创建模板配置(指向真实模板文件)
    field_mapping = {
        "中名": "E", "Phylum": "G", "纲": "H", "Class": "I", "Order": "K",
        "中文科名": "L", "科名": "M", "属名": "N", "种名": "O", "产地3": "X",
        "图像": "AE", "采集人": "AI", "采集日期": "AJ", "鉴定人": "AM",
    }
    template = ExcelTemplate(
        original_filename="示例模板表.xlsx",
        stored_path=str(TEST_TEMPLATE),
        target_sheet="实际要录入的表格",
        header_row=1,
        start_row=2,
        base_write_row=4,
        style_source_row=2,
        field_mapping_json=json.dumps(field_mapping, ensure_ascii=False),
        is_active=True,
    )
    db = TestSession()
    db.add(template)

    # 添加两条已完成记录
    r1 = SpecimenRecord(
        zhongming="二点红蝽", phylum="Arthropoda", gang="昆虫纲", klass="Insecta",
        order_field="Hemiptera", zhongwen_ke="红蝽科", ke="Pyrrhocoridae",
        shu="Dysdercus", zhong="cingulatus", chandi3="龙岗园山景区",
        tuxiang="PSZP-00842", caijiren="", caiji_riqi="2009-10-24",
        jiandingren="王五",
        status=STATUS_COMPLETED,
    )
    r2 = SpecimenRecord(
        zhongming="中华螽斯", phylum="Arthropoda", gang="昆虫纲", klass="Insecta",
        order_field="Orthoptera", zhongwen_ke="螽斯科", ke="Tettigoniidae",
        shu="Tettigonia", zhong="chinensis", chandi3="梧桐山",
        tuxiang="PSZP-00843", caijiren="张三", caiji_riqi="2010-05-15",
        jiandingren="",
        status=STATUS_COMPLETED,
    )
    db.add_all([r1, r2])
    db.commit()
    db.close()

    yield client
    app.dependency_overrides.clear()


class TestPreview:
    """Excel 预览。"""

    def test_target_mode_preview(self, client_with_template):
        """目标字段模式预览。"""
        resp = client_with_template.get("/api/excel/preview?mode=target")
        assert resp.status_code == 200
        data = resp.json()
        assert data["sheet_name"] == "实际要录入的表格"
        assert data["mode"] == "target"
        assert data["base_write_row"] == 8
        assert data["completed_count"] == 2
        assert data["next_write_row"] == 10
        assert data["latest_write_row"] == 9

        # 列应该是 14 个目标字段
        assert len(data["columns"]) == 14
        col_fields = [c["field"] for c in data["columns"]]
        assert "中名" in col_fields
        assert "图像" in col_fields
        assert "鉴定人" in col_fields

        # 模板行(header_row+1=2 到 base_write_row-1=7)
        template_rows = [r for r in data["rows"] if r["status"] == "template"]
        assert len(template_rows) == 6  # 行2到行7

        # 已完成记录行
        record_rows = [r for r in data["rows"] if r["status"] == "completed"]
        assert len(record_rows) == 2
        # 第一条记录在 base_write_row=8
        assert record_rows[0]["excel_row"] == 8
        assert record_rows[0]["values"]["中名"] == "二点红蝽"
        assert record_rows[0]["values"]["图像"] == "PSZP-00842"
        assert record_rows[0]["values"]["鉴定人"] == "王五"
        # 第二条记录在 base_write_row+1=9
        assert record_rows[1]["excel_row"] == 9
        assert record_rows[1]["values"]["中名"] == "中华螽斯"

    def test_all_mode_preview(self, client_with_template):
        """全部列模式预览。"""
        resp = client_with_template.get("/api/excel/preview?mode=all")
        assert resp.status_code == 200
        data = resp.json()
        # 全部列应该比目标字段多
        assert len(data["columns"]) > 13

    def test_no_template_400(self):
        """没有模板时返回 400。"""
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        TestSession = sessionmaker(bind=engine)

        def override_get_db():
            db = TestSession()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = override_get_db
        client = TestClient(app)
        resp = client.get("/api/excel/preview")
        assert resp.status_code == 400
        assert "模板" in resp.json()["detail"]
        app.dependency_overrides.clear()

    def test_row_number_formula(self, client_with_template):
        """行号公式: base_write_row + zero_based_index。"""
        resp = client_with_template.get("/api/excel/preview?mode=target")
        data = resp.json()
        record_rows = [r for r in data["rows"] if r["status"] == "completed"]
        for idx, row in enumerate(record_rows):
            expected_row = data["base_write_row"] + idx
            assert row["excel_row"] == expected_row

    def test_record_edit_is_reflected_in_preview(self, client_with_template):
        """编辑记录后实时预览使用数据库中的最新值。"""
        preview = client_with_template.get("/api/excel/preview?mode=target").json()
        record_row = next(row for row in preview["rows"] if row["status"] == "completed")

        updated = client_with_template.patch(
            f"/api/records/{record_row['record_id']}",
            json={"fields": {"产地3": "深圳湾", "鉴定人": "赵六"}},
        )
        assert updated.status_code == 200
        assert updated.json()["fields"]["产地3"] == "深圳湾"
        assert updated.json()["fields"]["鉴定人"] == "赵六"

        refreshed = client_with_template.get("/api/excel/preview?mode=target").json()
        refreshed_row = next(
            row for row in refreshed["rows"]
            if row["record_id"] == record_row["record_id"]
        )
        assert refreshed_row["values"]["产地3"] == "深圳湾"
        assert refreshed_row["values"]["鉴定人"] == "赵六"

    def test_completed_record_rejects_invalid_inline_edits(self, client_with_template):
        """实时编辑沿用完成记录的必填、日期和字段白名单校验。"""
        preview = client_with_template.get("/api/excel/preview?mode=target").json()
        record_id = next(
            row["record_id"] for row in preview["rows"]
            if row["status"] == "completed"
        )

        empty_name = client_with_template.patch(
            f"/api/records/{record_id}",
            json={"fields": {"中名": ""}},
        )
        assert empty_name.status_code == 422
        assert "中名不能为空" in empty_name.json()["detail"]

        invalid_date = client_with_template.patch(
            f"/api/records/{record_id}",
            json={"fields": {"采集日期": "2026/08/04"}},
        )
        assert invalid_date.status_code == 422
        assert "YYYY-MM-DD" in invalid_date.json()["detail"]

        unknown_field = client_with_template.patch(
            f"/api/records/{record_id}",
            json={"fields": {"未知字段": "值"}},
        )
        assert unknown_field.status_code == 422
        assert "不支持修改字段" in unknown_field.json()["detail"]

    def test_completed_record_rejects_duplicate_image_number(self, client_with_template):
        """实时编辑不能绕过所有者范围内的图像编号唯一性。"""
        preview = client_with_template.get("/api/excel/preview?mode=target").json()
        record_rows = [row for row in preview["rows"] if row["status"] == "completed"]

        response = client_with_template.patch(
            f"/api/records/{record_rows[1]['record_id']}",
            json={"fields": {"图像": record_rows[0]["values"]["图像"]}},
        )
        assert response.status_code == 409
        assert "图像编号已存在" in response.json()["detail"]

    def test_preview_returns_all_records_beyond_legacy_limit(
        self, client_with_template
    ):
        """limit 参数不截断记录，行顺序和写入元数据覆盖完整结果集。"""
        TestSession = client_with_template.test_session_factory
        with TestSession() as db:
            db.add_all(
                [
                    SpecimenRecord(
                        owner_id=1,
                        zhongming=f"昆虫{index}",
                        tuxiang=f"BULK-{index:03d}",
                        status=STATUS_COMPLETED,
                    )
                    for index in range(105)
                ]
            )
            db.commit()

        response = client_with_template.get(
            "/api/excel/preview?mode=target&limit=100"
        )
        assert response.status_code == 200
        data = response.json()
        record_rows = [
            row for row in data["rows"] if row["status"] == "completed"
        ]
        assert len(record_rows) == 107
        assert data["completed_count"] == 107
        assert [row["record_id"] for row in record_rows] == sorted(
            row["record_id"] for row in record_rows
        )
        assert record_rows[-1]["excel_row"] == 114
        assert data["latest_write_row"] == 114
        assert data["next_write_row"] == 115
