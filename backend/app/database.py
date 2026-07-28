"""数据库会话与初始化。SQLite,单文件。"""
from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import DB_PATH, ensure_dirs


ensure_dirs()

# SQLite 需要开启外键约束检查
engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
    echo=False,
)

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
        conn.commit()
