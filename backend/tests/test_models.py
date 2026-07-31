"""数据库层测试:表结构、单例配置、部分唯一索引约束。

使用内存 SQLite 做隔离测试,不影响真实数据。
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.database import Base
from app import models
from app.models import (
    AppSettings,
    ExcelTemplate,
    MaterialBatch,
    MaterialItem,
    SpecimenRecord,
    TaxonomyCache,
    STATUS_COMPLETED,
    STATUS_AWAITING_CONFIRMATION,
    STATUS_DISCARDED,
)


@pytest.fixture
def db_session():
    """内存 SQLite 会话,带部分唯一索引。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    # 手动创建部分唯一索引(内存库 init_db 不会触发)
    with engine.connect() as conn:
        from sqlalchemy import text
        conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_specimen_tuxiang_completed "
            "ON specimen_records (tuxiang) WHERE status = 'completed'"
        ))
        conn.commit()
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


class TestTableCreation:
    """所有 4 张表都能创建。"""

    def test_all_tables_exist(self, db_session):
        from sqlalchemy import inspect
        insp = inspect(db_session.bind)
        tables = insp.get_table_names()
        assert "app_settings" in tables
        assert "excel_templates" in tables
        assert "specimen_records" in tables
        assert "taxonomy_cache" in tables
        assert "material_batches" in tables
        assert "material_items" in tables

    def test_specimen_records_has_13_fields(self, db_session):
        """记录表包含全部 13 个目标字段列。"""
        record = SpecimenRecord(
            zhongming="二点红蝽",
            phylum="Arthropoda",
            gang="昆虫纲",
            klass="Insecta",
            order_field="Hemiptera",
            zhongwen_ke="红蝽科",
            ke="Pyrrhocoridae",
            shu="Dysdercus",
            zhong="cingulatus",
            chandi3="龙岗园山景区",
            tuxiang="PSZP-00842",
            caijiren="",
            caiji_riqi="2009-10-24",
            status=STATUS_COMPLETED,
        )
        db_session.add(record)
        db_session.commit()
        loaded = db_session.query(SpecimenRecord).first()
        assert loaded.zhongming == "二点红蝽"
        assert loaded.tuxiang == "PSZP-00842"
        assert loaded.caiji_riqi == "2009-10-24"

    def test_material_batch_and_items(self, db_session):
        batch = MaterialBatch(
            original_filename="素材.zip",
            stored_zip_path="/tmp/materials.zip",
            extract_dir="/tmp/materials",
            total_count=2,
            is_active=True,
        )
        db_session.add(batch)
        db_session.flush()
        db_session.add_all([
            MaterialItem(
                batch_id=batch.id,
                sequence=1,
                original_filename="a.jpg",
                archive_path="a.jpg",
                stored_path="/tmp/a.jpg",
            ),
            MaterialItem(
                batch_id=batch.id,
                sequence=2,
                original_filename="b.jpg",
                archive_path="nested/b.jpg",
                stored_path="/tmp/b.jpg",
            ),
        ])
        db_session.commit()
        assert db_session.query(MaterialItem).count() == 2


class TestPartialUniqueIndex:
    """部分唯一索引:completed 状态的图像编号唯一,草稿阶段允许重复。"""

    def test_completed_tuxiang_must_be_unique(self, db_session):
        """两个 completed 记录不能用相同图像编号。"""
        from sqlalchemy.exc import IntegrityError

        r1 = SpecimenRecord(tuxiang="PSZP-001", status=STATUS_COMPLETED)
        r2 = SpecimenRecord(tuxiang="PSZP-001", status=STATUS_COMPLETED)
        db_session.add_all([r1, r2])
        with pytest.raises(IntegrityError):
            db_session.commit()
        db_session.rollback()

    def test_draft_tuxiang_can_be_duplicate(self, db_session):
        """两个草稿(非 completed)可以用相同图像编号或为空。"""
        r1 = SpecimenRecord(tuxiang="", status=STATUS_AWAITING_CONFIRMATION)
        r2 = SpecimenRecord(tuxiang="", status=STATUS_AWAITING_CONFIRMATION)
        r3 = SpecimenRecord(tuxiang="PSZP-002", status=STATUS_AWAITING_CONFIRMATION)
        r4 = SpecimenRecord(tuxiang="PSZP-002", status=STATUS_AWAITING_CONFIRMATION)
        db_session.add_all([r1, r2, r3, r4])
        db_session.commit()  # 不应报错
        assert db_session.query(SpecimenRecord).count() == 4

    def test_completed_and_draft_can_share_tuxiang(self, db_session):
        """completed 记录和草稿可以用相同图像编号。"""
        r1 = SpecimenRecord(tuxiang="PSZP-003", status=STATUS_COMPLETED)
        r2 = SpecimenRecord(tuxiang="PSZP-003", status=STATUS_AWAITING_CONFIRMATION)
        db_session.add_all([r1, r2])
        db_session.commit()
        assert db_session.query(SpecimenRecord).count() == 2


class TestSettingsSingleton:
    """AppSettings 单例行为。"""

    def test_default_settings(self, db_session):
        s = AppSettings(id=1)
        db_session.add(s)
        db_session.commit()
        loaded = db_session.get(AppSettings, 1)
        assert loaded.base_url == ""
        assert loaded.model_name == ""


class TestTaxonomyCache:
    """分类缓存。"""

    def test_zhongming_unique(self, db_session):
        """中名在缓存中唯一。"""
        from sqlalchemy.exc import IntegrityError

        c1 = TaxonomyCache(owner_id=1, zhongming="二点红蝽", phylum="Arthropoda")
        c2 = TaxonomyCache(owner_id=1, zhongming="二点红蝽", phylum="Arthropoda")
        db_session.add_all([c1, c2])
        with pytest.raises(IntegrityError):
            db_session.commit()
        db_session.rollback()


class TestDiscardedStatus:
    """discarded 状态:用户放弃的草稿。"""

    def test_discarded_record_not_in_active(self, db_session):
        r1 = SpecimenRecord(status=STATUS_DISCARDED)
        r2 = SpecimenRecord(status=STATUS_AWAITING_CONFIRMATION)
        db_session.add_all([r1, r2])
        db_session.commit()
        active = (
            db_session.query(SpecimenRecord)
            .filter(SpecimenRecord.status != STATUS_DISCARDED)
            .filter(SpecimenRecord.status != STATUS_COMPLETED)
            .all()
        )
        assert len(active) == 1
        assert active[0].id == r2.id
