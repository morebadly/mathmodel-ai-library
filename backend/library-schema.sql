PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS library_resources (
 id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, category TEXT NOT NULL,
 kind TEXT NOT NULL, availability TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
 body_html TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '',
 contest TEXT NOT NULL DEFAULT '', year INTEGER, problem TEXT NOT NULL DEFAULT '',
 method TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]',
 source_label TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS library_category ON library_resources(category,kind,year);
CREATE TABLE IF NOT EXISTS library_assets (
 id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, path TEXT NOT NULL, size INTEGER NOT NULL,
 mime TEXT NOT NULL, original_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS library_resource_assets (
 resource_id TEXT NOT NULL REFERENCES library_resources(id), asset_id TEXT NOT NULL REFERENCES library_assets(id),
 label TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'attachment',
 PRIMARY KEY(resource_id,asset_id)
);
CREATE TABLE IF NOT EXISTS library_problems (
 resource_id TEXT NOT NULL REFERENCES library_resources(id), problem_key TEXT NOT NULL,
 PRIMARY KEY(resource_id,problem_key)
);
CREATE INDEX IF NOT EXISTS library_problem_key ON library_problems(problem_key);
CREATE TABLE IF NOT EXISTS library_methods (
 resource_id TEXT NOT NULL REFERENCES library_resources(id), method_key TEXT NOT NULL,
 PRIMARY KEY(resource_id,method_key)
);
CREATE INDEX IF NOT EXISTS library_method_key ON library_methods(method_key);
CREATE TABLE IF NOT EXISTS library_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS library_ingestion (
 resource_id TEXT PRIMARY KEY REFERENCES library_resources(id), status TEXT NOT NULL DEFAULT 'queued',
 format TEXT NOT NULL DEFAULT '', char_count INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '',
 category_mode TEXT NOT NULL DEFAULT 'auto', confidence TEXT NOT NULL DEFAULT 'low',
 needs_review INTEGER NOT NULL DEFAULT 1, reason TEXT NOT NULL DEFAULT '',
 attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS library_ingestion_status ON library_ingestion(status,updated_at);
