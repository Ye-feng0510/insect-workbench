"""数据库会话与初始化。SQLite,单文件。"""
import logging
from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import DB_PATH, ensure_dirs, settings


ensure_dirs()

logger = logging.getLogger(__name__)

# SQLite 需要开启外键约束检查
engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
    echo=False,
)


@event.listens_for(engine, "connect")
def _tune_sqlite_pragmas(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute(f"PRAGMA busy_timeout={settings.sqlite_busy_timeout_ms}")
    # WAL 模式:读写不再互相阻塞,显著降低 "database is locked" 概率。
    # 仅在请求了 wal 时设置;设置失败(如只读文件系统)时保持默认并记录。
    if settings.sqlite_journal_mode.lower() == "wal":
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
        except Exception:  # pragma: no cover - 平台差异防御
            logger.warning("SQLite WAL 模式启用失败,回退默认 journal 模式", exc_info=True)
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
    """Run explicit, versioned migrations and bootstrap the first admin."""
    from app.migrations import migrate

    migrate(engine)
