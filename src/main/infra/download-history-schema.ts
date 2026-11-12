export const DOWNLOAD_HISTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS download_history (
    event_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('vod', 'clip', 'live')),
    source_count INTEGER NOT NULL CHECK(source_count > 0),
    source_ids_json TEXT NOT NULL,
    output_files INTEGER NOT NULL CHECK(output_files >= 0),
    total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
    completed_at TEXT,
    recovered INTEGER NOT NULL DEFAULT 0 CHECK(recovered IN (0, 1))
);
CREATE TABLE IF NOT EXISTS download_history_details (
    event_key TEXT PRIMARY KEY REFERENCES download_history(event_key) ON DELETE CASCADE,
    title TEXT,
    channel TEXT,
    source_url TEXT,
    paths_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_download_history_channel ON download_history_details(channel);
CREATE INDEX IF NOT EXISTS idx_download_history_completed ON download_history(completed_at);
INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('download_history_started_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;
