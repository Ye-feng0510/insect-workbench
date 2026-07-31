"""数据库会话与初始化。SQLite,单文件。"""
from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import DB_PATH, ensure_dirs


ensure_dirs()

# SQLite 需要开启外键约束检查
engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
    echo=False,
)


@event.listens_for(engine, "connect")
def _enable_sqlite_foreign_keys(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""


def get_db() -> Generator[Session, None, None]:
    """FastAPI 依赖:每个请求一个会话。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """创建所有表和部分唯一索引(导入模型以注册到 Base.metadata)。"""
    from app import models  # noqa: F401
    from sqlalchemy import text

    Base.metadata.create_all(bind=engine)

    # 部分唯一索引:completed 状态的图像编号唯一。
    # SQLAlchemy 的 Index(sqlite_where=) 在 create_all 时不一定自动创建,
    # 这里显式执行确保存在(IF NOT EXISTS 保证幂等)。
    with engine.connect() as conn:
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_specimen_tuxiang_completed "
                "ON specimen_records (tuxiang) WHERE status = 'completed'"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_material_queue "
                "ON material_items (batch_id, status, sequence)"
            )
        )
        # SQLite 不支持 ALTER TABLE ADD COLUMN IF NOT EXISTS,
        # 但 create_all 会在新数据库中创建完整表。对已存在旧数据库,
        # 用 try-except 幂等添加新列。
        for col_def in [
            ("material_prefetch_results", "attempt_count", "INTEGER DEFAULT 0"),
            ("material_prefetch_results", "next_retry_at", "DATETIME"),
        ]:
            try:
                conn.execute(
                    text(f"ALTER TABLE {col_def[0]} ADD COLUMN {col_def[1]} {col_def[2]}")
                )
            except Exception:
                pass  # 列已存在
        conn.commit()
