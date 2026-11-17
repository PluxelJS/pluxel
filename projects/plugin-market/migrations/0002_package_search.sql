-- D1 supports native FTS5. External content keeps package facts in one owner.
CREATE VIRTUAL TABLE package_search USING fts5(name, description, tags, content='packages', content_rowid='rowid');
--> statement-breakpoint
CREATE TRIGGER package_search_insert AFTER INSERT ON packages BEGIN
  INSERT INTO package_search(rowid, name, description, tags) VALUES (new.rowid, new.name, new.description, new.tags);
END;
--> statement-breakpoint
CREATE TRIGGER package_search_delete AFTER DELETE ON packages BEGIN
  INSERT INTO package_search(package_search, rowid, name, description, tags) VALUES ('delete', old.rowid, old.name, old.description, old.tags);
END;
--> statement-breakpoint
CREATE TRIGGER package_search_update AFTER UPDATE OF name, description, tags ON packages BEGIN
  INSERT INTO package_search(package_search, rowid, name, description, tags) VALUES ('delete', old.rowid, old.name, old.description, old.tags);
  INSERT INTO package_search(rowid, name, description, tags) VALUES (new.rowid, new.name, new.description, new.tags);
END;
--> statement-breakpoint
INSERT INTO package_search(package_search) VALUES ('rebuild');
