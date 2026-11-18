DROP TABLE IF EXISTS devices;

CREATE TABLE devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT UNIQUE NOT NULL,    -- 使用 MAC 地址作为设备的唯一标识
    hostname TEXT,
    username TEXT,
    os TEXT,
    os_release TEXT,
    architecture TEXT,
    python_version TEXT,
    agent_version TEXT,
    cert_fingerprint TEXT NOT NULL,      -- 核心：保存 SSL 证书指纹用于后续验证
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);